/**
 * ApnaKhata — Credit Passport Service
 * -----------------------------------
 * Issues the "ApnaKhata Credit Risk Passport": a canonical JSON report over a
 * user's current credit metrics + 12-month ledger aggregates, signed with the
 * platform's Ed25519 key, hash-chained per user, and rendered to a signed PDF.
 *
 * Verifiability contract (what a bank checks):
 *   1. SHA-256 of the canonical JSON == stored report_sha256, and
 *   2. Ed25519 signature over that JSON verifies against the published public
 *      key. Any tampering with the JSON breaks the signature; any tampering
 *      with the PDF (regenerated deterministically from the JSON) breaks the
 *      hash. Historical passports stay provable via the per-user hash chain.
 *
 * Keys: pass a PKCS#8 Ed25519 private key PEM (env APNAKHATA_PASSPORT_KEY in
 * production). If none is given, an ephemeral key is generated with a warning
 * — fine for local dev, but such passports won't verify across restarts.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  sign as edSign,
  verify as edVerify,
} from 'crypto';
import { Pool } from 'pg';

import { renderPdf, PdfLine } from '../pdf/SimplePdf';
import { RiskTier } from './creditScoring';

const GENESIS_HASH = '0'.repeat(64);

export interface PassportReport {
  version: '1.0';
  passportId: string;
  subject: { userId: string; businessName: string; gstin: string | null };
  score: number;
  tier: RiskTier;
  pillars: {
    repaymentVelocity: number;
    transactionConsistency: number;
    supplierRetention: number;
    inventoryTurn: number;
  };
  ledgerSummary: {
    averageDelayDays: number;
    daysInventoryOutstanding: number | null;
    dataCoverageMonths: number;
    totalInvoices12m: number;
    totalTradeValue12m: number;
    outstandingPayable: number;
  };
  issuedAt: string; // ISO
  issuer: 'ApnaKhata';
}

export interface IssuedPassport {
  passportId: string;
  score: number;
  tier: RiskTier;
  reportSha256: string;
  signature: string; // base64 Ed25519
  signingKeyId: string;
  publicKeyPem: string;
  report: PassportReport;
}

export interface VerificationResult {
  valid: boolean;
  reason?: string;
  signingKeyId: string;
  publicKeyPem: string;
  report: PassportReport;
}

/** Deterministic JSON: object keys sorted recursively so hashing is stable. */
function canonicalize(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = walk((v as Record<string, unknown>)[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export class CreditPassportService {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly publicKeyPem: string;
  readonly signingKeyId: string;

  constructor(
    private readonly db: Pool,
    privateKeyPem = process.env.APNAKHATA_PASSPORT_KEY,
  ) {
    if (privateKeyPem) {
      this.privateKey = createPrivateKey(privateKeyPem);
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        'CreditPassportService: no APNAKHATA_PASSPORT_KEY provided; using an ephemeral ' +
          'Ed25519 key. Passports issued now will not verify after a restart.',
      );
      this.privateKey = generateKeyPairSync('ed25519').privateKey;
    }
    this.publicKey = createPublicKey(this.privateKey);
    this.publicKeyPem = this.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    // Key id = first 16 hex of SHA-256 over the DER public key.
    const der = this.publicKey.export({ type: 'spki', format: 'der' });
    this.signingKeyId = createHash('sha256').update(der).digest('hex').slice(0, 16);
  }

  /** The platform public key banks use for offline verification. */
  getPublicKey(): { signingKeyId: string; publicKeyPem: string } {
    return { signingKeyId: this.signingKeyId, publicKeyPem: this.publicKeyPem };
  }

  /**
   * Issue a fresh passport for a user from their current stored metrics.
   * Throws if the user has never been scored (run CreditScoreEvaluator first).
   */
  async issue(userId: string): Promise<IssuedPassport> {
    const { rows } = await this.db.query<{
      business_name: string;
      gstin: string | null;
      score: number;
      tier: RiskTier;
      repayment_velocity_score: string;
      consistency_score: string;
      retention_score: string;
      inventory_turn_score: string;
      average_delay_days: string;
      days_inventory_outstanding: string | null;
      data_coverage_months: number;
      total_invoices: string;
      total_value: string;
      outstanding: string;
    }>(
      `
      SELECT u.business_name, u.gstin,
             m.calculated_credit_score AS score, m.tier,
             m.repayment_velocity_score, m.consistency_score,
             m.retention_score, m.inventory_turn_score,
             m.average_delay_days, m.days_inventory_outstanding, m.data_coverage_months,
             COALESCE(agg.total_invoices, 0)  AS total_invoices,
             COALESCE(agg.total_value, 0)     AS total_value,
             COALESCE(pay.outstanding, 0)     AS outstanding
      FROM credit_score_metrics m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN (
        SELECT receiver_id, COUNT(*) AS total_invoices, SUM(amount) AS total_value
        FROM transactions_ledger
        WHERE kind = 'B2B_INVOICE' AND created_at >= now() - interval '12 months'
        GROUP BY receiver_id
      ) agg ON agg.receiver_id = m.user_id
      LEFT JOIN (
        SELECT receiver_id, SUM(balance_remaining) AS outstanding
        FROM transactions_ledger
        WHERE kind = 'B2B_INVOICE' AND payment_status <> 'PAID'
        GROUP BY receiver_id
      ) pay ON pay.receiver_id = m.user_id
      WHERE m.user_id = $1
      `,
      [userId],
    );
    const m = rows[0];
    if (!m) throw new Error('no credit score on record for user; evaluate the score first');

    const passportId = createHash('sha256')
      .update(`${userId}:${Date.now()}:${Math.random()}`)
      .digest('hex')
      .slice(0, 32);

    const report: PassportReport = {
      version: '1.0',
      passportId,
      subject: { userId, businessName: m.business_name, gstin: m.gstin },
      score: m.score,
      tier: m.tier,
      pillars: {
        repaymentVelocity: Number(m.repayment_velocity_score),
        transactionConsistency: Number(m.consistency_score),
        supplierRetention: Number(m.retention_score),
        inventoryTurn: Number(m.inventory_turn_score),
      },
      ledgerSummary: {
        averageDelayDays: Number(m.average_delay_days),
        daysInventoryOutstanding:
          m.days_inventory_outstanding === null ? null : Number(m.days_inventory_outstanding),
        dataCoverageMonths: m.data_coverage_months,
        totalInvoices12m: Number(m.total_invoices),
        totalTradeValue12m: Number(m.total_value),
        outstandingPayable: Number(m.outstanding),
      },
      issuedAt: new Date().toISOString(),
      issuer: 'ApnaKhata',
    };

    const canonical = canonicalize(report);
    const reportSha256 = createHash('sha256').update(canonical).digest('hex');
    const signature = edSign(null, Buffer.from(canonical), this.privateKey).toString('base64');

    const { rows: prevRows } = await this.db.query<{ report_sha256: string }>(
      `SELECT report_sha256 FROM credit_passports WHERE user_id = $1 ORDER BY issued_at DESC LIMIT 1`,
      [userId],
    );
    const prevHash = prevRows[0]?.report_sha256 ?? GENESIS_HASH;

    await this.db.query(
      `
      INSERT INTO credit_passports (
        id, user_id, score, tier, report_json, report_sha256,
        signature, signing_key_id, prev_hash, pdf_url, issued_at
      ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        userId,
        m.score,
        m.tier,
        JSON.stringify(report),
        reportSha256,
        signature,
        this.signingKeyId,
        prevHash,
        `/v1/credit/passports/${passportId}/pdf`,
        report.issuedAt,
      ],
    );

    return {
      passportId,
      score: m.score,
      tier: m.tier,
      reportSha256,
      signature,
      signingKeyId: this.signingKeyId,
      publicKeyPem: this.publicKeyPem,
      report,
    };
  }

  /** Re-verify a stored passport by its report's passportId. */
  async verify(passportId: string): Promise<VerificationResult> {
    const stored = await this.loadByPassportId(passportId);
    const canonical = canonicalize(stored.report);
    const recomputed = createHash('sha256').update(canonical).digest('hex');

    if (recomputed !== stored.reportSha256) {
      return {
        valid: false,
        reason: 'report hash mismatch (JSON altered)',
        signingKeyId: stored.signingKeyId,
        publicKeyPem: this.publicKeyPem,
        report: stored.report,
      };
    }

    const sigValid =
      stored.signingKeyId === this.signingKeyId &&
      edVerify(null, Buffer.from(canonical), this.publicKey, Buffer.from(stored.signature, 'base64'));

    return {
      valid: sigValid,
      reason: sigValid ? undefined : 'signature does not verify against the current signing key',
      signingKeyId: stored.signingKeyId,
      publicKeyPem: this.publicKeyPem,
      report: stored.report,
    };
  }

  /** Deterministically render a stored passport to a signed PDF. */
  async renderPdf(passportId: string): Promise<Buffer> {
    const stored = await this.loadByPassportId(passportId);
    const r = stored.report;
    const gold: [number, number, number] = [0.773, 0.627, 0.349];
    const slate: [number, number, number] = [0.42, 0.42, 0.42];
    // Standard Helvetica uses WinAnsi encoding, which has no rupee glyph (U+20B9);
    // prefix "INR" instead of ₹ so the PDF renders cleanly everywhere.
    const money = (n: number) =>
      `INR ${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n)}`;

    const lines: PdfLine[] = [
      { text: 'ApnaKhata Credit Risk Passport', size: 20, bold: true, color: gold },
      { text: `${r.subject.businessName}`, size: 13, gap: 6 },
      { text: `GSTIN: ${r.subject.gstin ?? 'Unregistered'}`, size: 10, color: slate },
      { text: `Credit Score: ${r.score} / 900     Risk Tier: ${r.tier}`, size: 15, bold: true, gap: 14 },
      { text: 'Pillar breakdown (0-100)', size: 12, bold: true, gap: 12 },
      { text: `Repayment speed (40%): ${r.pillars.repaymentVelocity}`, size: 11, gap: 2 },
      { text: `Transaction consistency (30%): ${r.pillars.transactionConsistency}`, size: 11 },
      { text: `Supplier retention & disputes (20%): ${r.pillars.supplierRetention}`, size: 11 },
      { text: `Inventory turn (10%): ${r.pillars.inventoryTurn}`, size: 11 },
      { text: 'Ledger summary (trailing 12 months)', size: 12, bold: true, gap: 14 },
      { text: `Avg. days to clear vs. due: ${r.ledgerSummary.averageDelayDays}`, size: 11, gap: 2 },
      {
        text: `Days inventory outstanding: ${
          r.ledgerSummary.daysInventoryOutstanding ?? 'n/a'
        }`,
        size: 11,
      },
      { text: `Trade invoices: ${r.ledgerSummary.totalInvoices12m}`, size: 11 },
      { text: `Trade value: ${money(r.ledgerSummary.totalTradeValue12m)}`, size: 11 },
      { text: `Outstanding payable: ${money(r.ledgerSummary.outstandingPayable)}`, size: 11 },
      { text: `Data coverage: ${r.ledgerSummary.dataCoverageMonths} month(s)`, size: 11 },
      { text: 'Cryptographic attestation', size: 12, bold: true, gap: 16 },
      { text: `Passport ID: ${r.passportId}`, size: 9, color: slate, gap: 2 },
      { text: `Issued: ${r.issuedAt}`, size: 9, color: slate },
      { text: `Signing key: ${stored.signingKeyId} (Ed25519)`, size: 9, color: slate },
      { text: `SHA-256: ${stored.reportSha256}`, size: 8, color: slate },
      { text: `Signature: ${stored.signature.slice(0, 64)}`, size: 8, color: slate, gap: 2 },
      { text: `           ${stored.signature.slice(64)}`, size: 8, color: slate },
      {
        text: 'Verify at /v1/credit/passports/{id}/verify or offline against the published public key.',
        size: 8,
        color: slate,
        gap: 10,
      },
    ];

    return renderPdf(lines);
  }

  private async loadByPassportId(passportId: string): Promise<{
    report: PassportReport;
    reportSha256: string;
    signature: string;
    signingKeyId: string;
  }> {
    const { rows } = await this.db.query<{
      report_json: PassportReport;
      report_sha256: string;
      signature: string;
      signing_key_id: string;
    }>(`SELECT report_json, report_sha256, signature, signing_key_id FROM credit_passports WHERE report_json->>'passportId' = $1`, [
      passportId,
    ]);
    if (!rows[0]) throw new Error('passport not found');
    return {
      report: rows[0].report_json,
      reportSha256: rows[0].report_sha256,
      signature: rows[0].signature,
      signingKeyId: rows[0].signing_key_id,
    };
  }
}
