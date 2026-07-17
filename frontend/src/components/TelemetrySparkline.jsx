// UOW-08 Task 8.4: dependency-free responsive SVG micro-line chart for the
// Alert Desk drawer. Renders a single degradation metric against its critical
// threshold — voltage plunges below 200 V (grid sag) or thermal climbs past
// 85 °C (weather spike) — in a fixed-height frame so async data never shifts
// layout (zero CLS). Palette tuned to complement the CartoDB Dark Matter map.

const METRICS = {
  voltage: {
    key: 'voltageV',
    label: 'Voltage',
    unit: 'V',
    threshold: 200,
    breach: 'below', // critical when the trace drops under the line
    stroke: '#22d3ee', // cyan-400
  },
  temperature: {
    key: 'temperatureC',
    label: 'Core Temp',
    unit: '°C',
    threshold: 85,
    breach: 'above', // critical when the trace climbs over the line
    stroke: '#fbbf24', // amber-400
  },
}

const CRIT = '#f87171' // red-400
const W = 320
const H = 84
const PAD = 6

const isBreach = (value, m) =>
  m.breach === 'below' ? value < m.threshold : value > m.threshold

export default function TelemetrySparkline({ ticks = [], metric = 'voltage' }) {
  const m = METRICS[metric] ?? METRICS.voltage
  const points = ticks
    .map((t) => t?.[m.key])
    .filter((v) => Number.isFinite(v))

  // Fixed-height skeleton keeps the drawer stable before ticks resolve.
  if (points.length < 2) {
    return (
      <div
        className="grid place-items-center rounded-lg border border-slate-800 bg-slate-950/60 text-xs text-slate-500"
        style={{ height: H }}
      >
        Awaiting telemetry ticks…
      </div>
    )
  }

  const latest = points[points.length - 1]
  const dataMin = Math.min(...points)
  const dataMax = Math.max(...points)
  // Always keep the threshold in view so the breach relationship reads clearly.
  let lo = Math.min(dataMin, m.threshold)
  let hi = Math.max(dataMax, m.threshold)
  if (hi === lo) hi = lo + 1
  const span = hi - lo

  const x = (i) => PAD + (i * (W - 2 * PAD)) / (points.length - 1)
  const y = (v) => PAD + (1 - (v - lo) / span) * (H - 2 * PAD)

  const linePath = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ')
  const areaPath = `${linePath} L${x(points.length - 1)},${H - PAD} L${x(0)},${H - PAD} Z`
  const thresholdY = y(m.threshold)
  const breached = isBreach(latest, m)
  const breachPoints = points
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => isBreach(v, m))

  const gradId = `spark-${metric}`
  const summary =
    `${m.label} trend, latest ${latest.toFixed(1)} ${m.unit}, ` +
    `critical threshold ${m.threshold} ${m.unit} — ` +
    (breached ? `currently breaching (${m.breach} threshold).` : 'within nominal range.')

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
        className="block"
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={m.stroke} stopOpacity="0.28" />
            <stop offset="100%" stopColor={m.stroke} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Critical threshold reference line */}
        <line
          x1={PAD}
          x2={W - PAD}
          y1={thresholdY}
          y2={thresholdY}
          stroke={CRIT}
          strokeWidth="1"
          strokeDasharray="4 3"
          opacity="0.7"
        />

        <path d={areaPath} fill={`url(#${gradId})`} stroke="none" />
        <path
          d={linePath}
          fill="none"
          stroke={breached ? CRIT : m.stroke}
          strokeWidth="1.75"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Highlight the ticks that cross the safety threshold */}
        {breachPoints.map(({ v, i }) => (
          <circle key={i} cx={x(i)} cy={y(v)} r="2.1" fill={CRIT} />
        ))}
      </svg>

      <figcaption className="mt-1 flex items-center justify-between text-[11px]">
        <span className="text-slate-400">
          {m.label}{' '}
          <span
            className={`font-mono tabular-nums ${breached ? 'text-red-400' : 'text-slate-200'}`}
          >
            {latest.toFixed(1)} {m.unit}
          </span>
        </span>
        <span className="text-slate-500">
          thr <span className="font-mono tabular-nums text-red-400/80">{m.threshold}{m.unit}</span>
        </span>
      </figcaption>
    </figure>
  )
}
