// UOW-13 Task 13.2: singleton SSE hub. The backend multiplexes every live
// plane over one /api/v1/fleet/stream connection — unnamed fleet snapshots
// plus named `alert-update` and `incident-update` frames — so the frontend
// must hold exactly one EventSource no matter how many consumers subscribe
// (browsers cap concurrent connections per origin; a second socket per
// AlertDesk mount would starve the pool). Subscribers are refcounted: the
// socket opens with the first subscription and closes with the last.

let source = null
let refCount = 0

export function subscribeStream(eventName, handler) {
  if (!source) source = new EventSource('/api/v1/fleet/stream')
  const stream = source
  refCount += 1

  const listener = (message) => {
    let payload
    try {
      payload = JSON.parse(message.data)
    } catch {
      return // malformed frame: drop it, never tear down the stream
    }
    handler(payload)
  }
  stream.addEventListener(eventName, listener)

  let active = true
  return () => {
    if (!active) return
    active = false
    stream.removeEventListener(eventName, listener)
    refCount -= 1
    if (refCount === 0 && source === stream) {
      stream.close()
      source = null
    }
  }
}
