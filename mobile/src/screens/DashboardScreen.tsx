/**
 * ApnaKhata — Dashboard
 * -------------------------
 * Private-banking aesthetic: obsidian ground, charcoal surfaces, regal gold
 * accents, alabaster type. No neon, no clutter.
 *
 * Styling: NativeWind (Tailwind) classes with the design-token palette from
 * docs/ARCHITECTURE.md §3.1. The score arc and sparklines use react-native-svg.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, SafeAreaView, StatusBar, Text, View } from 'react-native';
import Svg, { Circle, Path, Polyline } from 'react-native-svg';

import { api } from '../api/client';

// ---------------------------------------------------------------------------
// Design tokens (mirrors tailwind.config.js theme.extend.colors)
// ---------------------------------------------------------------------------
const palette = {
  obsidian: '#0B0C10',
  charcoal: '#1F2833',
  gold: '#C5A059',
  goldBright: '#D4AF37',
  slate: '#C0C0C0',
  alabaster: '#F5F5F7',
  danger: '#B4544B',
} as const;

// ---------------------------------------------------------------------------
// Domain contracts (shared with the backend via the API client)
// ---------------------------------------------------------------------------
type RiskTier = 'PRIME' | 'SUBPRIME' | 'HIGH_RISK';
type LoanStatus = 'PRE_APPROVED' | 'UNDER_REVIEW' | 'NOT_ELIGIBLE';

interface CreditSummary {
  score: number; // 300..900
  tier: RiskTier;
  loanStatus: LoanStatus;
  preApprovedLimit: number; // INR
  partnerBank: string;
}

interface CashFlowSummary {
  receivables: number;
  payables: number;
  todayCollections: number;
}

interface StockAlert {
  id: string;
  inventoryId: string; // backend item id — the one-tap reorder target
  productName: string;
  sku: string;
  currentStock: number;
  unit: string;
  daysUntilStockout: number;
  recommendedOrderQty: number;
  distributorName: string;
  trend: number[]; // last 14 days of unit sales, for the sparkline
}

type OrderState = 'idle' | 'pending' | 'ordered' | 'failed';

// ---------------------------------------------------------------------------
// Mock state — replaced by useDashboardQuery() against the NestJS gateway
// ---------------------------------------------------------------------------
const credit: CreditSummary = {
  score: 782,
  tier: 'PRIME',
  loanStatus: 'PRE_APPROVED',
  preApprovedLimit: 250000,
  partnerBank: 'HDFC Bank',
};

const cashFlow: CashFlowSummary = {
  receivables: 184250,
  payables: 96400,
  todayCollections: 12750,
};

const stockAlerts: StockAlert[] = [
  {
    id: '1',
    inventoryId: 'inv-tata-salt-1kg',
    productName: 'Tata Salt 1kg',
    sku: 'TATA-SALT-1KG',
    currentStock: 14,
    unit: 'PCS',
    daysUntilStockout: 2,
    recommendedOrderQty: 96,
    distributorName: 'Sharma Distributors',
    trend: [6, 8, 7, 9, 6, 11, 8, 10, 9, 12, 10, 13, 11, 12],
  },
  {
    id: '2',
    inventoryId: 'inv-fort-oil-1l',
    productName: 'Fortune Sunflower Oil 1L',
    sku: 'FORT-OIL-1L',
    currentStock: 22,
    unit: 'PCS',
    daysUntilStockout: 5,
    recommendedOrderQty: 48,
    distributorName: 'Agarwal Trading Co.',
    trend: [3, 4, 4, 5, 3, 6, 4, 5, 5, 4, 6, 5, 4, 5],
  },
  {
    id: '3',
    inventoryId: 'inv-parle-g-800',
    productName: 'Parle-G 800g Family Pack',
    sku: 'PARLE-G-800',
    currentStock: 35,
    unit: 'PCS',
    daysUntilStockout: 9,
    recommendedOrderQty: 60,
    distributorName: 'Sharma Distributors',
    trend: [4, 3, 5, 4, 4, 5, 3, 4, 5, 4, 3, 4, 5, 4],
  },
];

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const inr = (value: number): string =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);

const tierLabel: Record<RiskTier, string> = {
  PRIME: 'Prime',
  SUBPRIME: 'Subprime',
  HIGH_RISK: 'High Risk',
};

const loanStatusLabel: Record<LoanStatus, string> = {
  PRE_APPROVED: 'Pre-approved',
  UNDER_REVIEW: 'Under review',
  NOT_ELIGIBLE: 'Building eligibility',
};

// ---------------------------------------------------------------------------
// Score arc — 240° gold gauge, thin stroke, no gridlines
// ---------------------------------------------------------------------------
const ScoreArc: React.FC<{ score: number }> = ({ score }) => {
  const size = 168;
  const strokeWidth = 7;
  const radius = (size - strokeWidth) / 2;
  const center = size / 2;
  const startAngle = 150; // degrees; sweep 240° clockwise to 30°
  const sweep = 240;
  const progress = Math.min(Math.max((score - 300) / 600, 0), 1);

  const polar = (angleDeg: number) => {
    const rad = (Math.PI / 180) * angleDeg;
    return { x: center + radius * Math.cos(rad), y: center + radius * Math.sin(rad) };
  };

  const arcPath = (fromDeg: number, toDeg: number) => {
    const from = polar(fromDeg);
    const to = polar(toDeg);
    const largeArc = toDeg - fromDeg > 180 ? 1 : 0;
    return `M ${from.x} ${from.y} A ${radius} ${radius} 0 ${largeArc} 1 ${to.x} ${to.y}`;
  };

  const dot = polar(startAngle + sweep * progress);

  return (
    <Svg width={size} height={size}>
      <Path
        d={arcPath(startAngle, startAngle + sweep)}
        stroke={palette.charcoal}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d={arcPath(startAngle, startAngle + Math.max(sweep * progress, 1))}
        stroke={palette.gold}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        fill="none"
      />
      <Circle cx={dot.x} cy={dot.y} r={strokeWidth} fill={palette.goldBright} />
    </Svg>
  );
};

// ---------------------------------------------------------------------------
// 14-day sales sparkline — single thin slate stroke
// ---------------------------------------------------------------------------
const Sparkline: React.FC<{ data: number[]; width?: number; height?: number }> = ({
  data,
  width = 72,
  height = 24,
}) => {
  const points = useMemo(() => {
    const max = Math.max(...data, 1);
    const min = Math.min(...data, 0);
    const span = max - min || 1;
    const stepX = width / (data.length - 1 || 1);
    return data
      .map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`)
      .join(' ');
  }, [data, width, height]);

  return (
    <Svg width={width} height={height}>
      <Polyline points={points} fill="none" stroke={palette.slate} strokeWidth={1.5} strokeOpacity={0.7} />
    </Svg>
  );
};

// ---------------------------------------------------------------------------
// Credit Score & Bank Loan Status widget
// ---------------------------------------------------------------------------
const CreditScoreCard: React.FC<{ data: CreditSummary }> = ({ data }) => (
  <View className="mx-5 mt-6 rounded-2xl border border-[#C5A05955] bg-[#1F2833]/80 p-6">
    <View className="flex-row items-center justify-between">
      <Text className="text-xs uppercase tracking-[3px] text-[#C0C0C0]">ApnaKhata Credit Passport</Text>
      <View className="rounded-full border border-[#C5A05966] px-3 py-1">
        <Text className="text-[11px] font-semibold tracking-widest text-[#D4AF37]">
          {tierLabel[data.tier].toUpperCase()}
        </Text>
      </View>
    </View>

    <View className="mt-4 flex-row items-center">
      <View className="items-center justify-center">
        <ScoreArc score={data.score} />
        <View className="absolute items-center">
          <Text
            className="text-5xl text-[#F5F5F7]"
            style={{ fontFamily: 'PlayfairDisplay-SemiBold', fontVariant: ['tabular-nums'] }}
          >
            {data.score}
          </Text>
          <Text className="mt-1 text-[10px] uppercase tracking-[2px] text-[#C0C0C0]">of 900</Text>
        </View>
      </View>

      <View className="ml-6 flex-1">
        <Text className="text-[11px] uppercase tracking-[2px] text-[#C0C0C0]">Working capital</Text>
        <Text
          className="mt-1 text-2xl text-[#D4AF37]"
          style={{ fontFamily: 'Inter-SemiBold', fontVariant: ['tabular-nums'] }}
        >
          {inr(data.preApprovedLimit)}
        </Text>
        <Text className="mt-2 text-xs leading-5 text-[#C0C0C0]">
          {loanStatusLabel[data.loanStatus]} · {data.partnerBank}
        </Text>
        <Pressable
          className="mt-4 self-start rounded-lg border border-[#C5A059] px-4 py-2 active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel="Download signed credit passport PDF"
        >
          <Text className="text-xs font-semibold tracking-wider text-[#C5A059]">EXPORT PASSPORT</Text>
        </Pressable>
      </View>
    </View>
  </View>
);

// ---------------------------------------------------------------------------
// Cash-flow balances
// ---------------------------------------------------------------------------
const BalanceStat: React.FC<{ label: string; value: number; emphasized?: boolean }> = ({
  label,
  value,
  emphasized = false,
}) => (
  <View className="flex-1">
    <Text className="text-[10px] uppercase tracking-[2px] text-[#C0C0C0]">{label}</Text>
    <Text
      className={`mt-1 text-xl ${emphasized ? 'text-[#D4AF37]' : 'text-[#F5F5F7]'}`}
      style={{ fontFamily: 'Inter-SemiBold', fontVariant: ['tabular-nums'] }}
    >
      {inr(value)}
    </Text>
  </View>
);

const CashFlowCard: React.FC<{ data: CashFlowSummary }> = ({ data }) => (
  <View className="mx-5 mt-4 rounded-2xl border border-[#C5A05933] bg-[#1F2833] p-6">
    <Text className="text-xs uppercase tracking-[3px] text-[#C0C0C0]">Cash Flow</Text>
    <View className="mt-4 flex-row">
      <BalanceStat label="To Receive" value={data.receivables} emphasized />
      <BalanceStat label="To Pay" value={data.payables} />
    </View>
    <View className="mt-5 border-t border-[#C0C0C022] pt-4">
      <Text className="text-[10px] uppercase tracking-[2px] text-[#C0C0C0]">Collected today</Text>
      <Text
        className="mt-1 text-lg text-[#F5F5F7]"
        style={{ fontFamily: 'Inter-Medium', fontVariant: ['tabular-nums'] }}
      >
        {inr(data.todayCollections)}
      </Text>
    </View>
  </View>
);

// ---------------------------------------------------------------------------
// Forecast-driven stock alerts
// ---------------------------------------------------------------------------
const urgencyColor = (days: number): string =>
  days <= 3 ? palette.danger : days <= 7 ? palette.goldBright : palette.slate;

const orderButtonLabel = (state: OrderState, qty: number): string => {
  switch (state) {
    case 'pending':
      return 'PLACING…';
    case 'ordered':
      return 'ORDERED ✓';
    case 'failed':
      return 'RETRY ORDER';
    default:
      return `ORDER ${qty}`;
  }
};

const StockAlertRow: React.FC<{
  item: StockAlert;
  orderState: OrderState;
  poNumber?: string;
  onReorder: (item: StockAlert) => void;
}> = ({ item, orderState, poNumber, onReorder }) => (
  <View className="mx-5 mb-3 rounded-xl border border-[#C5A05926] bg-[#1F2833] p-4">
    <View className="flex-row items-center justify-between">
      <View className="mr-3 flex-1">
        <Text className="text-[15px] font-medium text-[#F5F5F7]" numberOfLines={1}>
          {item.productName}
        </Text>
        <Text className="mt-0.5 text-[11px] text-[#C0C0C0]">
          {item.currentStock} {item.unit} left · {item.distributorName}
        </Text>
      </View>
      <Sparkline data={item.trend} />
    </View>

    <View className="mt-3 flex-row items-center justify-between">
      <View className="flex-row items-center">
        <View
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: urgencyColor(item.daysUntilStockout) }}
        />
        <Text className="ml-2 text-xs" style={{ color: urgencyColor(item.daysUntilStockout) }}>
          {orderState === 'ordered' && poNumber
            ? `PO ${poNumber} sent to ${item.distributorName}`
            : `Depletes in ${item.daysUntilStockout} ${item.daysUntilStockout === 1 ? 'day' : 'days'}`}
        </Text>
      </View>
      <Pressable
        className={`rounded-lg px-4 py-2 active:opacity-80 ${
          orderState === 'ordered'
            ? 'border border-[#C5A059] bg-transparent'
            : orderState === 'pending'
              ? 'bg-[#C5A05966]'
              : 'bg-[#C5A059]'
        }`}
        disabled={orderState === 'pending' || orderState === 'ordered'}
        onPress={() => onReorder(item)}
        accessibilityRole="button"
        accessibilityLabel={`Reorder ${item.recommendedOrderQty} units of ${item.productName}`}
      >
        <Text
          className={`text-xs font-semibold tracking-wide ${
            orderState === 'ordered' ? 'text-[#C5A059]' : 'text-[#0B0C10]'
          }`}
        >
          {orderButtonLabel(orderState, item.recommendedOrderQty)}
        </Text>
      </Pressable>
    </View>
  </View>
);

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
const DashboardScreen: React.FC = () => {
  const [orderStates, setOrderStates] = useState<Record<string, OrderState>>({});
  const [poNumbers, setPoNumbers] = useState<Record<string, string>>({});

  // One-tap reorder: forecast recommendation → SUBMITTED purchase order.
  const handleReorder = useCallback(async (item: StockAlert): Promise<void> => {
    setOrderStates((prev) => ({ ...prev, [item.id]: 'pending' }));
    try {
      const po = await api.createPurchaseOrderFromForecast(item.inventoryId);
      setPoNumbers((prev) => ({ ...prev, [item.id]: po.poNumber }));
      setOrderStates((prev) => ({ ...prev, [item.id]: 'ordered' }));
    } catch {
      setOrderStates((prev) => ({ ...prev, [item.id]: 'failed' }));
    }
  }, []);

  return (
    <SafeAreaView className="flex-1 bg-[#0B0C10]">
      <StatusBar barStyle="light-content" backgroundColor={palette.obsidian} />
      <FlatList
        data={stockAlerts}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <StockAlertRow
            item={item}
            orderState={orderStates[item.id] ?? 'idle'}
            poNumber={poNumbers[item.id]}
            onReorder={handleReorder}
          />
        )}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <>
            <View className="mx-5 mt-4 flex-row items-baseline justify-between">
              <Text className="text-2xl text-[#F5F5F7]" style={{ fontFamily: 'PlayfairDisplay-SemiBold' }}>
                ApnaKhata
              </Text>
              <Text className="text-xs tracking-wider text-[#C0C0C0]">Gupta General Store</Text>
            </View>

            <CreditScoreCard data={credit} />
            <CashFlowCard data={cashFlow} />

            <View className="mx-5 mb-3 mt-7 flex-row items-center justify-between">
              <Text className="text-xs uppercase tracking-[3px] text-[#C0C0C0]">Stock Alerts</Text>
              <Text className="text-[11px] text-[#C5A059]">Forecast · next 45 days</Text>
            </View>
          </>
        }
        ListFooterComponent={<View className="h-8" />}
      />
    </SafeAreaView>
  );
};

export default DashboardScreen;
