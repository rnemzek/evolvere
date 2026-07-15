# obszilla — Nemzilla NOC (ēvolvere FLEET) Pre-Pilot Prototype

EV charger network operations center prototype. Mock-data-driven SPA + API, Railway-ready.

## Layout

```
frontend/   Vite + React + Tailwind CSS v4 SPA (dev server proxies /api → :3001)
  Map view: Leaflet + CartoDB Dark Matter, animated station markers, metric drawer
  Dashboard view: KPI grid, color-coded Alert Desk, Nemzilla AI Diagnostic Brief
backend/    Express API layer
  src/services/chargerService.js   Repository layer (USE_MOCK_DATA toggle)
  src/mockData/                    OCPP-aligned fleet mock profiles
```

## Commands (repo root)

- `npm install` — install all workspaces
- `npm run dev` — frontend (:5173) + backend (:3001)
- `npm run build` — production frontend build
- `npm start` — backend (respects `PORT`); also serves `frontend/dist` when built, so `npm run build && npm start` is the Railway-ready production run

## API

- `GET /api/health`
- `GET /api/v1/fleet/status` — chargers + connector states
- `GET /api/v1/fleet/history` — past transactions
- `GET /api/v1/fleet/telemetry/:transactionId` — meter-value bursts (404 if unknown)
- `GET /api/v1/fleet/stream` — SSE live fleet snapshots (broadcast on every state change)
- `POST /api/v1/internal/toggle-status` — demo state driver `{ chargerId, connectorId, targetStatus, lastErrorCode }`
- `POST /api/v1/fleet/subscribe` — register `{ phoneNumber }` for critical SMS alerts (Twilio if `TWILIO_*` env vars set, console mock otherwise)

## Live-data swap

Flip `USE_MOCK_DATA` to `false` in `chargerService.js` and set `ZERO_IMPACT_API_TOKEN`; calls drop through to the upstream charger platform API.
