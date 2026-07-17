import { useEffect, useState } from 'react'
import {
  fetchTopology,
  fetchDirectoryChargers,
  fetchEnvironmentStatus,
} from '../services/fleetApi.js'

/**
 * Infrastructure topology + live environment status for the map overlays.
 * Topology and the public charger directory are static per session; environment
 * status refreshes on every fleet SSE snapshot (simulator events fault fleet
 * connectors, so snapshots double as a change signal) plus a slow poll to catch
 * directory-only events that touch no fleet station.
 */
export function useEnvironment(stations) {
  const [topology, setTopology] = useState(null)
  const [directory, setDirectory] = useState([])
  const [environment, setEnvironment] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetchTopology()
      .then((data) => {
        if (!cancelled) setTopology(data)
      })
      .catch(() => {})
    fetchDirectoryChargers()
      .then((data) => {
        if (!cancelled) setDirectory(data.chargers)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetchEnvironmentStatus()
        .then((data) => {
          if (!cancelled) setEnvironment(data)
        })
        .catch(() => {})
    load()
    const timer = setInterval(load, 10000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [stations])

  return { topology, directory, environment }
}
