import { getDb } from './chargerDirectory.js';

// ROI & Operational Analytics aggregator (UOW-06 Task 6.6). Scans the
// alert_incident_log written by the triage service and converts incident
// lifecycles into the four demo business metrics.

const UNMONITORED_BASELINE_HOURS = 48; // 2-day industry baseline without NOC monitoring
const REVENUE_RATE_PER_HOUR = 45.0; // commercial fast-charge port revenue
const TRUCK_ROLL_COST = 250.0; // dispatch intercepted by the topology filter
const TRIAGE_HOURS_PER_BRIEF = 0.5; // manual portal-check time replaced per brief

const EXTERNAL_CAUSES = ['EXTERNAL_GRID_FAILURE', 'EXTERNAL_NETWORK_DROP'];

const hoursBetween = (a, b) => (new Date(b) - new Date(a)) / 3_600_000;

export function getRoiAnalytics() {
  const database = getDb();

  const closed = database
    .prepare('SELECT created_at, resolved_at FROM alert_incident_log WHERE resolved_at IS NOT NULL')
    .all();
  const { briefCount } = database
    .prepare('SELECT COUNT(*) AS briefCount FROM alert_incident_log')
    .get();
  const { activeCount } = database
    .prepare('SELECT COUNT(*) AS activeCount FROM alert_incident_log WHERE resolved_at IS NULL')
    .get();
  const { truckRollCount } = database
    .prepare(
      `SELECT COUNT(*) AS truckRollCount FROM alert_incident_log
       WHERE cause_class IN (${EXTERNAL_CAUSES.map(() => '?').join(', ')})`
    )
    .get(...EXTERNAL_CAUSES);

  let recoveredRevenue = 0;
  let recoveredIncidents = 0;
  let totalResolutionHours = 0;
  for (const row of closed) {
    const duration = hoursBetween(row.created_at, row.resolved_at);
    totalResolutionHours += duration;
    if (duration < UNMONITORED_BASELINE_HOURS) {
      recoveredRevenue += (UNMONITORED_BASELINE_HOURS - duration) * REVENUE_RATE_PER_HOUR;
      recoveredIncidents += 1;
    }
  }

  const mttrHours = closed.length ? totalResolutionHours / closed.length : null;

  return {
    generatedAt: new Date().toISOString(),
    incidents: { total: briefCount, active: activeCount, resolved: closed.length },
    recoveredRevenue: {
      usd: Math.round(recoveredRevenue * 100) / 100,
      incidents: recoveredIncidents,
      baselineHours: UNMONITORED_BASELINE_HOURS,
      ratePerHour: REVENUE_RATE_PER_HOUR,
    },
    avoidedTruckRolls: {
      count: truckRollCount,
      usd: truckRollCount * TRUCK_ROLL_COST,
      baseRate: TRUCK_ROLL_COST,
    },
    triageLabor: {
      briefCount,
      hoursSaved: briefCount * TRIAGE_HOURS_PER_BRIEF,
      hoursPerBrief: TRIAGE_HOURS_PER_BRIEF,
    },
    mttr: {
      resolvedIncidents: closed.length,
      averageHours: mttrHours === null ? null : Math.round(mttrHours * 100) / 100,
      averageMinutes: mttrHours === null ? null : Math.round(mttrHours * 60 * 10) / 10,
      baselineHours: UNMONITORED_BASELINE_HOURS,
      reductionPercent:
        mttrHours === null
          ? null
          : Math.round((1 - mttrHours / UNMONITORED_BASELINE_HOURS) * 1000) / 10,
    },
  };
}
