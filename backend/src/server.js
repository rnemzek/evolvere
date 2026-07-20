// UOW-22.2 deploy trigger
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initFleetState,
  getFleetStatus,
  getSessionHistory,
  getLiveTelemetry,
  toggleConnectorStatus,
  onFleetChange,
} from './services/chargerService.js';
import { sendCriticalAlert } from './services/smsNotifier.js';
import { initDirectory, getDirectory, syncDirectory, getTopology, DB_FILE } from './services/chargerDirectory.js';
import {
  triggerEvent,
  resolveEvent,
  listEvents,
  getEnvironmentStatus,
  initSimulator,
  startDegradationLoop,
  getTelemetrySeries,
} from './services/environmentalSimulator.js';
import { enrichAlertOnChange, getAlertBriefs, initTriage } from './services/triageService.js';
import { getRoiAnalytics } from './services/analyticsService.js';
import { getFinancialMatrix, initTariffEngine } from './services/tariffEngine.js';
import { initNationalIngestion, getSpatialClusters } from './services/dataIngestionService.js';
import { ensureAfdcSchema } from './services/afdcSchema.js';
import { initAfdcIngestion, getRegistryProfile, locateRegistry, backfillGeocodePrecision } from './services/afdcIngest.js';
import { ensureAlertSchema, onIncidentEvent, raiseAlert, clearAlerts, listOpenLedger } from './services/alertManager.js';
import { initGridOutages, listGridOutages, syncGridOutages } from './services/gridOutageService.js';
import { ensureWorkQueueSchema, listTasks, getQueueSummary, markDispatched } from './services/workQueueService.js';
import {
  ensureSpatialCorrectionsSchema,
  listCorrections,
  applyCorrection,
  runLelandReconciliationSweep,
  startSpatialReconciliation,
} from './services/spatialCorrections.js';

const app = express();
const PORT = process.env.PORT || 3001;

const OCPP_STATUSES = [
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEVSE',
  'Finishing',
  'Faulted',
  'Offline',
];

const sseClients = new Set();

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

// Alert subscriptions persist to disk so registrations survive backend restarts.
const DATA_DIR = path.join(SRC_DIR, 'data');
const SUBSCRIBERS_FILE = path.join(DATA_DIR, 'alertSubscribers.json');
const alertSubscribers = new Set();

async function loadSubscribers() {
  try {
    const stored = JSON.parse(await readFile(SUBSCRIBERS_FILE, 'utf8'));
    for (const phoneNumber of stored) alertSubscribers.add(phoneNumber);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not load subscribers: ${err.message}`);
  }
}

async function saveSubscribers() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SUBSCRIBERS_FILE, JSON.stringify([...alertSubscribers], null, 2));
}

app.use(cors());
// Gzip all text/json egress (static assets, lazy SPA chunks, API JSON). SSE
// must be excluded: compression buffers the stream and events would never
// flush to connected dashboards. Task 10.3 hardening: the filter now checks
// the outbound Content-Type header as well as the route path and request
// Accept header, so any future event-stream route is bypassed automatically.
function isEventStream(req, res) {
  return (
    req.path === '/api/v1/fleet/stream' ||
    req.headers.accept === 'text/event-stream' ||
    String(res.getHeader('Content-Type') ?? '').includes('text/event-stream')
  );
}

app.use(
  compression({
    filter: (req, res) => (isEventStream(req, res) ? false : compression.filter(req, res)),
  })
);
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'obszilla-backend', timestamp: new Date().toISOString() });
});

app.get('/api/v1/fleet/status', async (_req, res) => {
  try {
    res.json(await getFleetStatus());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/v1/fleet/history', async (_req, res) => {
  try {
    res.json(await getSessionHistory());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/v1/fleet/telemetry/:transactionId', async (req, res) => {
  try {
    const telemetry = await getLiveTelemetry(req.params.transactionId);
    if (telemetry.meterValues && telemetry.meterValues.length === 0) {
      return res.status(404).json({ error: `No telemetry for transaction ${req.params.transactionId}` });
    }
    res.json(telemetry);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Live state stream (SSE) ------------------------------------------------

app.get('/api/v1/fleet/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify(await getFleetStatus())}\n\n`);

  sseClients.add(res);
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

// UOW-12 Task 12.2: unified-ledger fault injection vector (simulator hooks and
// demo drivers raise through here; dedupe + SSE fan-out happen in the service).
app.post('/api/v1/internal/raise-alert', (req, res) => {
  const { stationId, type, severity, message } = req.body ?? {};
  try {
    res.json(raiseAlert({ stationId, type, severity, message }));
  } catch (err) {
    res.status(err instanceof TypeError ? 400 : 500).json({ error: err.message });
  }
});

// UOW-12 Task 12.3: healthy-signal vector — auto-closes the station's OPEN
// incidents (optionally narrowed to one alert_type) and fans INCIDENT_RESOLVED
// frames down the SSE bridge.
app.post('/api/v1/internal/clear-alerts', (req, res) => {
  const { stationId, type } = req.body ?? {};
  try {
    const resolved = clearAlerts({ stationId, type: type ?? null });
    res.json({ resolvedCount: resolved.length, resolved });
  } catch (err) {
    res.status(err instanceof TypeError ? 400 : 500).json({ error: err.message });
  }
});

// --- Demo state driver --------------------------------------------------------

app.post('/api/v1/internal/toggle-status', async (req, res) => {
  const { chargerId, connectorId, targetStatus, lastErrorCode } = req.body ?? {};
  if (!chargerId || connectorId === undefined || !targetStatus) {
    return res.status(400).json({ error: 'chargerId, connectorId and targetStatus are required' });
  }
  if (!OCPP_STATUSES.includes(targetStatus)) {
    return res.status(400).json({ error: `targetStatus must be one of: ${OCPP_STATUSES.join(', ')}` });
  }
  try {
    const snapshot = await toggleConnectorStatus({ chargerId, connectorId, targetStatus, lastErrorCode });
    res.json(snapshot);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// --- Shadow-ingestion directory (UOW-06) --------------------------------------
// Real public charger locations discovered via OpenChargeMap, cached in SQLite.

app.get('/api/v1/directory/chargers', (_req, res) => {
  try {
    res.json(getDirectory());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/v1/topology', (_req, res) => {
  try {
    res.json(getTopology());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/directory/sync', async (req, res) => {
  const { latitude, longitude, distanceKm, maxResults } = req.body ?? {};
  const overrides = {};
  for (const [key, value] of Object.entries({ latitude, longitude, distanceKm, maxResults })) {
    if (value !== undefined) {
      if (!Number.isFinite(Number(value))) {
        return res.status(400).json({ error: `${key} must be numeric` });
      }
      overrides[key] = Number(value);
    }
  }
  try {
    res.json(await syncDirectory(overrides));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Environmental Event Simulator (UOW-06 Task 6.3) ---------------------------
// Regional outage triggers across the infrastructure topology; synthetic fleet
// faults cascade through the standard SSE/alert pipeline.

app.get('/api/v1/simulator/events', (req, res) => {
  try {
    res.json({ events: listEvents({ includeResolved: req.query.includeResolved === '1' }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/simulator/trigger', async (req, res) => {
  try {
    res.json(await triggerEvent(req.body ?? {}));
  } catch (err) {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  }
});

app.post('/api/v1/simulator/resolve', async (req, res) => {
  const { eventId } = req.body ?? {};
  if (!eventId) return res.status(400).json({ error: 'eventId is required' });
  try {
    res.json(await resolveEvent(eventId));
  } catch (err) {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  }
});

app.get('/api/v1/environment/status', (_req, res) => {
  try {
    res.json(getEnvironmentStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Continuous degradation time-series (UOW-08 Task 8.1): per-connector telemetry
// ticks persisted by the background pipeline, read here for diagnostic charting.
app.get('/api/v1/fleet/telemetry-series/:chargerId/:connectorId', (req, res) => {
  const limit = req.query.limit === undefined ? 120 : Number(req.query.limit);
  if (!Number.isFinite(limit) || limit <= 0) {
    return res.status(400).json({ error: 'limit must be a positive number' });
  }
  try {
    res.json({
      chargerId: req.params.chargerId,
      connectorId: Number(req.params.connectorId),
      ticks: getTelemetrySeries({
        chargerId: req.params.chargerId,
        connectorId: req.params.connectorId,
        limit,
      }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- SMS alert subscriptions --------------------------------------------------

app.get('/api/v1/fleet/subscriptions', (_req, res) => {
  res.json({ subscribers: [...alertSubscribers] });
});

app.post('/api/v1/fleet/subscribe', async (req, res) => {
  const phoneNumber = (req.body?.phoneNumber ?? '').trim();
  if (!/^\+?[0-9\s\-().]{7,20}$/.test(phoneNumber)) {
    return res.status(400).json({ error: 'A valid phone number is required' });
  }
  alertSubscribers.add(phoneNumber);
  try {
    await saveSubscribers();
  } catch (err) {
    console.error(`Could not persist subscribers: ${err.message}`);
  }
  res.json({
    subscribed: phoneNumber,
    subscriberCount: alertSubscribers.size,
    subscribers: [...alertSubscribers],
  });
});

// Pre-computed AI Diagnostic Briefs (UOW-06 Task 6.5): enriched synchronously
// on every fault, read here with zero generation latency.
app.get('/api/v1/alerts/briefs', (_req, res) => {
  try {
    res.json({ briefs: getAlertBriefs() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UOW-13 Task 13.1: Alert Desk hydration read — OPEN incidents only, CRITICAL
// first then latest activity, riding the idx_alerts_open_ledger partial index
// (the (station_id, status) index can't serve a station-agnostic status scan).
app.get('/api/v1/alerts/ledger', (req, res) => {
  const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    return res.status(400).json({ error: 'limit must be a positive number' });
  }
  try {
    const alerts = listOpenLedger(limit === undefined ? {} : { limit });
    res.json({ count: alerts.length, alerts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ROI & Operational Analytics aggregator (UOW-06 Task 6.6).
app.get('/api/v1/analytics/roi', (_req, res) => {
  try {
    res.json(getRoiAnalytics());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 'Earning vs. Burning' financial matrix (UOW-09 Task 9.3): tariff-engine
// profiles sorted netMargin ascending — deepest cash burners first. ?limit=
// truncates worst-first now that the national ledger holds ~5k stations.
app.get('/api/v1/financials/matrix', (req, res) => {
  const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    return res.status(400).json({ error: 'limit must be a positive number' });
  }
  try {
    res.json(getFinancialMatrix({ limit }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UOW-14 Task 14.1: live registry profile for the SPA header — station count,
// state coverage, and the planned/offline breakdown straight from SQLite.
app.get('/api/v1/registry/profile', (_req, res) => {
  try {
    res.json(getRegistryProfile());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UOW-15 Task 15.2: Go To Location — resolves a city/state/zip query against
// the local AFDC registry and returns the matched set's bounding box for a
// client-side viewport snap. No external geocoding dependency.
app.get('/api/v1/registry/locate', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });
  try {
    const found = locateRegistry(q);
    if (!found) return res.status(404).json({ error: `No registry match for "${q}"` });
    res.json(found);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UOW-16 Task 16.1: current county-scoped power-grid outage picture, refreshed
// through the tiered live-feed → cached-snapshot → deterministic-simulation
// pipeline and persisted in SQLite alongside the AFDC registry.
app.get('/api/v1/grid/outages', (_req, res) => {
  try {
    res.json(listGridOutages());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual refresh vector: forces the tiered pipeline outside the 15-min cadence
// (operator "refresh now" and the 16.3 overlay's retry path).
app.post('/api/v1/grid/outages/sync', async (_req, res) => {
  try {
    res.json(await syncGridOutages());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// UOW-17 Task 17.2: Geospatial MDM — manual + background-geocoder coordinate
// overrides that ride a COALESCE join into the spatial-cluster engine
// (dataIngestionService.js) with zero extra round-trip on the map's hot path.
app.get('/api/v1/registry/spatial-corrections', (_req, res) => {
  try {
    res.json({ corrections: listCorrections() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/registry/spatial-corrections', (req, res) => {
  const { afdcId, correctedLat, correctedLng } = req.body ?? {};
  try {
    res.json(
      applyCorrection({
        afdcId: Number(afdcId),
        correctedLat: Number(correctedLat),
        correctedLng: Number(correctedLng),
        source: 'manual',
      })
    );
  } catch (err) {
    res.status(err instanceof TypeError ? 400 : 500).json({ error: err.message });
  }
});

// Manual trigger for the Leland-scoped Look-Near/Look-Far Overpass sweep,
// outside its normal cadence (operator "reconcile now").
app.post('/api/v1/registry/spatial-corrections/reconcile', async (_req, res) => {
  try {
    res.json(await runLelandReconciliationSweep());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// UOW-17 Task 17.3: RCA Operational Work Queue — the NOC Dispatch Board's read
// + action surface. Tasks are raised by the triage RCA correlator (TRUCK_ROLL
// for isolated hardware faults, UTILITY_TICKET/ISP_TICKET for confirmed
// regional outages) and closed automatically once the underlying alert clears.
app.get('/api/v1/work-queue/tasks', (req, res) => {
  const status = req.query.status ? String(req.query.status).toUpperCase() : null;
  try {
    res.json({ tasks: listTasks({ status }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/v1/work-queue/summary', (_req, res) => {
  try {
    res.json(getQueueSummary());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/work-queue/tasks/:id/dispatch', (req, res) => {
  const taskId = Number(req.params.id);
  if (!Number.isInteger(taskId)) return res.status(400).json({ error: 'task id must be an integer' });
  try {
    const task = markDispatched(taskId);
    if (!task) {
      return res.status(409).json({ error: `Task ${taskId} is not OPEN (already dispatched/closed, or unknown)` });
    }
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// National viewport stream (UOW-09 Task 9.2): bounding-box filter + server-side
// grid-bucket clustering below zoom 10 so Leaflet holds its 60 FPS budget.
app.get('/api/v1/fleet/spatial-cluster', (req, res) => {
  const bounds = {};
  for (const key of ['minLat', 'maxLat', 'minLng', 'maxLng', 'zoom']) {
    const value = Number(req.query[key]);
    if (!Number.isFinite(value)) {
      return res.status(400).json({ error: `${key} is required and must be numeric` });
    }
    bounds[key] = value;
  }
  try {
    res.json(getSpatialClusters(bounds));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Alert dispatcher: enrich the persistent triage brief first (synchronous, so
// it is queryable before clients react), then broadcast to SSE clients; on new
// faults, fan critical alerts out to subscribers. TELEMETRY_TICK batches from
// the degradation pipeline broadcast only — they carry no status transition,
// so brief upsert/delete and SMS fan-out must not fire on them.
// UOW-08 Task 8.2: the consolidation layer's result rides the stream as a
// named `alert-update` SSE event carrying occurrenceCount, so the frontend can
// react visually to repeating/flapping faults. Consolidated repeats (same
// charger/connector/code) increment in place and suppress the SMS fan-out —
// only genuinely new or reclassified alerts page subscribers.
function registerAlertDispatcher() {
  onFleetChange(({ snapshot, event }) => {
    let alertUpdate = null;
    if (event.kind !== 'TELEMETRY_TICK') {
      try {
        alertUpdate = enrichAlertOnChange({ snapshot, event });
      } catch (err) {
        console.error(`Alert brief enrichment failed: ${err.message}`);
      }
    }

    const payload = `data: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of sseClients) {
      client.write(payload);
    }

    if (alertUpdate) {
      // Task 8.3: correlator upgrades of peer briefs ride the same named
      // event as ALERT_UPGRADED frames, after the triggering alert's own frame.
      const frames = [alertUpdate, ...(alertUpdate.upgraded ?? [])];
      for (const frame of frames) {
        const alertPayload =
          `event: alert-update\n` +
          `data: ${JSON.stringify({
            action: frame.action,
            occurrenceCount: frame.alert.occurrenceCount,
            lastSeenAt: frame.alert.lastSeenAt,
            alert: frame.alert,
          })}\n\n`;
        for (const client of sseClients) {
          client.write(alertPayload);
        }
      }
    }

    const isThrottledRepeat = alertUpdate?.action === 'ALERT_CONSOLIDATED';
    if ((event.targetStatus === 'Faulted' || event.targetStatus === 'Offline') && !isThrottledRepeat) {
      for (const phoneNumber of alertSubscribers) {
        sendCriticalAlert(phoneNumber, {
          chargerId: event.chargerId,
          fault: event.lastErrorCode ?? 'Faulted',
        }).catch((err) => console.error(`SMS dispatch to ${phoneNumber} failed: ${err.message}`));
      }
    }
  });
}

// --- Production SPA hosting ----------------------------------------------------
// NODE_ENV=production always mounts the built frontend (Railway single-service
// deploy); outside production the mount also activates when a dist build exists,
// so local production-build verification keeps working. Otherwise the Vite dev
// proxy owns the frontend.

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DIST_DIR = path.join(SRC_DIR, '..', '..', 'frontend', 'dist');
const DIST_BUILD_PRESENT = existsSync(path.join(DIST_DIR, 'index.html'));
const SPA_HOSTING = IS_PRODUCTION || DIST_BUILD_PRESENT;

if (SPA_HOSTING) {
  app.use(
    express.static(DIST_DIR, {
      setHeaders: (res, filePath) => {
        // Vite emits content-hashed filenames under assets/ — cache immutably;
        // everything else (index.html, favicons) must revalidate every load.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    })
  );

  // Wild-card catch-all: forward every non-API path to the SPA shell so
  // client-side routes resolve on hard refresh.
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(DIST_DIR, 'index.html'), (err) => {
      if (err) res.status(404).json({ error: 'SPA build not found — run npm run build' });
    });
  });
}

await initFleetState();
await loadSubscribers();
await initDirectory();
await initSimulator();
ensureWorkQueueSchema();
console.log('[boot] work queue schema ready | RCA dispatch board: TRUCK_ROLL / UTILITY_TICKET / ISP_TICKET');
initTriage(await getFleetStatus());
const afdcSchema = ensureAfdcSchema();
console.log(
  `[boot] AFDC registry schema ready | spatial index: ${afdcSchema.rtree ? 'R*Tree + sync triggers' : 'B-Tree fallback'}`
);
const afdcBoot = await initAfdcIngestion();
console.log(
  `[boot] AFDC registry: ${afdcBoot.stations ?? afdcBoot.ingested} stations | source: ${afdcBoot.source} | verified: ${afdcBoot.verified}`
);
// UOW-21: bounded geocoding-cleanse pass — picks up wherever the last boot
// left off (afdc_id order), so precision_score coverage climbs a little on
// every restart without blocking startup on the full fleet's 1 req/sec
// rate limit. Non-fatal: a network hiccup here should never crash boot.
backfillGeocodePrecision()
  .then((result) =>
    console.log(`[boot] geocoding-cleanse pass: ${result.geocoded}/${result.attempted} stations resolved to ROOFTOP_INTERPOLATED`)
  )
  .catch((err) => console.warn(`[boot] geocoding-cleanse pass failed (non-fatal): ${err.message}`));
ensureSpatialCorrectionsSchema();
startSpatialReconciliation();
ensureAlertSchema();
console.log('[boot] alert ledger schema ready | unified incident store: alerts + idx_alerts_station_status');
// Task 12.2 SSE bridge: every post-commit ledger event (opened / consolidated /
// resolved) rides the live stream as a named `incident-update` frame, so the
// Alert Desk can bump row counts and event_count chips without a refresh.
onIncidentEvent(({ action, alert }) => {
  const frame =
    `event: incident-update\n` +
    `data: ${JSON.stringify({ action, eventCount: alert.eventCount, lastSeenAt: alert.lastSeenAt, alert })}\n\n`;
  for (const client of sseClients) {
    client.write(frame);
  }
});
const outageBoot = await initGridOutages();
console.log(
  `[boot] grid outages: ${outageBoot.counties} counties | source: ${outageBoot.source} | ` +
  `${outageBoot.critical} CRITICAL / ${outageBoot.warning} WARNING / ${outageBoot.info} INFO | verified: ${outageBoot.verified}`
);
if (outageBoot.correlation) {
  console.log(
    `[boot] outage correlation: ${outageBoot.correlation.ledgerCounties} ledger counties | ` +
    `${outageBoot.correlation.opened} opened / ${outageBoot.correlation.consolidated} consolidated / ` +
    `${outageBoot.correlation.resolved} auto-resolved | ${outageBoot.correlation.stationsInImpact} AFDC stations in impact radii`
  );
}
await initNationalIngestion();
initTariffEngine();
// Dispatcher registers only after boot re-hydration: restart re-faults must not
// inflate occurrence counters or re-page SMS subscribers; initTriage has
// already reconciled the brief cache without counting (countOccurrence: false).
registerAlertDispatcher();
startDegradationLoop();

app.listen(PORT, () => {
  console.log(`obszilla backend listening on port ${PORT}`);
  console.log(`[boot] mode=${process.env.NODE_ENV ?? 'development'} | compression=gzip (SSE stream excluded)`);
  console.log(
    '[boot] degradation pipeline: 5s continuous telemetry ticks | thresholds: <200V sag, >85°C | SQLite telemetry_ticks + SSE broadcast'
  );
  console.log(
    `[boot] SPA hosting: ${
      SPA_HOSTING
        ? `${DIST_DIR} (${IS_PRODUCTION ? 'NODE_ENV=production' : 'dist build detected'}) | assets cached immutable, shell no-cache`
        : 'disabled — no dist build; frontend served by Vite dev proxy'
    }`
  );
  console.log(`[boot] directory DB: ${DB_FILE} (SQLite via node:sqlite)`);
  console.log(
    `[boot] OpenChargeMap: ${
      process.env.OCM_API_KEY
        ? 'OCM_API_KEY present — live discovery enabled, seed fixture on failure'
        : 'no OCM_API_KEY — seed-fixture fallback active'
    } | Zero Impact fleet token: ${process.env.ZERO_IMPACT_API_TOKEN ? 'present' : 'absent (mock fleet profile)'}`
  );
});
