# ApnaKhata — Mobile App

React Native + TypeScript + NativeWind. Two screens ship today: the
**Dashboard** (credit passport, cash flow, forecast-driven stock alerts with
one-tap reorder) and **Scan & Bill** (camera barcode scanning for billing and
batch/expiry stock-in).

Rendered previews live in [`docs/assets/`](../docs/assets/) and are embedded
in the root README — GitHub cannot execute a React Native app, so those SVGs
are the in-repo preview.

## Run it

```bash
cd mobile
npm install

# Android (device or emulator with USB debugging / AVD running)
npm run android

# iOS (macOS + Xcode + CocoaPods)
cd ios && pod install && cd ..
npm run ios
```

Native project folders (`android/`, `ios/`) are generated on first build by
React Native's CLI template if missing:

```bash
npx @react-native-community/cli init ApnaKhata --skip-install   # scaffold natives once
```

The Scan screen needs the camera permission entries
(`NSCameraUsageDescription` on iOS, `android.permission.CAMERA` on Android)
required by `react-native-vision-camera` v4 — see that library's setup guide.

## Structure

| Path | Purpose |
| --- | --- |
| `App.tsx` | Two-tab shell (Dashboard / Scan & Bill). |
| `src/screens/DashboardScreen.tsx` | Credit score arc, cash flow, stock alerts + one-tap reorder. |
| `src/screens/ScanScreen.tsx` | vision-camera v4 barcode scanning: billing cart + stock-in. |
| `src/api/client.ts` | Typed client for the backend gateway. |
| `tailwind.config.js` | NativeWind theme with the design tokens from `docs/ARCHITECTURE.md`. |
