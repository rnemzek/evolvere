async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url} responded ${res.status}`);
  }
  return res.json();
}

export function fetchFleetStatus() {
  return getJson('/api/v1/fleet/status');
}

export function fetchSessionHistory() {
  return getJson('/api/v1/fleet/history');
}

export function fetchLiveTelemetry(transactionId) {
  return getJson(`/api/v1/fleet/telemetry/${encodeURIComponent(transactionId)}`);
}

// UOW-08 Task 8.4: continuous degradation series for the Alert Desk micro-charts.
export function fetchTelemetrySeries(chargerId, connectorId, limit = 60) {
  const q = Number.isFinite(limit) ? `?limit=${limit}` : '';
  return getJson(
    `/api/v1/fleet/telemetry-series/${encodeURIComponent(chargerId)}/${encodeURIComponent(connectorId)}${q}`
  );
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `${url} responded ${res.status}`);
  }
  return res.json();
}

export function postToggleStatus({ chargerId, connectorId, targetStatus, lastErrorCode }) {
  return postJson('/api/v1/internal/toggle-status', {
    chargerId,
    connectorId,
    targetStatus,
    lastErrorCode,
  });
}

export function fetchTopology() {
  return getJson('/api/v1/topology');
}

export function fetchDirectoryChargers() {
  return getJson('/api/v1/directory/chargers');
}

export function fetchEnvironmentStatus() {
  return getJson('/api/v1/environment/status');
}

export function fetchAlertBriefs() {
  return getJson('/api/v1/alerts/briefs');
}

export function fetchRoiAnalytics() {
  return getJson('/api/v1/analytics/roi');
}

// UOW-13 Task 13.1: Alert Desk mount hydration — OPEN incidents from the
// unified ledger, CRITICAL first, newest activity first.
export function fetchAlertLedger(limit) {
  const q = Number.isFinite(limit) ? `?limit=${limit}` : '';
  return getJson(`/api/v1/alerts/ledger${q}`);
}

// UOW-09 Task 9.4: tariff-engine profiles ranked netMargin ascending
// (worst-first truncation via limit — the national ledger holds ~5k rows).
export function fetchFinancialMatrix(limit = 100) {
  const q = Number.isFinite(limit) ? `?limit=${limit}` : '';
  return getJson(`/api/v1/financials/matrix${q}`);
}

// UOW-09 Task 9.2: viewport-bound national fleet — pre-clustered server-side
// below zoom 10 so the map never renders thousands of DOM pins.
export function fetchSpatialClusters({ minLat, maxLat, minLng, maxLng, zoom }) {
  const params = new URLSearchParams({ minLat, maxLat, minLng, maxLng, zoom });
  return getJson(`/api/v1/fleet/spatial-cluster?${params}`);
}

// UOW-14 Task 14.1: live database profile driving the header locality line.
export function fetchRegistryProfile() {
  return getJson('/api/v1/registry/profile');
}

// UOW-15 Task 15.2: Go To Location — resolves city/state/zip queries against
// the AFDC registry, returning a viewport bounding box (404 → thrown Error).
export function fetchRegistryLocate(q) {
  return getJson(`/api/v1/registry/locate?q=${encodeURIComponent(q)}`);
}

// UOW-16 Task 16.4: current county-scoped power-grid outage picture (tiered
// live/snapshot/simulation source) driving the map's Grid Outage wash plane.
export function fetchGridOutages() {
  return getJson('/api/v1/grid/outages');
}

export function subscribeToAlerts(phoneNumber) {
  return postJson('/api/v1/fleet/subscribe', { phoneNumber });
}

export function fetchAlertSubscriptions() {
  return getJson('/api/v1/fleet/subscriptions');
}
