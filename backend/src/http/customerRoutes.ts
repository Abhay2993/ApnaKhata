/**
 * ApnaKhata — Customer khata & voice routes
 * -----------------------------------------
 * The consumer-udhaar ledger and voice entry. `POST /v1/voice/ledger` takes a
 * transcript ("Ramesh ko paanch sau udhaar") — the transcription itself happens
 * on-device (Web Speech API) or via an STT provider — and posts the parsed
 * entry, returning what it understood so the client can confirm.
 */

import { Router } from 'express';

import { CustomerLedgerService } from '../services/CustomerLedgerService';
import { requireUser, wrap } from './middleware';

export function customerRoutes(customers: CustomerLedgerService): Router {
  const r = Router();

  // Voice / natural-language entry.
  r.post(
    '/voice/ledger',
    requireUser,
    wrap(async (req, res) => {
      const { transcript, source } = req.body ?? {};
      if (!transcript || typeof transcript !== 'string') throw new Error('transcript is required');
      const result = await customers.recordFromVoice(req.userId as string, transcript, source === 'WHATSAPP' ? 'WHATSAPP' : 'VOICE');
      res.status(result.posted ? 201 : 200).json(result);
    }),
  );

  // Customer directory with balances.
  r.get(
    '/customers',
    requireUser,
    wrap(async (req, res) => {
      res.json(await customers.listCustomers(req.userId as string));
    }),
  );

  r.post(
    '/customers',
    requireUser,
    wrap(async (req, res) => {
      const { name, phone } = req.body ?? {};
      if (!name) throw new Error('name is required');
      const customer = await customers.ensureCustomer(req.userId as string, name, phone);
      res.status(201).json(customer);
    }),
  );

  r.get(
    '/customers/:id',
    requireUser,
    wrap(async (req, res) => {
      const ownerId = req.userId as string;
      const [balance, entries] = await Promise.all([
        customers.getBalance(ownerId, req.params.id),
        customers.getEntries(ownerId, req.params.id),
      ]);
      res.json({ ...balance, entries });
    }),
  );

  // Manual ledger entry against a customer.
  r.post(
    '/customers/:id/entries',
    requireUser,
    wrap(async (req, res) => {
      const { entryType, amount, note } = req.body ?? {};
      if (entryType !== 'CREDIT' && entryType !== 'PAYMENT') throw new Error('entryType must be CREDIT or PAYMENT');
      const result = await customers.addEntry(req.userId as string, {
        customerId: req.params.id,
        entryType,
        amount: Number(amount),
        note,
        source: 'MANUAL',
      });
      res.status(201).json(result);
    }),
  );

  return r;
}
