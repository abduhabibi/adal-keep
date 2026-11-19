/**
 * A segmented control on frosted glass, like iOS ("Week | Term | Year"):
 * <Segmented value={tab} onChange={setTab} options={[['week', 'Week'], ['term', 'Term']]} />
 * options: [id, label] pairs or { id, label, badge } objects. `wrap` lets a
 * long row break onto a second line instead of scrolling sideways.
 */
export default function Segmented({ options, value, onChange, wrap = false, size = 'md', className = '', ...rest }) {
  const items = options.map(o => Array.isArray(o) ? { id: o[0], label: o[1] } : o)
  return (
    <div role="tablist" className={`ak-seg ak-seg-${size} ${wrap ? 'ak-seg-wrap' : ''} ${className}`} {...rest}>
      {items.map(o => (
        <button key={o.id} type="button" role="tab" aria-selected={value === o.id}
          onClick={() => onChange(o.id)} className={`ak-seg-item${value === o.id ? ' is-on' : ''}`}>
          {o.label}{o.badge != null && <span className="ak-seg-badge">{o.badge}</span>}
        </button>
      ))}
    </div>
  )
}
