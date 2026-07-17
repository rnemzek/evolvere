// Shared station-health helpers. Lives outside the map component so landing
// bundle consumers (ControlPanel) never drag the Leaflet chunk in statically.
export function isStationFaulted(station) {
  return station.connectors.some((c) => c.status === 'Faulted')
}
