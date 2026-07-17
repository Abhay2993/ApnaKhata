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
import { BarcodeInventoryService } from './services/BarcodeInventoryService';
import { BatchExpiryService } from './services/BatchExpiryService';
import { CreditHistoryService } from './services/CreditHistoryService';
import { EInvoiceService } from './services/EInvoiceService';
import { GstInvoiceService } from './services/GstInvoiceService';
import { ReceiptService } from './services/ReceiptService';
import { CreditPassportService } from './services/CreditPassportService';
import { CreditScoreEvaluator } from './services/CreditScoreEvaluator';
import { CreditSimulatorService } from './services/CreditSimulatorService';
import { DisputeService } from './services/DisputeService';
import { DistributorDemandService } from './services/DistributorDemandService';
import { InterestAccrualService } from './services/InterestAccrualService';
import { LenderSubmissionService } from './services/LenderSubmissionService';
import { PaymentPlanService } from './services/PaymentPlanService';
import { PaymentReminderService } from './services/PaymentReminderService';
import { PurchaseOrderService } from './services/PurchaseOrderService';
import { UpiCollectionService } from './services/UpiCollectionService';
import { WarehouseService } from './services/WarehouseService';
import { complianceRoutes } from './http/complianceRoutes';
import { creditRoutes } from './http/creditRoutes';
import { inventoryRoutes } from './http/inventoryRoutes';
import { ledgerRoutes } from './http/ledgerRoutes';
import { errorHandler, requireApiKey } from './http/middleware';

export function buildApp(db: Pool, notifier: Notifier = new ConsoleNotifier()): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'apnakhata-gateway' });
  });

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
    }),
  );
  const gst = new GstInvoiceService(db);
  app.use(
    '/v1',
    complianceRoutes({
      gst,
      einvoice: new EInvoiceService(db, gst),
      receipts: new ReceiptService(db, gst),
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
