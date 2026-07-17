// Virtual infrastructure registries (UOW-06 Task 6.2).
// Grid sub-nodes and ISP carriers are code-authoritative static dictionaries;
// chargers bind to them deterministically (nearest sub-node centroid for power,
// zip-code district for data link) so co-located chargers always share the
// exact same upstream dependencies.

export const GRID_NODES = [
  {
    id: 'GRID-NODE-OC-TUSTIN-CENTRAL',
    name: 'Tustin Central Substation',
    utility: 'SCE',
    capacityMVA: 28,
    centroid: { latitude: 33.744, longitude: -117.821 },
  },
  {
    id: 'GRID-NODE-OC-TUSTIN-LEGACY',
    name: 'Tustin Legacy Substation',
    utility: 'SCE',
    capacityMVA: 45,
    centroid: { latitude: 33.705, longitude: -117.831 },
  },
  {
    id: 'GRID-NODE-OC-IRVINE-EAST',
    name: 'Irvine East Substation',
    utility: 'SCE',
    capacityMVA: 60,
    centroid: { latitude: 33.652, longitude: -117.748 },
  },
  {
    id: 'GRID-NODE-OC-IRVINE-WEST',
    name: 'Irvine West Substation',
    utility: 'SCE',
    capacityMVA: 52,
    centroid: { latitude: 33.668, longitude: -117.82 },
  },
  {
    id: 'GRID-NODE-OC-SANTA-ANA-METRO',
    name: 'Santa Ana Metro Substation',
    utility: 'SCE',
    capacityMVA: 75,
    centroid: { latitude: 33.752, longitude: -117.87 },
  },
  {
    id: 'GRID-NODE-OC-COSTA-MESA-BRISTOL',
    name: 'Costa Mesa Bristol Substation',
    utility: 'SCE',
    capacityMVA: 38,
    centroid: { latitude: 33.689, longitude: -117.887 },
  },
];

export const ISP_CARRIERS = [
  { id: 'ISP-VERIZON-CELLULAR', name: 'Verizon Cellular', networkType: 'Cellular', technology: '5G/LTE' },
  { id: 'ISP-ATT-BUSINESS', name: 'AT&T Business', networkType: 'Cellular', technology: 'LTE-M' },
  { id: 'ISP-TMOBILE-IOT', name: 'T-Mobile IoT', networkType: 'Cellular', technology: 'NB-IoT/LTE' },
  { id: 'ISP-SPECTRUM-FIBER', name: 'Spectrum Business Fiber', networkType: 'Wireline', technology: 'Fiber' },
];

// Zip-code district → carrier. Co-located sites (same zip) share the data link.
const ZIP_CARRIER_MAP = {
  92617: 'ISP-VERIZON-CELLULAR',
  92618: 'ISP-VERIZON-CELLULAR',
  92701: 'ISP-ATT-BUSINESS',
  92705: 'ISP-ATT-BUSINESS',
  92707: 'ISP-ATT-BUSINESS',
  92780: 'ISP-TMOBILE-IOT',
  92782: 'ISP-TMOBILE-IOT',
  92606: 'ISP-SPECTRUM-FIBER',
  92626: 'ISP-SPECTRUM-FIBER',
  92868: 'ISP-SPECTRUM-FIBER',
};

const gridNodeIndex = new Map(GRID_NODES.map((n) => [n.id, n]));
const ispCarrierIndex = new Map(ISP_CARRIERS.map((c) => [c.id, c]));

export const getGridNode = (id) => gridNodeIndex.get(id) ?? null;
export const getIspCarrier = (id) => ispCarrierIndex.get(id) ?? null;

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Nearest sub-node centroid wins; identical coordinates always resolve identically. */
export function resolveGridNode(latitude, longitude) {
  let best = null;
  let bestDist = Infinity;
  for (const node of GRID_NODES) {
    const dist = haversineKm({ latitude, longitude }, node.centroid);
    if (dist < bestDist) {
      best = node;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Zip district lookup first; unknown zips fall back to a stable hash of the
 * zip/town string so re-runs never reshuffle assignments.
 */
export function resolveIspCarrier(postcode, town) {
  const mapped = ZIP_CARRIER_MAP[String(postcode ?? '').trim()];
  if (mapped) return ispCarrierIndex.get(mapped);

  const key = String(postcode ?? town ?? 'unknown');
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return ISP_CARRIERS[hash % ISP_CARRIERS.length];
}
