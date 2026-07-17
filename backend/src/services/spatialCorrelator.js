import { resolveFleetTopology } from './environmentalSimulator.js';
import { getGridNode, getIspCarrier, haversineKm } from './infrastructureTopology.js';

// Cross-Layer Spatial Correlator (UOW-08 Task 8.3): when a connector enters a
// Faulted or Offline state, analyze every other fleet station sharing the same
// upstream infrastructure identifier (grid_node_id / isp_carrier_id) or sitting
// within the 3 km haversine neighborhood, and compute an Infrastructure
// Cohesion Score per layer. Crossing the 75% threshold across multiple distinct
// sites definitively isolates a regional carrier drop or grid substation outage
// from what would otherwise triage as localized hardware failure.

export const PROXIMITY_RADIUS_KM = 3;
export const COHESION_THRESHOLD = 0.75;

// Grid layer: any faulted connector marks the site dark.
const isGridDark = (station) => station.connectors.some((c) => c.status === 'Faulted');

// Carrier layer: a site is silent when a connector is Offline or faulted on comms.
const isCarrierSilent = (station) =>
  station.connectors.some(
    (c) => c.status === 'Offline' || (c.status === 'Faulted' && c.lastErrorCode === 'Comms_Loss')
  );

/**
 * Correlate one station's failure against its infrastructure cohort.
 * Returns a verdict (EXTERNAL_GRID_FAILURE | EXTERNAL_NETWORK_DROP | null)
 * plus the per-layer evidence needed to rewrite diagnostic briefs.
 */
export function correlateStation(station, snapshot) {
  const topo = resolveFleetTopology(station);
  const peers = snapshot.stations
    .filter((s) => s.chargerId !== station.chargerId)
    .map((s) => ({
      station: s,
      topo: resolveFleetTopology(s),
      distanceKm: haversineKm(station.location, s.location),
    }));

  const gridPeers = peers.filter((p) => topo.gridNodeId && p.topo.gridNodeId === topo.gridNodeId);
  const carrierPeers = peers.filter(
    (p) => topo.ispCarrierId && p.topo.ispCarrierId === topo.ispCarrierId
  );
  const proximityPeers = peers.filter((p) => p.distanceKm <= PROXIMITY_RADIUS_KM);

  const darkGridPeers = gridPeers.filter((p) => isGridDark(p.station));
  const silentCarrierPeers = carrierPeers.filter((p) => isCarrierSilent(p.station));

  const gridCohesion = gridPeers.length > 0 ? darkGridPeers.length / gridPeers.length : 0;
  const carrierCohesion =
    carrierPeers.length > 0 ? silentCarrierPeers.length / carrierPeers.length : 0;

  // A layer verdict requires the target itself to exhibit that layer's failure
  // mode — silent neighbors alone must not reclassify a ground fault as a
  // carrier outage. "Multiple distinct sites": target plus ≥1 downed peer.
  const targetDark = isGridDark(station);
  const targetSilent = isCarrierSilent(station);
  const gridQualified =
    targetDark && darkGridPeers.length >= 1 && gridCohesion >= COHESION_THRESHOLD;
  const carrierQualified =
    targetSilent && silentCarrierPeers.length >= 1 && carrierCohesion >= COHESION_THRESHOLD;

  // Grid wins ties: a substation loss also silences comms downstream, so equal
  // cohesion on both layers points at power, not the carrier.
  let verdict = null;
  let cohesionScore = 0;
  if (gridQualified && gridCohesion >= carrierCohesion) {
    verdict = 'EXTERNAL_GRID_FAILURE';
    cohesionScore = gridCohesion;
  } else if (carrierQualified) {
    verdict = 'EXTERNAL_NETWORK_DROP';
    cohesionScore = carrierCohesion;
  } else if (gridQualified) {
    verdict = 'EXTERNAL_GRID_FAILURE';
    cohesionScore = gridCohesion;
  }

  return {
    verdict,
    cohesionScore,
    gridNodeId: topo.gridNodeId,
    ispCarrierId: topo.ispCarrierId,
    gridNodeName: getGridNode(topo.gridNodeId)?.name ?? topo.gridNodeId,
    carrierName: getIspCarrier(topo.ispCarrierId)?.name ?? topo.ispCarrierId,
    grid: {
      peerCount: gridPeers.length,
      downCount: darkGridPeers.length,
      cohesion: gridCohesion,
      downSites: darkGridPeers.map((p) => p.station.chargerId),
    },
    carrier: {
      peerCount: carrierPeers.length,
      silentCount: silentCarrierPeers.length,
      cohesion: carrierCohesion,
      silentSites: silentCarrierPeers.map((p) => p.station.chargerId),
    },
    proximity: {
      radiusKm: PROXIMITY_RADIUS_KM,
      peerCount: proximityPeers.length,
      downCount: proximityPeers.filter(
        (p) => isGridDark(p.station) || isCarrierSilent(p.station)
      ).length,
    },
  };
}

/** Compact evidence payload persisted into the brief's context_json. */
export function correlationSummary(correlation) {
  if (!correlation) return null;
  return {
    verdict: correlation.verdict,
    cohesionScore: Math.round(correlation.cohesionScore * 100) / 100,
    threshold: COHESION_THRESHOLD,
    grid: correlation.grid,
    carrier: correlation.carrier,
    proximity: correlation.proximity,
  };
}
