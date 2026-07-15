import { useEffect, useState } from 'react'
import { fetchFleetStatus } from '../services/fleetApi.js'

/**
 * Fleet status kept live over SSE. The initial REST fetch paints first;
 * every /api/v1/fleet/stream broadcast then overrides it in place.
 */
export function useFleetStream() {
  const [stations, setStations] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    fetchFleetStatus()
      .then((data) => {
        if (!cancelled) setStations(data.stations)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })

    const source = new EventSource('/api/v1/fleet/stream')
    source.onmessage = (message) => {
      const snapshot = JSON.parse(message.data)
      setStations(snapshot.stations)
      setError(null)
    }

    return () => {
      cancelled = true
      source.close()
    }
  }, [])

  return { stations, error }
}
