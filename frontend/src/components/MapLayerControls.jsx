const LAYER_DEFS = [
  { id: 'fleet', label: 'Fleet Health', swatch: 'bg-cyan-400' },
  { id: 'grid', label: 'Grid Power', swatch: 'bg-emerald-400' },
  { id: 'network', label: 'Network', swatch: 'bg-sky-400' },
  { id: 'weather', label: 'Weather', swatch: 'bg-indigo-300' },
  { id: 'national', label: 'National Fleet', swatch: 'bg-teal-300' },
]

/**
 * Map overlay toggle panel. Absolutely positioned over the map canvas (zero
 * layout shift), native <button> toggles with aria-pressed for full
 * keyboard/screen-reader operability.
 */
function MapLayerControls({ layers, badges, onToggle }) {
  return (
    <section
      aria-label="Map Layer Controls"
      className="absolute top-3 right-3 z-[1000] w-48 rounded-xl border border-slate-700 bg-slate-900/90 backdrop-blur p-2 space-y-1 shadow-lg shadow-black/40"
    >
      <h2 className="px-2 pt-1 text-[10px] font-semibold uppercase tracking-widest text-slate-200">
        Map Layers
      </h2>
      {LAYER_DEFS.map((def) => {
        const active = layers[def.id]
        const badge = badges?.[def.id]
        return (
          <button
            key={def.id}
            type="button"
            onClick={() => onToggle(def.id)}
            aria-pressed={active}
            className={`w-full min-h-11 flex items-center gap-2.5 px-2.5 rounded-lg border text-sm font-semibold text-left transition-colors ${
              active
                ? 'border-cyan-600 bg-cyan-500/10 text-slate-100'
                : 'border-slate-700 bg-transparent text-slate-200 hover:bg-slate-800'
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-2.5 w-2.5 rounded-full ${def.swatch} ${active ? '' : 'opacity-30'}`}
            />
            <span className="flex-1">{def.label}</span>
            {badge ? (
              <span className="rounded-full border border-amber-500/60 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">
                {badge}
              </span>
            ) : null}
          </button>
        )
      })}
    </section>
  )
}

export default MapLayerControls
