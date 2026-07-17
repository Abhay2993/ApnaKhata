# ApnaKhata

A premium B2B ledger, billing, and intelligent inventory ecosystem for the Indian MSME
supply chain — connecting **Distributors** (wholesalers) and **Shop Owners** (kirana /
retailers) on a single, bank-grade financial rail.

## App preview

GitHub can't execute a React Native app, so these rendered previews (mirroring the
real components in `mobile/src/screens/`) are embedded directly in the repo. To run
the live app, see [`mobile/README.md`](mobile/README.md).

| Dashboard | Scan & Bill |
| :---: | :---: |
| <img src="docs/assets/dashboard-preview.svg" width="330" alt="Dashboard: credit passport with 782 score arc, cash flow balances, forecast-driven stock alerts with one-tap reorder"/> | <img src="docs/assets/scan-preview.svg" width="330" alt="Scan and bill: camera barcode viewfinder, billing cart, charge button"/> |

## What lives where

| Path | Purpose |
| --- | --- |
| `docs/ARCHITECTURE.md` | Full technical specification: system architecture, settlement engine, webhook gateway, ML forecasting design, credit passport, UI design system. |
| `database/schema.sql` | PostgreSQL DDL — users, inventory, transactions ledger, payment allocations (FIFO settlement), credit score metrics, stock movement time-series. |
| `database/migrations/001_payments_ledger.sql` | Payments & ledger extensions — UPI collection + auto-reconciliation, reminder policies, EMI plans, interest accrual, dispute/credit-note workflow, with SERIALIZABLE-safe settlement functions. |
| `backend/src/services/UpiCollectionService.ts` | Generates UPI deep links per invoice and reconciles UTR webhooks straight into the FIFO engine. |
| `backend/src/services/PaymentReminderService.ts` | Escalating WhatsApp/SMS reminders driven by aging buckets, with cadence throttling. |
| `backend/src/services/PaymentPlanService.ts` | Restructures an invoice into an EMI schedule of installments tracked against the parent. |
| `backend/src/services/InterestAccrualService.ts` | Per-distributor grace period + daily late-fee accrual, stored separately from principal. |
| `backend/src/services/DisputeService.ts` | Dispute lifecycle behind `is_disputed`, resolving via signed `CREDIT_NOTE` ledger rows. |
| `database/migrations/002_inventory_forecasting.sql` | Inventory extensions — purchase orders, barcodes, expiry-aware batches (FEFO), multi-location stock, demand-forecast store, with atomic goods-receipt/consume/transfer functions. |
| `backend/src/services/PurchaseOrderService.ts` | One-tap reorder: forecast recommendation → SUBMITTED PO; goods receipt raises the ledger invoice and stocks in batches atomically. |
| `backend/src/services/BarcodeInventoryService.ts` | Camera-scan backend: barcode lookup, batch stock-in, FEFO billing. |
| `backend/src/services/BatchExpiryService.ts` | Near-expiry alerts, expired write-off, and the batch payload for expiry-aware forecasting. |
| `backend/src/services/WarehouseService.ts` | Multi-location stock: godowns, FEFO transfers, per-location holdings. |
| `backend/src/services/DistributorDemandService.ts` | Distributor-side rollup of retailer forecasts for upstream procurement planning. |
| `mobile/src/api/client.ts` | Typed mobile API client (reorder, barcode lookup, stock-in, checkout). |
| `mobile/src/screens/ScanScreen.tsx` | Camera barcode/QR scanner — billing cart and batch/expiry stock-in modes. |
| `services/forecasting/forecast.py` | FastAPI + Prophet stock-forecasting microservice (Indian festival seasonality, safety-stock index, reorder recommendations). |
| `services/forecasting/requirements.txt` | Python dependencies for the forecasting service. |
| `backend/src/services/CreditScoreEvaluator.ts` | Weighted credit scoring engine (300–900) with risk-tier classification, backed by the transactions ledger. |
| `mobile/src/screens/DashboardScreen.tsx` | React Native + TypeScript + NativeWind dashboard — credit score widget, cash-flow balances, forecast-driven stock alerts. |

## Core pillars

1. **Dual-sided digital khata** — real-time procurement + retail ledgers with an
   automated FIFO settlement engine and transactional SMS/WhatsApp notifications.
2. **Billing & POS integration** — ESC/POS thermal printing and a secured webhook
   gateway for Tally / Vyapar / Marg ERP ingestion.
3. **ML stock forecasting** — Prophet-based 90-day rolling demand model tuned for
   Indian retail seasonality (Diwali, Holi, wedding seasons).
4. **Bank-ready credit evaluation** — a transparent 300–900 score computed from actual
   ledger behavior, exportable as a cryptographically signed "ApnaKhata Credit Risk
   Passport" PDF for lender API integration.

See `docs/ARCHITECTURE.md` for the complete blueprint.
