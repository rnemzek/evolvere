import { useEffect, useState } from 'react'
import { fetchFleetStatus } from '../services/fleetApi.js'
import { subscribeStream } from '../services/streamHub.js'

/**
 * Fleet status kept live over SSE. The initial REST fetch paints first;
 * every /api/v1/fleet/stream broadcast then overrides it in place. Rides the
 * shared streamHub socket (Task 13.2) — unnamed frames are the fleet
 * snapshots; named incident/alert frames go to their own subscribers.
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

    const unsubscribe = subscribeStream('message', (snapshot) => {
      setStations(snapshot.stations)
      setError(null)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return { stations, error }
}
