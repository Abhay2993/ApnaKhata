/**
 * ApnaKhata — API gateway bootstrap
 * ---------------------------------
 * Express app wiring every service to its /v1 route. `buildApp()` is exported
 * separately from the listener so integration tests can mount it against a
 * test database.
 *
 * Env: DATABASE_URL (postgres connection string), PORT (default 8080),
 *      APNAKHATA_API_KEY (service key checked on every request).
 */

import express, { Express } from 'express';
import { Pool } from 'pg';

import { ConsoleNotifier, Notifier } from './notifications/Notifier';
import { ConsoleWhatsAppSender, WhatsAppSender } from './whatsapp/WhatsAppSender';
import { AnalyticsService } from './services/AnalyticsService';
import { BarcodeInventoryService } from './services/BarcodeInventoryService';
import { BatchExpiryService } from './services/BatchExpiryService';
import { BnplService } from './services/BnplService';
import { CreditHistoryService } from './services/CreditHistoryService';
import { CashDrawerService } from './services/CashDrawerService';
import { CustomerLedgerService } from './services/CustomerLedgerService';
import { DealerReliabilityService } from './services/DealerReliabilityService';
import { FestivalPlannerService } from './services/FestivalPlannerService';
import { SmartReminderService } from './services/SmartReminderService';
import { SyncService } from './services/SyncService';
import { UpiMandateService } from './services/UpiMandateService';
import { WhatsAppBotService } from './services/WhatsAppBotService';
import { EInvoiceService } from './services/EInvoiceService';
import { EwayBillService } from './services/EwayBillService';
import { GstInvoiceService } from './services/GstInvoiceService';
import { Gstr2bReconciliationService } from './services/Gstr2bReconciliationService';
import { ReceiptService } from './services/ReceiptService';
import { CreditPassportService } from './services/CreditPassportService';
import { CreditScoreEvaluator } from './services/CreditScoreEvaluator';
import { CreditSimulatorService } from './services/CreditSimulatorService';
import { DashboardService } from './services/DashboardService';
import { DealerDirectoryService } from './services/DealerDirectoryService';
import { DisputeService } from './services/DisputeService';
import { DistributorDemandService } from './services/DistributorDemandService';
import { IntegrationService } from './services/IntegrationService';
import { InterestAccrualService } from './services/InterestAccrualService';
import { LenderSubmissionService } from './services/LenderSubmissionService';
import { PaymentPlanService } from './services/PaymentPlanService';
import { PaymentReminderService } from './services/PaymentReminderService';
import { PurchaseOrderService } from './services/PurchaseOrderService';
import { SchemeService } from './services/SchemeService';
import { UpiCollectionService } from './services/UpiCollectionService';
import { WarehouseService } from './services/WarehouseService';
import { analyticsRoutes } from './http/analyticsRoutes';
import { complianceRoutes } from './http/complianceRoutes';
import { creditRoutes } from './http/creditRoutes';
import { customerRoutes } from './http/customerRoutes';
import { inventoryRoutes } from './http/inventoryRoutes';
import { ledgerRoutes } from './http/ledgerRoutes';
import { liveInventoryStreamHandler, marketplaceRoutes } from './http/marketplaceRoutes';
import { opsRoutes } from './http/opsRoutes';
import { syncRoutes } from './http/syncRoutes';
import { webhookRoutes } from './http/webhookRoutes';
import { cors, errorHandler, requireApiKey } from './http/middleware';

const SERVICE_API_KEY = process.env.APNAKHATA_API_KEY ?? 'dev-key';

export function buildApp(
  db: Pool,
  notifier: Notifier = new ConsoleNotifier(),
  whatsapp: WhatsAppSender = new ConsoleWhatsAppSender(),
): Express {
  const app = express();
  app.use(cors);
  // Capture the exact raw body so webhook HMAC verification is byte-accurate.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => ((req as express.Request).rawBody = buf) }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'apnakhata-gateway' });
  });

  const integrations = new IntegrationService(db);
  const customers = new CustomerLedgerService(db);
  const whatsappBot = new WhatsAppBotService(db, whatsapp, new PurchaseOrderService(db), customers);

  // External webhooks (billing HMAC + WhatsApp) — authenticate on their own, so
  // they are mounted BEFORE the /v1 service-key guard.
  app.use('/integrations/webhooks', webhookRoutes(integrations, whatsappBot));
  // Live inventory SSE — query-param auth (EventSource can't set headers), so
  // it too must sit before the header-only service-key guard.
  app.get('/v1/inventory/live/stream', liveInventoryStreamHandler(SERVICE_API_KEY));

  app.use('/v1', requireApiKey);
  app.use(
    '/v1',
    ledgerRoutes({
      upi: new UpiCollectionService(db),
      reminders: new PaymentReminderService(db, notifier),
      plans: new PaymentPlanService(db),
      interest: new InterestAccrualService(db),
      disputes: new DisputeService(db),
    }),
  );
  app.use(
    '/v1',
    inventoryRoutes({
      purchaseOrders: new PurchaseOrderService(db),
      barcodes: new BarcodeInventoryService(db),
      expiry: new BatchExpiryService(db),
      warehouse: new WarehouseService(db),
    }),
  );
  const passports = new CreditPassportService(db);
  app.use(
    '/v1',
    creditRoutes({
      creditScore: new CreditScoreEvaluator(db),
      demand: new DistributorDemandService(db),
      passports,
      simulator: new CreditSimulatorService(db),
      history: new CreditHistoryService(db),
      lenders: new LenderSubmissionService(db, passports),
      dashboard: new DashboardService(db),
      bnpl: new BnplService(db),
    }),
  );
  const gst = new GstInvoiceService(db);
  app.use(
    '/v1',
    complianceRoutes({
      gst,
      einvoice: new EInvoiceService(db, gst),
      receipts: new ReceiptService(db, gst),
      gstr2b: new Gstr2bReconciliationService(db),
      eway: new EwayBillService(db, gst),
    }),
  );
  app.use(
    '/v1',
    marketplaceRoutes({
      dealers: new DealerDirectoryService(db),
      purchaseOrders: new PurchaseOrderService(db),
      integrations,
      schemes: new SchemeService(db),
      reliability: new DealerReliabilityService(db),
    }),
  );
  app.use('/v1', analyticsRoutes(new AnalyticsService(db)));
  app.use('/v1', customerRoutes(customers));
  app.use('/v1', syncRoutes(new SyncService(db, customers)));
  app.use(
    '/v1',
    opsRoutes({
      cashDrawer: new CashDrawerService(db),
      mandates: new UpiMandateService(db),
      smartReminders: new SmartReminderService(db),
      festivals: new FestivalPlannerService(db),
    }),
  );

  app.use(errorHandler);
  return app;
}

/* istanbul ignore next -- listener wiring, exercised by deployment */
if (require.main === module) {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const port = Number(process.env.PORT ?? 8080);
  buildApp(db).listen(port, () => {
    console.log(`apnakhata-gateway listening on :${port}`);
  });
}
