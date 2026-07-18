import { getDb } from './chargerDirectory.js';

// 'Earning vs. Burning' Tariff Engine (UOW-09 Task 9.3): simulated charging
// revenue ($/kWh) versus localized utility operating costs, computed over the
// national_chargers financial ledger in SQLite.

// State utility baselines ($ per kWh). Unknown states settle at DEFAULT.
export const STATE_TARIFF_BASELINES = {
  CA: 0.22,
  NY: 0.19,
  TX: 0.09,
  FL: 0.11,
  IL: 0.15,
};
export const DEFAULT_TARIFF = 0.13;

export const REVENUE_RATE_PER_KWH = 0.45;
export const GRID_SAG_MULTIPLIER = 1.5; // penalty on utility cost while sagging
export const IDLE_PENALTY_PER_MINUTE = 0.5;
export const IDLE_GRACE_MINUTES = 15; // idle penalty engages only past this

// Full-name → code aliases so directory rows with spelled-out states still
// resolve to their baseline.
const STATE_ALIASES = {
  CALIFORNIA: 'CA',
  'NEW YORK': 'NY',
  TEXAS: 'TX',
  FLORIDA: 'FL',
  ILLINOIS: 'IL',
};

export function resolveBaseTariff(state) {
  const key = (state ?? '').trim().toUpperCase();
  const code = STATE_ALIASES[key] ?? key;
  return STATE_TARIFF_BASELINES[code] ?? DEFAULT_TARIFF;
}

/**
 * Financial math for a single station ledger row.
 * Net Margin = (kWh * revenue rate) - ((kWh * base tariff * grid multiplier) + idle penalty)
 */
export function computeStationFinancials({ cumulativeKwh, idleMinutes, activeGridSag, state }) {
  const baseTariff = resolveBaseTariff(state);
  const gridMultiplier = activeGridSag === 1 ? GRID_SAG_MULTIPLIER : 1;
  const grossRevenue = cumulativeKwh * REVENUE_RATE_PER_KWH;
  const utilityCost = cumulativeKwh * baseTariff * gridMultiplier;
  const idlePenalty = idleMinutes > IDLE_GRACE_MINUTES ? idleMinutes * IDLE_PENALTY_PER_MINUTE : 0;
  const operatingCost = utilityCost + idlePenalty;
  return {
    baseTariff,
    gridMultiplier,
    grossRevenue: round2(grossRevenue),
    utilityCost: round2(utilityCost),
    idlePenalty: round2(idlePenalty),
    operatingCost: round2(operatingCost),
    netMargin: round2(grossRevenue - operatingCost),
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Schema patch: national_chargers is owned by the 9.1 national ingestion pipe;
 * until that lands the table is created here (idempotently) so the financial
 * columns have a home. Columns are appended via pragma-guarded ALTERs — the
 * same migration pattern as the 6.2 topology columns — so pre-existing
 * national databases pick them up without a rebuild.
 */
export function ensureFinancialSchema() {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS national_chargers (
      station_id TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      state      TEXT,
      town       TEXT,
      latitude   REAL,
      longitude  REAL
    );
  `);
  const columns = database
    .prepare("SELECT name FROM pragma_table_info('national_chargers')")
    .all()
    .map((c) => c.name);
  if (!columns.includes('cumulative_kwh')) {
    database.exec('ALTER TABLE national_chargers ADD COLUMN cumulative_kwh REAL DEFAULT 0.0');
  }
  if (!columns.includes('idle_minutes')) {
    database.exec('ALTER TABLE national_chargers ADD COLUMN idle_minutes REAL DEFAULT 0.0');
  }
  if (!columns.includes('active_grid_sag')) {
    database.exec('ALTER TABLE national_chargers ADD COLUMN active_grid_sag INTEGER DEFAULT 0');
  }
  return database;
}

// Deterministic PRNG keyed off the station id so simulated financial telemetry
// is stable across restarts (same fleet always yields the same ledger).
function seededRng(seed) {
  let h = (seed >>> 0) || 1;
  return () => {
    h = Math.imul(h ^ (h >>> 15), h | 1);
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Ledger hydration: while the ledger is empty, seed it from the cached
 * directory with deterministic simulated telemetry — session throughput,
 * idle-line accrual, and a sagging-grid flag on roughly a quarter of sites —
 * so 'Cash Burner' rankings are meaningful before the 9.1 national sync.
 */
export function hydrateFinancialLedger() {
  const database = ensureFinancialSchema();
  const { n } = database.prepare('SELECT COUNT(*) AS n FROM national_chargers').get();
  if (n > 0) return { seeded: 0, total: n };

  const sources = database
    .prepare('SELECT ocm_id, name, state, town, latitude, longitude FROM directory_chargers')
    .all();
  const insert = database.prepare(`
    INSERT INTO national_chargers (
      station_id, name, state, town, latitude, longitude,
      cumulative_kwh, idle_minutes, active_grid_sag
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  database.exec('BEGIN');
  try {
    for (const s of sources) {
      const rand = seededRng(s.ocm_id * 2654435761);
      const cumulativeKwh = round2(40 + rand() * 2360); // 40–2400 kWh lifetime throughput
      const idleMinutes = round2(rand() * 70); // 0–70 min on the idle line
      const activeGridSag = rand() < 0.25 ? 1 : 0;
      insert.run(
        `OCM-${s.ocm_id}`, s.name, s.state, s.town, s.latitude, s.longitude,
        cumulativeKwh, idleMinutes, activeGridSag
      );
    }
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
  return { seeded: sources.length, total: sources.length };
}

/**
 * Earning-vs-Burning matrix: every ledger row scored through the tariff math,
 * sorted netMargin ascending so the deepest cash burners surface first.
 * `limit` truncates the response worst-first (count/burnerCount stay
 * fleet-wide) — required now that the 9.1 national pipe holds ~5k rows.
 */
export function getFinancialMatrix({ limit } = {}) {
  const database = ensureFinancialSchema();
  const rows = database
    .prepare(`SELECT station_id, name, state, town, cumulative_kwh, idle_minutes, active_grid_sag
              FROM national_chargers`)
    .all();

  const stations = rows
    .map((row) => {
      const financials = computeStationFinancials({
        cumulativeKwh: row.cumulative_kwh,
        idleMinutes: row.idle_minutes,
        activeGridSag: row.active_grid_sag,
        state: row.state,
      });
      return {
        stationId: row.station_id,
        name: row.name,
        state: row.state,
        town: row.town,
        cumulativeKwh: row.cumulative_kwh,
        idleMinutes: row.idle_minutes,
        activeGridSag: row.active_grid_sag === 1,
        ...financials,
      };
    })
    .sort((a, b) => a.netMargin - b.netMargin);

  const capped = Number.isFinite(limit) && limit > 0 ? stations.slice(0, limit) : stations;

  return {
    count: stations.length,
    returned: capped.length,
    burnerCount: stations.filter((s) => s.netMargin < 0).length,
    tariff: {
      revenueRatePerKwh: REVENUE_RATE_PER_KWH,
      stateBaselines: STATE_TARIFF_BASELINES,
      defaultBaseline: DEFAULT_TARIFF,
      gridSagMultiplier: GRID_SAG_MULTIPLIER,
      idlePenaltyPerMinute: IDLE_PENALTY_PER_MINUTE,
      idleGraceMinutes: IDLE_GRACE_MINUTES,
    },
    stations: capped,
  };
}

/** Boot hook: patch the schema and seed the ledger if it is empty. */
export function initTariffEngine() {
  const { seeded, total } = hydrateFinancialLedger();
  console.log(
    seeded > 0
      ? `Tariff engine: national_chargers ledger seeded with ${seeded} stations`
      : `Tariff engine: national_chargers ledger ready (${total} stations)`
  );
}
