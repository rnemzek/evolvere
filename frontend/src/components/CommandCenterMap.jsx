import { useCallback, useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Tooltip, Circle, CircleMarker, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
// Leaflet CSS ships with this lazy chunk, not the landing bundle (Task 7.1).
import 'leaflet/dist/leaflet.css'
import { isStationFaulted } from '../services/stationHealth.js'
import { STATUS_STYLES } from './StationDrawer'
import MapLayerControls from './MapLayerControls.jsx'
import { useEnvironment } from '../hooks/useEnvironment.js'
import { fetchSpatialClusters } from '../services/fleetApi.js'

const OC_CENTER = [33.74, -117.82]

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

// UOW-11 label alignment: `activeGridSag` stays wire-compatible but now flags
// real AFDC availability, so user-facing text names the actual station state
// (P = planned build-out, T = temporarily unavailable).
const stationStateLabel = (station) => {
  if (!station.activeGridSag) return ''
  if (station.statusCode === 'P') return ' · PLANNED SITE'
  if (station.statusCode === 'T') return ' · STATION OFFLINE'
  return ' · STATION DOWN'
}

function clusterIcon(cluster) {
  const sagging = cluster.sagCount > 0
  // Screen readers get the full telemetry sentence; the visual bubble shows
  // only the compact count. Enter/Space activate via Leaflet marker keyboard
  // support on the focusable wrapper.
  // UOW-11: the wire field keeps its `sagCount` name, but at AFDC semantics it
  // counts stations whose real-world status is not open (planned or offline).
  const srLabel = sagging
    ? `Cluster of ${cluster.count} national stations, ${cluster.sagCount} offline or planned — activate to zoom in`
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
              {cluster.sagCount > 0 ? `${cluster.sagCount} offline/planned · ` : ''}tap to zoom
            </p>
          </div>
        </Tooltip>
      </Marker>
    ))
  }

  return payload.stations.map((station) => (
    <CircleMarker
      key={station.stationId}
      center={[station.latitude, station.longitude]}
      radius={5}
      pathOptions={{
        color: station.activeGridSag ? '#f59e0b' : '#2dd4bf',
        weight: 1.5,
        fillColor: station.activeGridSag ? '#f59e0b' : '#2dd4bf',
        fillOpacity: 0.5,
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
        center={OC_CENTER}
        zoom={11}
        zoomControl={false}
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
      <MapLayerControls
        layers={layers}
        badges={badges}
        onToggle={(id) => setLayers((prev) => ({ ...prev, [id]: !prev[id] }))}
      />
    </>
  )
}

export default CommandCenterMap
