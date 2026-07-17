/**
 * ApnaKhata — Payments & Ledger routes
 * ------------------------------------
 * UPI collections + UTR webhook, payment reminders, EMI plans, interest
 * accrual, and disputes — thin wrappers over the services from
 * migration 001.
 */

import { Router } from 'express';

import { DisputeService } from '../services/DisputeService';
import { InterestAccrualService } from '../services/InterestAccrualService';
import { PaymentPlanService } from '../services/PaymentPlanService';
import { PaymentReminderService } from '../services/PaymentReminderService';
import { UpiCollectionService } from '../services/UpiCollectionService';
import { requireUser, wrap } from './middleware';

export interface LedgerServices {
  upi: UpiCollectionService;
  reminders: PaymentReminderService;
  plans: PaymentPlanService;
  interest: InterestAccrualService;
  disputes: DisputeService;
}

export function ledgerRoutes(s: LedgerServices): Router {
  const r = Router();

  // --- UPI collections -----------------------------------------------------
  r.post(
    '/upi/collections',
    requireUser,
    wrap(async (req, res) => {
      const { payeeId, amount, payeeVpa, payeeName, invoiceId, note, expiresInMinutes } = req.body;
      const request = await s.upi.createCollectionRequest({
        payerId: req.userId as string,
        payeeId,
        amount: Number(amount),
        payeeVpa,
        payeeName,
        invoiceId,
        note,
        expiresInMinutes,
      });
      res.status(201).json(request);
    }),
  );

  // PSP-facing: authenticated by the service API key alone; in production add
  // the provider's webhook signature check here.
  r.post(
    '/webhooks/upi/utr',
    wrap(async (req, res) => {
      const { transactionRef, utr, amount, status } = req.body;
      const result = await s.upi.handleUtrWebhook({
        transactionRef,
        utr,
        amount: Number(amount),
        status,
      });
      res.status(result.status === 'REJECTED' ? 422 : 200).json(result);
    }),
  );

  // --- Reminders -----------------------------------------------------------
  r.put(
    '/reminders/policies',
    requireUser,
    wrap(async (req, res) => {
      const { bucket, channel, minIntervalDays, templateKey, enabled } = req.body;
      await s.reminders.upsertPolicy({
        distributorId: req.userId as string,
        bucket,
        channel,
        minIntervalDays,
        templateKey,
        enabled,
      });
      res.status(204).end();
    }),
  );

  r.post(
    '/reminders/dispatch',
    requireUser,
    wrap(async (req, res) => {
      const summary = await s.reminders.dispatchDueReminders(req.userId);
      res.json(summary);
    }),
  );

  // --- Payment plans (EMI) -------------------------------------------------
  r.post(
    '/payment-plans',
    requireUser,
    wrap(async (req, res) => {
      const { invoiceId, installmentCount, frequencyDays, interestRatePct, startDate } = req.body;
      const plan = await s.plans.createPlan({
        invoiceId,
        installmentCount: Number(installmentCount),
        frequencyDays,
        interestRatePct,
        startDate,
      });
      res.status(201).json(plan);
    }),
  );

  r.get(
    '/payment-plans/:id',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.plans.getPlan(req.params.id));
    }),
  );

  r.post(
    '/payment-plans/installments/:id/payments',
    requireUser,
    wrap(async (req, res) => {
      const { amount, method, reference } = req.body;
      const result = await s.plans.recordInstallmentPayment(req.params.id, Number(amount), method, reference);
      res.status(201).json(result);
    }),
  );

  // --- Interest / late fees ------------------------------------------------
  r.put(
    '/credit-terms',
    requireUser,
    wrap(async (req, res) => {
      const { gracePeriodDays, dailyInterestRatePct, maxInterestPct, enabled } = req.body;
      await s.interest.setCreditTerms({
        distributorId: req.userId as string,
        gracePeriodDays: Number(gracePeriodDays),
        dailyInterestRatePct: Number(dailyInterestRatePct),
        maxInterestPct,
        enabled,
      });
      res.status(204).end();
    }),
  );

  r.post(
    '/jobs/interest-accrual',
    wrap(async (req, res) => {
      res.json(await s.interest.accrueForDate(req.body?.asOf));
    }),
  );

  r.get(
    '/invoices/:id/balance',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.interest.getInvoiceBalance(req.params.id));
    }),
  );

  // --- Disputes ------------------------------------------------------------
  r.post(
    '/disputes',
    requireUser,
    wrap(async (req, res) => {
      const { invoiceId, reason, disputedAmount } = req.body;
      const dispute = await s.disputes.raiseDispute({
        invoiceId,
        raisedBy: req.userId as string,
        reason,
        disputedAmount: Number(disputedAmount),
      });
      res.status(201).json(dispute);
    }),
  );

  r.post(
    '/disputes/:id/review',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.disputes.markUnderReview(req.params.id));
    }),
  );

  r.post(
    '/disputes/:id/resolve',
    requireUser,
    wrap(async (req, res) => {
      const { creditAmount, note } = req.body;
      res.json(await s.disputes.resolveWithCreditNote(req.params.id, Number(creditAmount), note));
    }),
  );

  r.post(
    '/disputes/:id/reject',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.disputes.rejectDispute(req.params.id, req.body?.note));
    }),
  );

  r.post(
    '/disputes/:id/withdraw',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.disputes.withdrawDispute(req.params.id));
    }),
  );

  return r;
}
