import { getDb } from './chargerDirectory.js';
import { boundsQueryParts } from './afdcSchema.js';
import { raiseAlert, clearAlerts, listOpenLedger } from './alertManager.js';
import { getTopology } from './chargerDirectory.js';

// UOW-16 Task 16.3: county-outage ↔ AFDC correlation. Every grid_outages sync
// re-derives which real stations sit inside each outage county's impact
// radius (one COUNT descent through the R*Tree per county — never a row
// fetch) and which virtual grid sub-nodes fall inside it, then feeds the
// unified Alert Management ledger with county-scoped EXTERNAL_GRID_FAILURE
// incidents keyed `GRID-<fips>`. String identities ride the ledger untouched
// (the AFDC name join LEFT-JOINs to null, exactly like legacy OC- ids), so
// dedupe/consolidation, severity escalation, and the incident-update SSE
// fan-out all apply with zero new machinery:
//   county persists across syncs → INCIDENT_CONSOLIDATED (event_count++)
//   county worsens               → severity escalates, never downgrades
//   county recovers / drops out  → clearAlerts → INCIDENT_RESOLVED frames
//
// INFO-grade flickers stay out of the ledger (they'd bury real incidents in
// the desk); they remain visible in the 16.4 overlay plane via
// /api/v1/grid/outages, and a county cooling to INFO auto-resolves here.

export const OUTAGE_ALERT_TYPE = 'EXTERNAL_GRID_FAILURE';
const LEDGER_SEVERITIES = new Set(['CRITICAL', 'WARNING']);
const STATION_ID_PREFIX = 'GRID-';

const KM_PER_DEG_LAT = 111.32;

/** County impact radius → bounding box in degrees around its centroid. */
function impactBounds({ latitude, longitude, radius_km: radiusKm }) {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const dLng = radiusKm / (KM_PER_DEG_LAT * Math.max(0.2, Math.cos((latitude * Math.PI) / 180)));
  return {
    minLat: latitude - dLat,
    maxLat: latitude + dLat,
    minLng: longitude - dLng,
    maxLng: longitude + dLng,
  };
}

/** Stations inside the county impact box — COUNT-only R*Tree descent. */
function countStationsInImpact(outage) {
  const { join, where, params } = boundsQueryParts(impactBounds(outage));
  return getDb()
    .prepare(`SELECT COUNT(*) AS n FROM afdc_stations s ${join} WHERE ${where}`)
    .get(...params).n;
}

/** Virtual grid sub-nodes whose centroid falls inside the impact radius. */
function gridNodesInImpact(outage) {
  const nodes = getTopology()?.gridNodes ?? [];
  return nodes
    .filter((node) => {
      const dLatKm = (node.centroid.latitude - outage.latitude) * KM_PER_DEG_LAT;
      const dLngKm =
        (node.centroid.longitude - outage.longitude) *
        KM_PER_DEG_LAT *
        Math.cos((outage.latitude * Math.PI) / 180);
      return Math.hypot(dLatKm, dLngKm) <= outage.radius_km;
    })
    .map((node) => node.id);
}

function outageMessage(outage, stationCount, nodeIds) {
  const pct = (outage.pct_out * 100).toFixed(1);
  const nodes = nodeIds.length > 0 ? ` · grid nodes: ${nodeIds.join(', ')}` : '';
  return (
    `Power-grid outage — ${outage.county_name} County, ${outage.state} (FIPS ${outage.fips}): ` +
    `${outage.customers_out.toLocaleString()} of ${outage.customers_tracked.toLocaleString()} ` +
    `customers dark (${pct}%) · ${stationCount.toLocaleString()} AFDC stations in impact radius${nodes} · ` +
    `source: ${outage.source}`
  );
}

/**
 * Correlation sweep, called after every grid_outages sync. Raise phase and
 * auto-close phase each ride the ledger's own BEGIN IMMEDIATE transaction
 * discipline per mutation; the sweep itself needs no outer transaction because
 * every step is idempotent against the current outage table.
 */
export function correlateOutages() {
  const database = getDb();
  const outages = database
    .prepare('SELECT * FROM grid_outages ORDER BY fips')
    .all();

  let opened = 0;
  let consolidated = 0;
  let stationsInImpact = 0;
  const activeFips = new Set();

  for (const outage of outages) {
    if (!LEDGER_SEVERITIES.has(outage.severity)) continue;
    const stationCount = countStationsInImpact(outage);
    const nodeIds = gridNodesInImpact(outage);
    stationsInImpact += stationCount;
    activeFips.add(outage.fips);
    const result = raiseAlert({
      stationId: `${STATION_ID_PREFIX}${outage.fips}`,
      type: OUTAGE_ALERT_TYPE,
      severity: outage.severity,
      message: outageMessage(outage, stationCount, nodeIds),
    });
    if (result.action === 'INCIDENT_OPENED') opened += 1;
    else consolidated += 1;
  }

  // Auto-close: any OPEN county incident whose county recovered, cooled to
  // INFO, or vanished from the current picture resolves now.
  let resolved = 0;
  for (const alert of listOpenLedger({ limit: 500 })) {
    if (alert.type !== OUTAGE_ALERT_TYPE || !alert.stationId.startsWith(STATION_ID_PREFIX)) continue;
    const fips = alert.stationId.slice(STATION_ID_PREFIX.length);
    if (!activeFips.has(fips)) {
      resolved += clearAlerts({ stationId: alert.stationId, type: OUTAGE_ALERT_TYPE }).length;
    }
  }

  return {
    counties: outages.length,
    ledgerCounties: activeFips.size,
    opened,
    consolidated,
    resolved,
    stationsInImpact,
  };
}

// Standalone runner: `node src/services/outageCorrelator.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = correlateOutages();
  console.log('Outage correlation sweep complete');
  console.log(`  outage counties:     ${result.counties} (${result.ledgerCounties} at ledger grade)`);
  console.log(`  incidents opened:    ${result.opened} | consolidated: ${result.consolidated} | auto-resolved: ${result.resolved}`);
  console.log(`  AFDC stations in impact radii: ${result.stationsInImpact}`);
}
