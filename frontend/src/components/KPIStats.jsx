const REVENUE_AT_RISK_PER_PORT_HOUR = 22.5 // $0.45/kWh × 50 kW commercial fast-charge port

function StatTile({ label, value, unit, tone = 'text-cyan-400', caption }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/70 backdrop-blur p-4">
      <p className="text-xs uppercase tracking-widest text-slate-400">{label}</p>
      <p className={`mt-1 text-3xl font-bold tabular-nums ${tone}`}>
        {value}
        {unit && <span className="ml-1 text-base font-medium text-slate-400">{unit}</span>}
      </p>
      {caption && <p className="mt-1 text-xs text-slate-400">{caption}</p>}
    </div>
  )
}

function KPIStats({ stations, transactions }) {
  const connectors = stations.flatMap((s) => s.connectors)
  const faultedPorts = connectors.filter((c) => c.status === 'Faulted').length
  const uptimePct = connectors.length
    ? ((connectors.length - faultedPorts) / connectors.length) * 100
    : 100
  const activeSessions = connectors.filter((c) => c.status === 'Charging').length
  const totalKwh = transactions.reduce((sum, t) => sum + t.totalEnergyDeliveredKwh, 0)
  const revenueAtRisk = faultedPorts * REVENUE_AT_RISK_PER_PORT_HOUR

  return (
    <section
      aria-label="Fleet KPIs"
      className="grid grid-cols-2 lg:grid-cols-4 gap-3"
    >
      <StatTile
        label="Fleet Uptime"
        value={uptimePct.toFixed(1)}
        unit="%"
        tone={uptimePct < 90 ? 'text-amber-400' : 'text-green-400'}
        caption={`${connectors.length - faultedPorts}/${connectors.length} ports healthy`}
      />
      <StatTile
        label="Active Sessions"
        value={activeSessions}
        tone="text-cyan-400"
        caption="connectors charging now"
      />
      <StatTile
        label="Energy Delivered"
        value={totalKwh.toFixed(1)}
        unit="kWh"
        tone="text-sky-400"
        caption={`across ${transactions.length} sessions`}
      />
      <StatTile
        label="Revenue at Risk"
        value={`$${revenueAtRisk.toFixed(2)}`}
        unit="/hr"
        tone={faultedPorts > 0 ? 'text-red-400' : 'text-green-400'}
        caption={`${faultedPorts} commercial port${faultedPorts === 1 ? '' : 's'} down`}
      />
    </section>
  )
}

export default KPIStats
