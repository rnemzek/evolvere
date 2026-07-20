// UOW-21: shared high-precision geocoding engine. Both the ingest pipeline's
// inline cleansing step (afdcIngest.js) and the standalone batch backfill
// script (backend/scripts/geocodeStations.js) call this module, so a
// station's coordinate always resolves through the exact same tiered lookup
// no matter which caller triggered it — no per-station special-casing.
//
// Tiers (first hit wins): US Census Geocoder (free, keyless, primary) ->
// Nominatim (free, fallback). Both tiers share one module-level throttle so
// a caller never has to manage its own rate-limit delay, and a burst of
// calls across both tiers still never exceeds 1 req/sec combined.

const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const NOMINATIM_URL =
  process.env.PELIAS_URL || process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
const RATE_LIMIT_MS = 1000;

let lastCallAt = 0;
async function throttle() {
  const wait = lastCallAt + RATE_LIMIT_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCallAt = Date.now();
}

/** Address cleansing: join the four AFDC address fields into one query string. */
export function buildAddress(station) {
  return [station.street_address, station.city, station.state, station.zip]
    .filter((part) => part != null && String(part).trim() !== '')
    .join(', ');
}

/**
 * UOW-22: last-resort fallback query when the full address has no street
 * component (or the full-address lookup found nothing) — zip + state only,
 * which geocodes to a ZIP Code Tabulation Area centroid rather than a real
 * point. Deliberately coarser than the rooftop/street tier, so callers tag
 * a hit from this query 'ZIP_CENTROID' rather than 'ROOFTOP_INTERPOLATED'.
 */
function buildZipCentroidQuery(station) {
  return [station.zip, station.state].filter((part) => part != null && String(part).trim() !== '').join(', ');
}

async function geocodeCensus(address) {
  const params = new URLSearchParams({ address, benchmark: 'Public_AR_Current', format: 'json' });
  const res = await fetch(`${CENSUS_URL}?${params}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Census geocoder responded ${res.status}`);
  const body = await res.json();
  const match = body?.result?.addressMatches?.[0];
  if (!match) return null;
  const lat = Number(match.coordinates?.y);
  const lng = Number(match.coordinates?.x);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

async function geocodeNominatim(address) {
  const params = new URLSearchParams({ q: address, format: 'jsonv2', limit: '1', countrycodes: 'us' });
  const res = await fetch(`${NOMINATIM_URL}?${params}`, {
    headers: {
      Accept: 'application/json',
      // Nominatim's usage policy requires an identifying User-Agent.
      'User-Agent': 'nemzilla-evolvere-grid/1.0 (NOC prototype geocoding pipeline)',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Nominatim responded ${res.status}`);
  const hits = await res.json();
  const hit = Array.isArray(hits) ? hits[0] : null;
  if (!hit) return null;
  const lat = Number(hit.lat);
  const lng = Number(hit.lon ?? hit.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/**
 * Cleanses a station's address and resolves a coordinate through the tiered
 * lookup. Returns null (caller keeps the station's existing coordinate, if
 * any) when there's no usable address/zip at all or every tier fails — e.g.
 * a live network outage in this dev sandbox (all tiers are expected to
 * succeed on Railway's network).
 *
 * UOW-22: three precision tiers, first hit wins —
 *   1. Full street address, Census then Nominatim → 'ROOFTOP_INTERPOLATED'
 *      (only when the station actually has a street_address component; a
 *      "full address" query with no street is really just city/state/zip
 *      and gets tagged at ZIP_CENTROID quality instead — no overclaiming).
 *   2. ZIP + state only, Census then Nominatim → 'ZIP_CENTROID' — the
 *      last-resort fallback when the rooftop tier is unusable or fails.
 */
export async function geocodeStationAddress(station) {
  const address = buildAddress(station);
  const hasStreet = station?.street_address != null && String(station.street_address).trim() !== '';

  if (address) {
    const rooftopScore = hasStreet ? 'ROOFTOP_INTERPOLATED' : 'ZIP_CENTROID';

    await throttle();
    try {
      const hit = await geocodeCensus(address);
      if (hit) return { ...hit, precisionScore: rooftopScore, source: 'census', address };
    } catch (err) {
      console.warn(`geocodeEngine: Census tier failed for "${address}" (${err.message})`);
    }

    await throttle();
    try {
      const hit = await geocodeNominatim(address);
      if (hit) return { ...hit, precisionScore: rooftopScore, source: 'nominatim', address };
    } catch (err) {
      console.warn(`geocodeEngine: Nominatim tier failed for "${address}" (${err.message})`);
    }
  }

  const zipQuery = buildZipCentroidQuery(station);
  if (zipQuery && zipQuery !== address) {
    await throttle();
    try {
      const hit = await geocodeCensus(zipQuery);
      if (hit) return { ...hit, precisionScore: 'ZIP_CENTROID', source: 'census', address: zipQuery };
    } catch (err) {
      console.warn(`geocodeEngine: Census zip-centroid tier failed for "${zipQuery}" (${err.message})`);
    }

    await throttle();
    try {
      const hit = await geocodeNominatim(zipQuery);
      if (hit) return { ...hit, precisionScore: 'ZIP_CENTROID', source: 'nominatim', address: zipQuery };
    } catch (err) {
      console.warn(`geocodeEngine: Nominatim zip-centroid tier failed for "${zipQuery}" (${err.message})`);
    }
  }

  return null;
}
