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
 * Cleanses a station's address and resolves a rooftop/street coordinate
 * through the tiered lookup. Returns null (caller keeps the station's
 * existing coordinate) when the address is unusable or both tiers fail —
 * e.g. a synthesized-seed station's fabricated street address, or a live
 * network outage in this dev sandbox (both tiers are expected to succeed on
 * Railway's network).
 */
export async function geocodeStationAddress(station) {
  const address = buildAddress(station);
  if (!address) return null;

  await throttle();
  try {
    const hit = await geocodeCensus(address);
    if (hit) return { ...hit, precisionScore: 'ROOFTOP_INTERPOLATED', source: 'census', address };
  } catch (err) {
    console.warn(`geocodeEngine: Census tier failed for "${address}" (${err.message})`);
  }

  await throttle();
  try {
    const hit = await geocodeNominatim(address);
    if (hit) return { ...hit, precisionScore: 'ROOFTOP_INTERPOLATED', source: 'nominatim', address };
  } catch (err) {
    console.warn(`geocodeEngine: Nominatim tier failed for "${address}" (${err.message})`);
  }

  return null;
}
