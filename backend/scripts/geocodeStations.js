// UOW-21/22: standalone high-precision batch geocoding backfill.
//
// Targets stations never geocode-attempted (geocoded_latitude IS NULL), or
// matching --zip/--state for a scoped pass, cleanses each address, resolves
// a coordinate through the tiered Census -> Nominatim engine at 1 req/sec,
// and writes it into afdc_stations. Shares geocodeEngine.js with the ingest
// pipeline's own inline backfillGeocodePrecision() step, so a station's
// coordinate always comes from the exact same lookup regardless of which
// path resolved it.
//
// UOW-22 Task 22.2 (dual-coordinate persistence): the geocode result always
// lands in geocoded_latitude/geocoded_longitude. It's only promoted into the
// active latitude/longitude/precision_score when the station has no native
// AFDC point (afdc_geocode_status = 'MISSING') — a station with a native
// point keeps that as its active pin, and the geocode result sits alongside
// it purely as an independent cross-check value.
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

  const clauses = ['geocoded_latitude IS NULL'];
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

  const storeGeocodedOnly = database.prepare(
    'UPDATE afdc_stations SET geocoded_latitude = ?, geocoded_longitude = ? WHERE afdc_id = ?'
  );
  const promoteToActive = database.prepare(
    `UPDATE afdc_stations
     SET geocoded_latitude = ?, geocoded_longitude = ?, latitude = ?, longitude = ?, precision_score = ?
     WHERE afdc_id = ?`
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
    const hasNative = station.afdc_geocode_status === 'PRESENT';
    if (hasNative) {
      storeGeocodedOnly.run(result.lat, result.lng, station.afdc_id);
    } else {
      promoteToActive.run(result.lat, result.lng, result.lat, result.lng, result.precisionScore, station.afdc_id);
    }
    geocoded += 1;
    console.log(
      `  [ok]   AFDC-${station.afdc_id} "${station.station_name}" — ` +
      `geocoded ${result.lat.toFixed(6)}, ${result.lng.toFixed(6)} (${result.source}, ${result.precisionScore})` +
      `${hasNative ? ' [stored as cross-check; native AFDC point stays active]' : ' [promoted to active pin]'}`
    );
  }

  console.log(`geocodeStations: complete — ${geocoded} geocoded, ${skipped} skipped, ${targets.length} total`);
}

main().catch((err) => {
  console.error('geocodeStations: fatal error', err);
  process.exitCode = 1;
});
