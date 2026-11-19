import { ICONS } from '../../lib/icons'

/** One icon from Adal Keep's icon set (lib/icons.js): <Icon name="tasks" />. */
export default function Icon({ name, size = 20, className = '', strokeWidth = 1.75, ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`ak-icon ${className}`}
      dangerouslySetInnerHTML={{ __html: ICONS[name] || '' }} {...rest} />
  )
}
