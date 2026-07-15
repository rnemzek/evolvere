import express from 'express';
import cors from 'cors';
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

const app = express();
const PORT = process.env.PORT || 3001;

const OCPP_STATUSES = [
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEVSE',
  'Finishing',
  'Faulted',
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

// Alert dispatcher: broadcast every change to SSE clients; on new faults,
// fan critical SMS alerts out to subscribers.
onFleetChange(({ snapshot, event }) => {
  const payload = `data: ${JSON.stringify(snapshot)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }

  if (event.targetStatus === 'Faulted') {
    for (const phoneNumber of alertSubscribers) {
      sendCriticalAlert(phoneNumber, {
        chargerId: event.chargerId,
        fault: event.lastErrorCode ?? 'Faulted',
      }).catch((err) => console.error(`SMS dispatch to ${phoneNumber} failed: ${err.message}`));
    }
  }
});

// --- Production SPA hosting ----------------------------------------------------
// Serve the built frontend when present (Railway single-service deploy); the Vite
// dev server proxy covers local development, where dist/ may not exist.

const DIST_DIR = path.join(SRC_DIR, '..', '..', 'frontend', 'dist');

app.use(express.static(DIST_DIR));
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(DIST_DIR, 'index.html'), (err) => {
    if (err) res.status(404).json({ error: 'SPA build not found — run npm run build' });
  });
});

await initFleetState();
await loadSubscribers();

app.listen(PORT, () => {
  console.log(`obszilla backend listening on port ${PORT}`);
});
