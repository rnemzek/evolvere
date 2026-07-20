// UOW-21 Task 21.1: standalone high-precision batch geocoding backfill.
//
// Targets stations missing precision_score (or matching --zip/--state, for a
// scoped pass — e.g. the initial Task 21.2 run against ZIP 28451), cleanses
// each address, resolves a rooftop/street coordinate through the tiered
// Census -> Nominatim engine at 1 req/sec, and writes the result straight
// into afdc_stations. Shares geocodeEngine.js with the ingest pipeline's own
// inline backfillGeocodePrecision() step, so a station's coordinate always
// comes from the exact same lookup regardless of which path resolved it.
//
// Usage:
//   node backend/scripts/geocodeStations.js [--zip=28451] [--state=NC] [--limit=50]

import { getDb } from '../src/services/chargerDirectory.js';
import { ensureAfdcSchema } from '../src/services/afdcSchema.js';
import { geocodeStationAddress } from '../src/services/geocodeEngine.js';

function parseArgs(argv) {
  const args = { zip: null, state: null, limit: null };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'zip') args.zip = value;
    if (key === 'state') args.state = value;
    if (key === 'limit') args.limit = Number(value);
  }
  return args;
}

async function main() {
  const { zip, state, limit } = parseArgs(process.argv.slice(2));
  ensureAfdcSchema();
  const database = getDb();

  const clauses = ["(precision_score IS NULL OR precision_score != 'ROOFTOP_INTERPOLATED')"];
  const params = [];
  if (zip) {
    clauses.push('zip = ?');
    params.push(zip);
  }
  if (state) {
    clauses.push('state = ?');
    params.push(state);
  }

  let sql = `SELECT * FROM afdc_stations WHERE ${clauses.join(' AND ')} ORDER BY afdc_id`;
  if (Number.isFinite(limit) && limit > 0) sql += ` LIMIT ${limit}`;
  const targets = database.prepare(sql).all(...params);

  console.log(
    `geocodeStations: ${targets.length} station(s) targeted` +
    `${zip ? ` (zip=${zip})` : ''}${state ? ` (state=${state})` : ''}${limit ? ` (limit=${limit})` : ''}`
  );

  const update = database.prepare(
    'UPDATE afdc_stations SET latitude = ?, longitude = ?, precision_score = ? WHERE afdc_id = ?'
  );

  let geocoded = 0;
  let skipped = 0;
  for (const station of targets) {
    const result = await geocodeStationAddress(station);
    if (!result) {
      skipped += 1;
      console.log(`  [skip] AFDC-${station.afdc_id} "${station.station_name}" — no geocoder match for "${station.street_address ?? ''}, ${station.city ?? ''}, ${station.state ?? ''} ${station.zip ?? ''}"`);
      continue;
    }
    const before = { lat: station.latitude, lng: station.longitude };
    update.run(result.lat, result.lng, result.precisionScore, station.afdc_id);
    geocoded += 1;
    console.log(
      `  [ok]   AFDC-${station.afdc_id} "${station.station_name}" — ` +
      `${before.lat.toFixed(6)}, ${before.lng.toFixed(6)} -> ${result.lat.toFixed(6)}, ${result.lng.toFixed(6)} ` +
      `(${result.source}, ${result.precisionScore})`
    );
  }

  console.log(`geocodeStations: complete — ${geocoded} geocoded, ${skipped} skipped, ${targets.length} total`);
}

main().catch((err) => {
  console.error('geocodeStations: fatal error', err);
  process.exitCode = 1;
});
