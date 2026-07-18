/**
 * ApnaKhata — E-Way Bill gateway
 * ------------------------------
 * The e-way bill portal (NIC EWB) mints a 12-digit EWB number and a validity
 * window (1 day per 200 km, minimum 1 day). A production adapter talks to the
 * GSP/NIC sandbox over authenticated REST; SandboxEwbGateway is a deterministic
 * stand-in that mirrors that derivation and validity rule.
 */

import { createHash } from 'crypto';

export interface EwbPayload {
  docNo: string;
  docDate: string; // DD/MM/YYYY
  fromGstin: string;
  toGstin: string | null;
  totalValue: number;
  transMode: string; // ROAD | RAIL | AIR | SHIP
  vehicleNo?: string;
  distanceKm: number;
}

export interface EwbResult {
  ewbNo: string; // 12 digits
  validUpto: string; // ISO
  raw: Record<string, unknown>;
}

export interface EwbGateway {
  generate(payload: EwbPayload): Promise<EwbResult>;
  cancel(ewbNo: string, reason: string): Promise<{ cancelDate: string }>;
}

/** EWB validity: 1 day per 200 km (rounded up), minimum 1 day. */
export function ewbValidityDays(distanceKm: number): number {
  return Math.max(1, Math.ceil(distanceKm / 200));
}

export class SandboxEwbGateway implements EwbGateway {
  async generate(payload: EwbPayload): Promise<EwbResult> {
    if (!/^[0-9]{2}[A-Z0-9]{13}$/.test(payload.fromGstin)) {
      throw new Error('EWB rejected: invalid supplier GSTIN');
    }
    if (payload.distanceKm <= 0) throw new Error('EWB rejected: distance must be positive');

    // 12-digit number derived from the document identity (portal-style).
    const digest = createHash('sha256')
      .update(`${payload.fromGstin}|${payload.docNo}|${payload.docDate}`)
      .digest('hex');
    const ewbNo = (BigInt(`0x${digest.slice(0, 15)}`) % 1000000000000n).toString().padStart(12, '0');

    const validUpto = new Date(Date.now() + ewbValidityDays(payload.distanceKm) * 86_400_000).toISOString();
    return { ewbNo, validUpto, raw: { status: 'ACT', sandbox: true, distanceKm: payload.distanceKm } };
  }

  async cancel(ewbNo: string, reason: string): Promise<{ cancelDate: string }> {
    if (!/^[0-9]{12}$/.test(ewbNo)) throw new Error('EWB rejected: malformed e-way bill number');
    if (!reason.trim()) throw new Error('EWB rejected: cancellation reason required');
    return { cancelDate: new Date().toISOString() };
  }
}
