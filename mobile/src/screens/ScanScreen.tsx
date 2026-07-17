/**
 * ApnaKhata — Scan Screen
 * -----------------------
 * Camera-based barcode/QR scanning (react-native-vision-camera v4 — the
 * useCodeScanner API; no extra hardware) with two modes:
 *
 *   STOCK IN  — scan a case, enter quantity + batch/expiry, goods inward.
 *   BILLING   — scan items into a cart, checkout sells FEFO on the backend.
 *
 * Same private-banking aesthetic as the dashboard: obsidian ground, charcoal
 * surfaces, gold accents.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  SafeAreaView,
  StatusBar,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useCodeScanner,
} from 'react-native-vision-camera';

import { api, ScannedProduct } from '../api/client';

type ScanMode = 'STOCK_IN' | 'BILLING';

interface CartLine {
  barcode: string;
  sku: string;
  productName: string;
  unitPrice: number;
  quantity: number;
}

const inr = (value: number): string =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(
    value,
  );

const GOLD = '#C5A059';

const ScanScreen: React.FC = () => {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');

  const [mode, setMode] = useState<ScanMode>('BILLING');
  const [scanned, setScanned] = useState<ScannedProduct | null>(null);
  const [notFoundCode, setNotFoundCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusLine, setStatusLine] = useState<string | null>(null);

  // Stock-in form state
  const [qty, setQty] = useState('1');
  const [batchNumber, setBatchNumber] = useState('');
  const [expiryDate, setExpiryDate] = useState(''); // YYYY-MM-DD

  // Billing cart
  const [cart, setCart] = useState<CartLine[]>([]);
  const cartTotal = useMemo(() => cart.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0), [cart]);

  const handleCode = useCallback(
    async (code: string): Promise<void> => {
      if (busy || scanned) return; // one product at a time; RESUME re-arms
      setBusy(true);
      setNotFoundCode(null);
      try {
        const product = await api.lookupBarcode(code);
        if (!product) {
          setNotFoundCode(code);
        } else if (mode === 'BILLING') {
          setCart((prev) => {
            const existing = prev.find((l) => l.barcode === product.barcode);
            if (existing) {
              return prev.map((l) =>
                l.barcode === product.barcode ? { ...l, quantity: l.quantity + 1 } : l,
              );
            }
            return [
              ...prev,
              {
                barcode: product.barcode,
                sku: product.sku,
                productName: product.productName,
                unitPrice: product.retailPrice,
                quantity: 1,
              },
            ];
          });
          setStatusLine(`Added ${product.productName}`);
        } else {
          setScanned(product); // open the stock-in form
        }
      } catch (err) {
        setStatusLine(err instanceof Error ? err.message : 'Lookup failed');
      } finally {
        setBusy(false);
      }
    },
    [busy, scanned, mode],
  );

  const codeScanner = useCodeScanner({
    codeTypes: ['ean-13', 'ean-8', 'upc-a', 'code-128', 'qr'],
    onCodeScanned: (codes) => {
      const value = codes[0]?.value;
      if (value) void handleCode(value);
    },
  });

  const submitStockIn = useCallback(async (): Promise<void> => {
    if (!scanned) return;
    const quantity = Number(qty);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setStatusLine('Enter a valid quantity');
      return;
    }
    setBusy(true);
    try {
      const result = await api.stockInByBarcode({
        barcode: scanned.barcode,
        quantity,
        batchNumber: batchNumber.trim() || undefined,
        expiryDate: expiryDate.trim() || undefined,
      });
      setStatusLine(`${scanned.productName}: stock now ${result.newStock}`);
      setScanned(null);
      setQty('1');
      setBatchNumber('');
      setExpiryDate('');
    } catch (err) {
      setStatusLine(err instanceof Error ? err.message : 'Stock-in failed');
    } finally {
      setBusy(false);
    }
  }, [scanned, qty, batchNumber, expiryDate]);

  const checkout = useCallback(async (): Promise<void> => {
    if (cart.length === 0) return;
    setBusy(true);
    try {
      const receipt = await api.checkout(cart.map((l) => ({ barcode: l.barcode, quantity: l.quantity })));
      setStatusLine(`Billed ${inr(receipt.total)}`);
      setCart([]);
    } catch (err) {
      setStatusLine(err instanceof Error ? err.message : 'Checkout failed');
    } finally {
      setBusy(false);
    }
  }, [cart]);

  if (!hasPermission) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-[#0B0C10] px-10">
        <Text className="text-center text-base text-[#F5F5F7]">
          ApnaKhata needs camera access to scan barcodes for billing and stock entry.
        </Text>
        <Pressable
          className="mt-6 rounded-lg bg-[#C5A059] px-6 py-3 active:opacity-80"
          onPress={() => void requestPermission()}
          accessibilityRole="button"
        >
          <Text className="text-xs font-semibold tracking-wider text-[#0B0C10]">ALLOW CAMERA</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-[#0B0C10]">
      <StatusBar barStyle="light-content" backgroundColor="#0B0C10" />

      {/* Mode switch */}
      <View className="mx-5 mt-4 flex-row rounded-xl border border-[#C5A05933] bg-[#1F2833] p-1">
        {(['BILLING', 'STOCK_IN'] as const).map((m) => (
          <Pressable
            key={m}
            className={`flex-1 items-center rounded-lg py-2 ${mode === m ? 'bg-[#C5A059]' : ''}`}
            onPress={() => {
              setMode(m);
              setScanned(null);
              setNotFoundCode(null);
            }}
            accessibilityRole="button"
          >
            <Text
              className={`text-xs font-semibold tracking-widest ${
                mode === m ? 'text-[#0B0C10]' : 'text-[#C0C0C0]'
              }`}
            >
              {m === 'BILLING' ? 'BILLING' : 'STOCK IN'}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Viewfinder */}
      <View className="mx-5 mt-4 h-64 overflow-hidden rounded-2xl border border-[#C5A05955]">
        {device ? (
          <Camera
            style={{ flex: 1 }}
            device={device}
            isActive={!scanned && !busy}
            codeScanner={codeScanner}
          />
        ) : (
          <View className="flex-1 items-center justify-center bg-[#1F2833]">
            <Text className="text-xs text-[#C0C0C0]">No camera available</Text>
          </View>
        )}
      </View>

      {statusLine && (
        <Text className="mx-5 mt-3 text-xs text-[#C5A059]" numberOfLines={1}>
          {statusLine}
        </Text>
      )}
      {notFoundCode && (
        <Text className="mx-5 mt-3 text-xs text-[#B4544B]">
          No product for code {notFoundCode}. Add it in Inventory first.
        </Text>
      )}

      {/* Stock-in form (appears after a successful scan) */}
      {mode === 'STOCK_IN' && scanned && (
        <View className="mx-5 mt-4 rounded-2xl border border-[#C5A05933] bg-[#1F2833] p-5">
          <Text className="text-[15px] font-medium text-[#F5F5F7]">{scanned.productName}</Text>
          <Text className="mt-0.5 text-[11px] text-[#C0C0C0]">
            {scanned.sku} · current stock {scanned.currentStock} {scanned.unit}
          </Text>

          <View className="mt-4 flex-row gap-3">
            <TextInput
              className="flex-1 rounded-lg border border-[#C0C0C022] px-3 py-2 text-[#F5F5F7]"
              value={qty}
              onChangeText={setQty}
              keyboardType="numeric"
              placeholder="Qty"
              placeholderTextColor="#C0C0C066"
            />
            <TextInput
              className="flex-1 rounded-lg border border-[#C0C0C022] px-3 py-2 text-[#F5F5F7]"
              value={batchNumber}
              onChangeText={setBatchNumber}
              placeholder="Batch no."
              placeholderTextColor="#C0C0C066"
            />
          </View>
          <TextInput
            className="mt-3 rounded-lg border border-[#C0C0C022] px-3 py-2 text-[#F5F5F7]"
            value={expiryDate}
            onChangeText={setExpiryDate}
            placeholder="Expiry (YYYY-MM-DD, optional)"
            placeholderTextColor="#C0C0C066"
          />

          <View className="mt-4 flex-row justify-end gap-3">
            <Pressable
              className="rounded-lg border border-[#C0C0C044] px-4 py-2 active:opacity-70"
              onPress={() => setScanned(null)}
              accessibilityRole="button"
            >
              <Text className="text-xs font-semibold tracking-wide text-[#C0C0C0]">CANCEL</Text>
            </Pressable>
            <Pressable
              className="rounded-lg bg-[#C5A059] px-5 py-2 active:opacity-80"
              disabled={busy}
              onPress={() => void submitStockIn()}
              accessibilityRole="button"
            >
              <Text className="text-xs font-semibold tracking-wide text-[#0B0C10]">ADD STOCK</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Billing cart */}
      {mode === 'BILLING' && (
        <View className="mx-5 mt-4 flex-1">
          <FlatList
            data={cart}
            keyExtractor={(line) => line.barcode}
            ListEmptyComponent={
              <Text className="mt-6 text-center text-xs text-[#C0C0C0]">
                Scan items to start a bill
              </Text>
            }
            renderItem={({ item }) => (
              <View className="mb-2 flex-row items-center justify-between rounded-xl border border-[#C5A05926] bg-[#1F2833] px-4 py-3">
                <View className="mr-3 flex-1">
                  <Text className="text-[13px] text-[#F5F5F7]" numberOfLines={1}>
                    {item.productName}
                  </Text>
                  <Text className="text-[11px] text-[#C0C0C0]">
                    {item.quantity} × {inr(item.unitPrice)}
                  </Text>
                </View>
                <Text className="text-[13px] text-[#F5F5F7]" style={{ fontVariant: ['tabular-nums'] }}>
                  {inr(item.quantity * item.unitPrice)}
                </Text>
              </View>
            )}
          />

          <View className="mb-4 flex-row items-center justify-between border-t border-[#C0C0C022] pt-4">
            <View>
              <Text className="text-[10px] uppercase tracking-[2px] text-[#C0C0C0]">Total</Text>
              <Text
                className="text-2xl text-[#D4AF37]"
                style={{ fontFamily: 'Inter-SemiBold', fontVariant: ['tabular-nums'] }}
              >
                {inr(cartTotal)}
              </Text>
            </View>
            <Pressable
              className="rounded-lg px-6 py-3 active:opacity-80"
              style={{ backgroundColor: cart.length ? GOLD : '#C5A05933' }}
              disabled={busy || cart.length === 0}
              onPress={() => void checkout()}
              accessibilityRole="button"
            >
              <Text className="text-xs font-semibold tracking-wider text-[#0B0C10]">CHARGE</Text>
            </Pressable>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
};

export default ScanScreen;
