# ApnaKhata — Web Preview (Vercel)

Browser rendering of the mobile app so the UI is viewable at a URL. This is
what the repo's Vercel connection builds (see the root `vercel.json`): a
Vite + React app with the two shipped screens — **Dashboard** and
**Scan & Bill** — inside a phone frame, using the same design tokens and demo
data as `mobile/src/screens/`.

It runs on demo data with simulated interactions (no backend, no camera):
the one-tap reorder animates pending → ordered, and "scanning" is triggered
by the demo product chips. The comments in `src/screens/` mark exactly which
backend endpoint each simulated action maps to in the real app.

## Local dev

```bash
cd web
npm install
npm run dev        # http://localhost:5173
npm run build      # production build → dist/
```

Vercel settings are already encoded in the root `vercel.json`
(`installCommand`/`buildCommand`/`outputDirectory`) — no dashboard
configuration needed; every push to the connected branch redeploys.
