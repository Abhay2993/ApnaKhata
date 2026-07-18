/**
 * ApnaKhata web — demo dataset. Powers the standalone Vercel preview (no
 * backend) so every feature screen renders fully. Live mode overrides these
 * with real API responses where an endpoint exists.
 */

export const demo = {
  credit: {
    score: 782,
    tier: 'PRIME' as const,
    preApprovedLimit: 250000,
    partnerBank: 'HDFC Bank',
    pillars: { repaymentVelocity: 92, transactionConsistency: 80, supplierRetention: 71, inventoryTurn: 88 },
    history: [712, 724, 731, 740, 748, 755, 762, 770, 776, 782],
    suggestions: [
      { label: 'Pay bills 10 days earlier', scoreDelta: 21 },
      { label: 'Cut inventory days by 15', scoreDelta: 9 },
    ],
    bnpl: {
      eligible: true,
      tier: 'PRIME',
      approvedLimit: 250000,
      availableLimit: 189500,
      outstanding: 60500,
      feeSchedule: [
        { tenureDays: 15, feeRatePct: 1.0 },
        { tenureDays: 30, feeRatePct: 1.5 },
        { tenureDays: 60, feeRatePct: 2.5 },
      ],
    },
    financings: [
      { lender: 'HDFC', principal: 60000, feeAmount: 900, totalRepayable: 60900, amountRepaid: 400, tenureDays: 30, dueDate: '2026-08-15', status: 'ACTIVE' },
    ],
    lenders: [
      { lender: 'HDFC', status: 'PRE_APPROVED', requestedAmount: 200000, approvedAmount: 200000, interestRatePct: 14.5 },
      { lender: 'ICICI', status: 'PRE_APPROVED', requestedAmount: 150000, approvedAmount: 138000, interestRatePct: 14.5 },
    ],
  },

  analytics: {
    profit: {
      summary: { totalRevenue: 486300, totalCogs: 402100, grossProfit: 84200, grossMarginPct: 17.3, inventoryValue: 128400, deadStockValue: 18600 },
      fastestMovers: [
        { productName: 'Tata Salt 1kg', unitsSold: 540, grossProfit: 3240, marginPct: 21.4 },
        { productName: 'Fortune Sunflower Oil 1L', unitsSold: 310, grossProfit: 4650, marginPct: 9.1 },
        { productName: 'Parle-G 800g', unitsSold: 280, grossProfit: 3920, marginPct: 14.3 },
        { productName: 'Aashirvaad Atta 5kg', unitsSold: 190, grossProfit: 9500, marginPct: 17.2 },
      ],
      deadStock: [
        { productName: 'Diwali Gift Hamper', stockValue: 9800 },
        { productName: 'Imported Olive Oil 1L', stockValue: 5400 },
        { productName: 'Premium Basmati 10kg', stockValue: 3400 },
      ],
    },
    health: {
      healthScore: 72,
      rating: 'STABLE',
      inventoryValue: 128400,
      receivables: 46200,
      payables: 96400,
      daysInventoryOutstanding: 41,
      daysSalesOutstanding: 18,
      daysPayableOutstanding: 34,
      cashConversionCycleDays: 25,
      dailyGrossProfit: 936,
      cashPositive: true,
      cashRunwayDays: null as number | null,
      advice: ['Oil margin is thin (9%) — negotiate a better slab with your distributor.', '₹18,600 is tied up in dead stock — run a festive clearance.'],
    },
  },

  compliance: {
    gstr3b: { outward_taxable_value: 486300, cgst: 21884, sgst: 21884, igst: 4200, total_tax: 47968 },
    gstr1: { b2b: 12, b2cs: 5, hsn: 9, total_tax: 47968 },
    einvoice: { required: false, trailing12mTurnover: 5836000 },
    itc: {
      counts: { MATCHED: 9, MISMATCH: 2, MISSING_IN_2B: 3, MISSING_IN_BOOKS: 1 },
      itc: { eligible: 38400, atRisk: 4600, mismatchDelta: -820, availableUnrecorded: 1500 },
    },
    eway: [
      { ewbNo: '487786597789', invoice: 'GST-20260716-A1', value: 82600, status: 'ACTIVE', validUpto: '2026-07-20' },
      { ewbNo: '331209884517', invoice: 'GST-20260714-C4', value: 61000, status: 'ACTIVE', validUpto: '2026-07-19' },
    ],
  },

  ledger: {
    receivables: 46200,
    payables: 96400,
    invoices: [
      { party: 'Sharma Distributors', invoiceNumber: 'S-INV-207', amount: 18500, balance: 18500, dueDate: '2026-07-10', status: 'DUE', overdue: true },
      { party: 'Agarwal Trading', invoiceNumber: 'A-INV-88', amount: 42000, balance: 21000, dueDate: '2026-07-25', status: 'PARTIAL', overdue: false },
      { party: 'Verma Wholesale', invoiceNumber: 'V-INV-11', amount: 56900, balance: 56900, dueDate: '2026-08-02', status: 'DUE', overdue: false },
    ],
    reminders: { considered: 4, sent: 4, failed: 0 },
    plans: [
      { invoice: 'A-INV-88', installmentCount: 3, paid: 1, nextDue: '2026-08-05', amountDue: 14000 },
    ],
    disputes: [
      { invoiceNumber: 'S-INV-190', reason: 'Short shipment: 2 cases missing', disputedAmount: 1000, status: 'RESOLVED_UPHELD' },
    ],
  },

  liveInventory: [
    { sku: 'TATA-SALT-1KG', productName: 'Tata Salt 1kg', currentStock: 9, unit: 'PCS', minimumThreshold: 20, lastMovementDelta: -5 },
    { sku: 'FORT-OIL-1L', productName: 'Fortune Sunflower Oil 1L', currentStock: 22, unit: 'PCS', minimumThreshold: 15, lastMovementDelta: -2 },
    { sku: 'PARLE-G-800', productName: 'Parle-G 800g', currentStock: 35, unit: 'PCS', minimumThreshold: 20, lastMovementDelta: -1 },
    { sku: 'AASHIRVAAD-ATTA-5KG', productName: 'Aashirvaad Atta 5kg', currentStock: 6, unit: 'BAG', minimumThreshold: 10, lastMovementDelta: -3 },
  ],
};
