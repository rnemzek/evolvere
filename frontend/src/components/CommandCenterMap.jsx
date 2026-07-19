import { useCallback, useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Tooltip, Circle, CircleMarker, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
// Leaflet CSS ships with this lazy chunk, not the landing bundle (Task 7.1).
import 'leaflet/dist/leaflet.css'
import { isStationFaulted } from '../services/stationHealth.js'
import { STATUS_STYLES } from './StationDrawer'
import MapLayerControls from './MapLayerControls.jsx'
import { useEnvironment } from '../hooks/useEnvironment.js'
import { fetchSpatialClusters, fetchRegistryLocate } from '../services/fleetApi.js'

const OC_CENTER = [33.74, -117.82]

// UOW-15 Task 15.2: macro US sector presets — [[south, west], [north, east]]
// viewport bounds the operator can teleport to instantly (no network hop).
const REGION_PRESETS = [
  { id: 'ne', label: 'NE', name: 'Northeast', bounds: [[40.4, -80.6], [47.6, -66.7]] },
  { id: 'midatl', label: 'MID-ATL', name: 'Mid-Atlantic', bounds: [[36.5, -83.7], [41.5, -73.8]] },
  { id: 'se', label: 'SE', name: 'Southeast', bounds: [[24.4, -92.6], [36.7, -75.3]] },
  { id: 'mw', label: 'MW', name: 'Midwest', bounds: [[36.0, -104.1], [49.4, -80.4]] },
  { id: 'west', label: 'WEST', name: 'West Coast', bounds: [[32.3, -124.8], [49.1, -114.0]] },
]

const CARRIER_COLORS = {
  'ISP-VERIZON-CELLULAR': '#fb7185',
  'ISP-ATT-BUSINESS': '#38bdf8',
  'ISP-TMOBILE-IOT': '#e879f9',
  'ISP-SPECTRUM-FIBER': '#fbbf24',
}
const DARK_MATTER_URL =
  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
const DARK_MATTER_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'

function markerIcon(station) {
  const state = isStationFaulted(station) ? 'faulted' : 'healthy'
  return L.divIcon({
    className: '',
    html: `<div class="charger-marker ${state}" role="button" aria-label="${station.siteName}"><span class="ring"></span><span class="dot"></span></div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  })
}

function StationTooltip({ station }) {
  const { latitude, longitude } = station.location
  return (
    <Tooltip
      direction="top"
      offset={[0, -16]}
      opacity={1}
      className="charger-tooltip"
    >
      <div className="min-w-52 space-y-2">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-slate-500">
            Station
          </p>
          <p className="text-sm font-semibold leading-tight text-slate-100">
            {station.siteName}
          </p>
          <p className="font-mono text-xs text-cyan-400">{station.chargerId}</p>
        </div>
        <p className="font-mono text-[11px] text-slate-400">
          {latitude.toFixed(4)}, {longitude.toFixed(4)} · FW{' '}
          {station.firmwareVersion} · OCPP {station.ocppVersion}
        </p>
        <ul className="space-y-1">
          {station.connectors.map((connector) => (
            <li
              key={connector.connectorId}
              className="flex items-center justify-between gap-3 text-xs"
            >
              <span className="text-slate-300">
                #{connector.connectorId} · {connector.type}
              </span>
              <span
                className={`font-semibold px-1.5 py-0.5 rounded-full border text-[10px] ${
                  STATUS_STYLES[connector.status] ??
                  'bg-slate-700 text-slate-300 border-slate-600'
                }`}
              >
                {connector.status}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-[10px] uppercase tracking-wider text-slate-600">
          Tap for full telemetry
        </p>
      </div>
    </Tooltip>
  )
}

/** Grid Power plane: coverage circles around the six substation centroids. */
function GridPowerLayer({ topology, environment }) {
  const statusById = new Map((environment?.gridNodes ?? []).map((n) => [n.id, n]))
  return (topology?.gridNodes ?? []).map((node) => {
    const outage = statusById.get(node.id)?.powerStatus === 'OUTAGE'
    return (
      // pathOptions.className never reaches the SVG (react-leaflet applies
      // updates via setStyle, which ignores it), so the pulse class is added
      // on the layer's `add` event; the key remounts the layer on state flips.
      <Circle
        key={`${node.id}-${outage ? 'outage' : 'nominal'}`}
        center={[node.centroid.latitude, node.centroid.longitude]}
        radius={1600}
        pathOptions={{
          color: outage ? '#f59e0b' : '#34d399',
          weight: outage ? 2.5 : 1.2,
          fillColor: outage ? '#ef4444' : '#34d399',
          fillOpacity: outage ? 0.22 : 0.06,
        }}
        eventHandlers={
          outage
            ? { add: (e) => e.target.getElement()?.classList.add('grid-zone-outage') }
            : undefined
        }
      >
        <Tooltip direction="top" opacity={1} className="charger-tooltip">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-slate-100">{node.name}</p>
            <p className="font-mono text-xs text-slate-400">
              {node.utility} · {node.capacityMVA} MVA · {node.chargerCount} sites
            </p>
            <p className={`text-xs font-bold ${outage ? 'text-red-400' : 'text-emerald-400'}`}>
              {outage ? 'GRID OUTAGE' : 'NOMINAL'}
            </p>
          </div>
        </Tooltip>
      </Circle>
    )
  })
}

/** Network plane: public sites ringed in carrier colors; downed carriers wash out. */
function NetworkLayer({ directory, environment }) {
  const carrierStatus = new Map((environment?.ispCarriers ?? []).map((c) => [c.id, c]))
  const impacted = new Set(environment?.affectedDirectoryChargers ?? [])
  return directory.map((charger) => {
    const carrierId = charger.ispCarrier?.id
    const carrierDown = carrierStatus.get(carrierId)?.networkStatus === 'DOWN'
    const washed = carrierDown || impacted.has(charger.ocmId)
    return (
      <CircleMarker
        key={charger.ocmId}
        center={[charger.location.latitude, charger.location.longitude]}
        radius={9}
        pathOptions={{
          color: washed ? '#64748b' : (CARRIER_COLORS[carrierId] ?? '#94a3b8'),
          weight: 2,
          opacity: washed ? 0.55 : 0.9,
          dashArray: washed ? '4 4' : null,
          fillColor: washed ? '#64748b' : (CARRIER_COLORS[carrierId] ?? '#94a3b8'),
          fillOpacity: washed ? 0.08 : 0.25,
        }}
      >
        <Tooltip direction="top" opacity={1} className="charger-tooltip">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-slate-100">{charger.name}</p>
            <p className="font-mono text-xs text-slate-400">
              {charger.operator} · {charger.ispCarrier?.name ?? 'Unknown carrier'}
            </p>
            <p className={`text-xs font-bold ${washed ? 'text-amber-400' : 'text-emerald-400'}`}>
              {carrierDown ? 'CARRIER DOWN' : impacted.has(charger.ocmId) ? 'IMPACTED' : 'ONLINE'}
            </p>
          </div>
        </Tooltip>
      </CircleMarker>
    )
  })
}

/** Weather plane: bounding circles matching each active zone's broadcast radius. */
function WeatherLayer({ environment }) {
  return (environment?.weatherZones ?? []).map((zone) => (
    <Circle
      key={zone.eventId}
      center={[zone.center.latitude, zone.center.longitude]}
      radius={zone.radiusKm * 1000}
      pathOptions={{
        color: '#a5b4fc',
        weight: 2,
        dashArray: '8 6',
        fillColor: '#818cf8',
        fillOpacity: 0.12,
      }}
    >
      <Tooltip direction="top" opacity={1} className="charger-tooltip">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-slate-100">Severe Weather Zone</p>
          <p className="font-mono text-xs text-slate-400">
            {zone.radiusKm} km radius · {zone.severity}
          </p>
        </div>
      </Tooltip>
    </Circle>
  ))
}

const formatCount = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

// UOW-14 Task 14.1: planned build-outs ('P', `isPlanned` on the wire) are
// blueprints, not faults — they never carry activeGridSag. Only genuinely
// unavailable stations read as operational problems.
const stationStateLabel = (station) => {
  if (station.isPlanned) return ' · PLANNED SITE'
  if (!station.activeGridSag) return ''
  if (station.statusCode === 'T') return ' · STATION OFFLINE'
  return ' · STATION DOWN'
}

function clusterIcon(cluster) {
  const sagging = cluster.sagCount > 0
  // Screen readers get the full telemetry sentence; the visual bubble shows
  // only the compact count. Enter/Space activate via Leaflet marker keyboard
  // support on the focusable wrapper.
  // UOW-14: `sagCount` counts only genuinely offline stations; planned
  // build-outs ride separately as `plannedCount` and never trip the sagging
  // (amber warning) treatment.
  const detail = [
    cluster.sagCount > 0 ? `${cluster.sagCount} offline` : null,
    cluster.plannedCount > 0 ? `${cluster.plannedCount} planned` : null,
  ].filter(Boolean).join(', ')
  const srLabel = detail
    ? `Cluster of ${cluster.count} national stations, ${detail} — activate to zoom in`
    : `Cluster of ${cluster.count} national stations, all open — activate to zoom in`
  return L.divIcon({
    className: '',
    html: `<div class="national-cluster${sagging ? ' sagging' : ''}" role="img" aria-label="${srLabel}">${formatCount(cluster.count)}</div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  })
}

/**
 * National fleet plane (UOW-09 Task 9.2). The Leaflet viewport drives
 * /api/v1/fleet/spatial-cluster on every moveend/zoomend: wide zooms render
 * server-aggregated count bubbles, street zooms render individual pins — the
 * DOM never holds thousands of markers, keeping pans at 60 FPS. A sequence
 * guard drops stale responses that resolve after a newer pan.
 */
function NationalFleetLayer({ onViewportTotal }) {
  const [payload, setPayload] = useState(null)
  const seqRef = useRef(0)

  const refresh = useCallback(
    (mapInstance) => {
      const bounds = mapInstance.getBounds()
      const seq = ++seqRef.current
      fetchSpatialClusters({
        minLat: bounds.getSouth(),
        maxLat: bounds.getNorth(),
        minLng: bounds.getWest(),
        maxLng: bounds.getEast(),
        zoom: mapInstance.getZoom(),
      })
        .then((data) => {
          if (seq !== seqRef.current) return
          setPayload(data)
          onViewportTotal?.(data.total)
        })
        .catch(() => {})
    },
    [onViewportTotal]
  )

  const map = useMapEvents({
    moveend: () => refresh(map),
    zoomend: () => refresh(map),
  })

  useEffect(() => {
    refresh(map)
  }, [map, refresh])

  if (!payload) return null

  if (payload.mode === 'clusters') {
    return payload.clusters.map((cluster) => (
      <Marker
        key={cluster.key}
        position={[cluster.latitude, cluster.longitude]}
        icon={clusterIcon(cluster)}
        keyboard={true}
        alt={`${cluster.count} station cluster`}
        eventHandlers={{
          click: () =>
            map.setView([cluster.latitude, cluster.longitude], Math.min(map.getZoom() + 2, 18)),
        }}
      >
        <Tooltip direction="top" offset={[0, -14]} opacity={1} className="charger-tooltip">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-slate-100">{cluster.count} national stations</p>
            <p className="font-mono text-xs text-slate-400">
              {cluster.sagCount > 0 ? `${cluster.sagCount} offline · ` : ''}
              {cluster.plannedCount > 0 ? `${cluster.plannedCount} planned · ` : ''}tap to zoom
            </p>
          </div>
        </Tooltip>
      </Marker>
    ))
  }

  // Pin palette: teal = open, amber = genuinely offline, and planned sites
  // render as neutral slate-blue blueprint outlines (dashed, low fill) so a
  // future build-out never reads as an active system failure.
  return payload.stations.map((station) => (
    <CircleMarker
      key={station.stationId}
      center={[station.latitude, station.longitude]}
      radius={5}
      pathOptions={{
        color: station.isPlanned ? '#94a3b8' : station.activeGridSag ? '#f59e0b' : '#2dd4bf',
        weight: 1.5,
        dashArray: station.isPlanned ? '2 3' : null,
        fillColor: station.isPlanned ? '#94a3b8' : station.activeGridSag ? '#f59e0b' : '#2dd4bf',
        fillOpacity: station.isPlanned ? 0.2 : 0.5,
      }}
    >
      <Tooltip direction="top" opacity={1} className="charger-tooltip">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-slate-100">{station.name}</p>
          <p className="font-mono text-xs text-slate-400">
            {station.stationId} · {station.state ?? '—'}
            {stationStateLabel(station)}
          </p>
        </div>
      </Tooltip>
    </CircleMarker>
  ))
}

/**
 * UOW-15 Task 15.2: Map Navigation Suite. Absolutely positioned over the map
 * canvas (top-left, mirroring MapLayerControls top-right), zero layout shift.
 * - Go To Location: free-text city / state / zip resolved by
 *   /api/v1/registry/locate against the AFDC registry itself — the result's
 *   bounding box flies the viewport straight onto the matched station set.
 * - Regional Presets: one-tap teleport to the five macro US sectors.
 * - Box Zoom signal: Leaflet's native Shift+drag box zoom is enabled on the
 *   MapContainer; the hint chip advertises it to operators.
 */
function MapNavigator({ map }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)

  const flyTo = useCallback(
    (bounds) => {
      map?.flyToBounds(bounds, { padding: [48, 48], maxZoom: 13, duration: 0.9 })
    },
    [map]
  )

  const goToLocation = async (event) => {
    event.preventDefault()
    const q = query.trim()
    if (!q || !map || busy) return
    setBusy(true)
    try {
      const hit = await fetchRegistryLocate(q)
      flyTo([
        [hit.bounds.minLat, hit.bounds.minLng],
        [hit.bounds.maxLat, hit.bounds.maxLng],
      ])
      setStatus({ kind: 'ok', text: `${hit.label} · ${formatCount(hit.matches)} stations` })
    } catch {
      setStatus({ kind: 'err', text: `No registry match for “${q}”` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-label="Map Navigation"
      className="absolute top-3 left-3 z-[1000] w-60 rounded-xl border border-slate-700 bg-slate-900/90 backdrop-blur p-2 space-y-2 shadow-lg shadow-black/40"
    >
      <h2 className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-widest text-slate-200">
        Navigation
      </h2>
      <form role="search" aria-label="Go To Location" onSubmit={goToLocation} className="flex gap-1.5">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="City, state, or ZIP…"
          aria-label="Go to city, state, or ZIP code"
          className="min-w-0 flex-1 min-h-11 rounded-lg border border-slate-700 bg-slate-950/80 px-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-600 focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 shrink-0 rounded-lg border border-cyan-600 bg-cyan-500/10 px-3 text-sm font-semibold text-cyan-300 transition-colors hover:bg-cyan-500/20 disabled:opacity-50"
        >
          Go
        </button>
      </form>
      <p
        aria-live="polite"
        className={`min-h-4 px-1 text-[11px] font-mono leading-tight ${
          status ? (status.kind === 'ok' ? 'text-emerald-400' : 'text-amber-400') : 'text-transparent'
        }`}
      >
        {status?.text ?? '·'}
      </p>
      <div role="group" aria-label="Regional Presets" className="flex flex-wrap gap-1">
        {REGION_PRESETS.map((region) => (
          <button
            key={region.id}
            type="button"
            title={`Jump to ${region.name}`}
            onClick={() => {
              flyTo(region.bounds)
              setStatus({ kind: 'ok', text: `Sector · ${region.name}` })
            }}
            className="min-h-11 flex-1 basis-16 rounded-lg border border-slate-700 bg-transparent px-1.5 text-[11px] font-bold tracking-wider text-slate-200 transition-colors hover:border-cyan-600 hover:bg-cyan-500/10 hover:text-cyan-300"
          >
            {region.label}
          </button>
        ))}
      </div>
      <p
        title="Hold Shift, then click and drag a rectangle on the map to zoom the viewport directly to it"
        className="flex items-center gap-1.5 px-1 pb-0.5 text-[10px] uppercase tracking-wider text-slate-500"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3 fill-none stroke-current">
          <rect x="2.5" y="4.5" width="11" height="8" rx="1" strokeWidth="1.5" strokeDasharray="2.5 2" />
        </svg>
        <kbd className="rounded border border-slate-700 bg-slate-950/80 px-1 font-mono text-[9px] text-slate-400">
          Shift
        </kbd>
        + drag · box zoom
      </p>
    </section>
  )
}

function CommandCenterMap({ stations, onSelectStation }) {
  const { topology, directory, environment } = useEnvironment(stations)
  const [layers, setLayers] = useState({
    fleet: true,
    grid: true,
    network: true,
    weather: true,
    national: true,
  })
  const [nationalTotal, setNationalTotal] = useState(null)
  // Leaflet Map instance for the navigation suite — react-leaflet v5 exposes
  // it via MapContainer ref once the map mounts.
  const [mapInstance, setMapInstance] = useState(null)

  const gridDown = (environment?.gridNodes ?? []).filter((n) => n.powerStatus === 'OUTAGE').length
  const ispDown = (environment?.ispCarriers ?? []).filter((c) => c.networkStatus === 'DOWN').length
  const weatherActive = environment?.weatherZones?.length ?? 0
  const fleetFaulted = stations.filter(isStationFaulted).length
  const badges = {
    fleet: fleetFaulted ? `${fleetFaulted} down` : null,
    grid: gridDown ? `${gridDown} outage` : null,
    network: ispDown ? `${ispDown} down` : null,
    weather: weatherActive ? `${weatherActive} active` : null,
    national: layers.national && nationalTotal != null ? `${formatCount(nationalTotal)} in view` : null,
  }

  return (
    <>
      <MapContainer
        ref={setMapInstance}
        center={OC_CENTER}
        zoom={11}
        zoomControl={false}
        // UOW-15 Task 15.2: box zoom (Shift + click-drag) explicitly enabled —
        // it is Leaflet's default, but the navigator's hint chip advertises it,
        // so pin the behavior rather than rely on the default staying true.
        boxZoom={true}
        className="h-full w-full"
      >
        <TileLayer url={DARK_MATTER_URL} attribution={DARK_MATTER_ATTRIBUTION} />
        {layers.national && <NationalFleetLayer onViewportTotal={setNationalTotal} />}
        {layers.grid && <GridPowerLayer topology={topology} environment={environment} />}
        {layers.weather && <WeatherLayer environment={environment} />}
        {layers.network && <NetworkLayer directory={directory} environment={environment} />}
        {layers.fleet &&
          stations.map((station) => (
            <Marker
              key={station.chargerId}
              position={[station.location.latitude, station.location.longitude]}
              icon={markerIcon(station)}
              eventHandlers={{ click: () => onSelectStation(station) }}
            >
              <StationTooltip station={station} />
            </Marker>
          ))}
      </MapContainer>
      <MapNavigator map={mapInstance} />
      <MapLayerControls
        layers={layers}
        badges={badges}
        onToggle={(id) => setLayers((prev) => ({ ...prev, [id]: !prev[id] }))}
      />
    </>
  )
}

export default CommandCenterMap
