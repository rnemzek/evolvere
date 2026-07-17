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

export function subscribeToAlerts(phoneNumber) {
  return postJson('/api/v1/fleet/subscribe', { phoneNumber });
}

export function fetchAlertSubscriptions() {
  return getJson('/api/v1/fleet/subscriptions');
}
