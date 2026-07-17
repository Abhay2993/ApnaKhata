/**
 * ApnaKhata — IRP (Invoice Registration Portal) gateway
 * -----------------------------------------------------
 * E-invoicing gateway abstraction. A production adapter talks to a GSP /
 * NIC-IRP sandbox over authenticated REST; the SandboxIrpGateway below is a
 * deterministic stand-in that mirrors the IRP's actual IRN derivation —
 * SHA-256 over (supplier GSTIN, financial year, document type, document
 * number) — so IRNs generated here match what the real portal would mint for
 * the same invoice identity.
 */

import { createHash } from 'crypto';

export interface IrpInvoicePayload {
  version: '1.1';
  docDtls: { typ: 'INV'; no: string; dt: string }; // dt = DD/MM/YYYY per IRP
  sellerDtls: { gstin: string; lglNm: string; stcd: string };
  buyerDtls: { gstin: string | null; lglNm: string; pos: string };
  itemList: {
    slNo: number;
    hsnCd: string;
    qty: number;
    unitPrice: number;
    assAmt: number; // assessable (taxable) value
    gstRt: number;
    cgstAmt: number;
    sgstAmt: number;
    igstAmt: number;
    totItemVal: number;
  }[];
  valDtls: { assVal: number; cgstVal: number; sgstVal: number; igstVal: number; totInvVal: number };
}

export interface IrpResult {
  irn: string; // 64-hex SHA-256
  ackNo: string;
  ackDate: string; // ISO
  signedQr: string; // IRP-signed QR payload (base64)
  raw: Record<string, unknown>;
}

export interface IrpGateway {
  register(payload: IrpInvoicePayload, financialYear: string): Promise<IrpResult>;
  cancel(irn: string, reason: string): Promise<{ cancelDate: string }>;
}

/** Indian financial year (Apr–Mar) for a date, e.g. '2026-27'. */
export function financialYearOf(date: Date): string {
  const y = date.getUTCFullYear();
  const startYear = date.getUTCMonth() >= 3 ? y : y - 1; // month 3 = April
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export class SandboxIrpGateway implements IrpGateway {
  async register(payload: IrpInvoicePayload, financialYear: string): Promise<IrpResult> {
    if (!/^[0-9]{2}[A-Z0-9]{13}$/.test(payload.sellerDtls.gstin)) {
      throw new Error('IRP rejected: invalid supplier GSTIN format');
    }
    if (payload.itemList.length === 0) {
      throw new Error('IRP rejected: empty item list');
    }

    // The IRP's published IRN derivation: SHA-256 over supplier GSTIN + FY +
    // doc type + doc number.
    const irn = createHash('sha256')
      .update(`${payload.sellerDtls.gstin}|${financialYear}|${payload.docDtls.typ}|${payload.docDtls.no}`)
      .digest('hex');

    const ackNo = String(BigInt(`0x${irn.slice(0, 12)}`) % 1000000000000000n).padStart(15, '0');
    const ackDate = new Date().toISOString();
    const signedQr = Buffer.from(
      JSON.stringify({
        SellerGstin: payload.sellerDtls.gstin,
        BuyerGstin: payload.buyerDtls.gstin,
        DocNo: payload.docDtls.no,
        DocTyp: payload.docDtls.typ,
        DocDt: payload.docDtls.dt,
        TotInvVal: payload.valDtls.totInvVal,
        Irn: irn,
        IrnDt: ackDate,
      }),
    ).toString('base64');

    return { irn, ackNo, ackDate, signedQr, raw: { status: 'ACT', sandbox: true } };
  }

  async cancel(irn: string, reason: string): Promise<{ cancelDate: string }> {
    if (!/^[0-9a-f]{64}$/.test(irn)) throw new Error('IRP rejected: malformed IRN');
    if (!reason.trim()) throw new Error('IRP rejected: cancellation reason required');
    return { cancelDate: new Date().toISOString() };
  }
}
