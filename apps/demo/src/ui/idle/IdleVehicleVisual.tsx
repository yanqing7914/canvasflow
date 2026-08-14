/**
 * An original, deliberately unbranded EV silhouette. It is atmosphere only:
 * navigation and task state continue to come from the map and Agent layers.
 */
export function IdleVehicleVisual({ muted = false }: { muted?: boolean }) {
  return (
    <div className={`idle-vehicle-visual${muted ? ' idle-vehicle-visual--muted' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 520 300" role="presentation">
        <defs>
          <linearGradient id="idle-car-paint" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#fff8ec" />
            <stop offset="0.45" stopColor="#d3a078" />
            <stop offset="1" stopColor="#6e3426" />
          </linearGradient>
          <linearGradient id="idle-car-glass" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#e2f4f5" stopOpacity=".95" />
            <stop offset="1" stopColor="#18394b" stopOpacity=".9" />
          </linearGradient>
          <filter id="idle-car-shadow" x="-30%" y="-40%" width="160%" height="190%">
            <feGaussianBlur stdDeviation="16" />
          </filter>
        </defs>
        <ellipse cx="262" cy="251" rx="186" ry="27" fill="#1e1a18" opacity=".38" filter="url(#idle-car-shadow)" />
        <path d="M77 193c7-38 28-62 65-76l65-25 51-48c15-14 36-21 57-19l56 5c19 2 35 12 47 28l38 54 36 18c21 10 33 29 35 57l-9 31H84z" fill="url(#idle-car-paint)" stroke="#fff5e7" strokeWidth="5" />
        <path d="m223 91 43-42c10-9 24-13 37-12l48 5c12 1 22 8 30 18l30 43z" fill="url(#idle-car-glass)" stroke="#ffe9d5" strokeOpacity=".65" strokeWidth="4" />
        <path d="M89 179c66 20 255 16 366-16" fill="none" stroke="#fff4e6" strokeOpacity=".68" strokeWidth="4" />
        <path d="M102 197h75m211-22h70" fill="none" stroke="#ffdf83" strokeLinecap="round" strokeWidth="10" />
        <g fill="#2a2220" stroke="#f4d5bc" strokeWidth="6">
          <circle cx="155" cy="215" r="43" /><circle cx="393" cy="204" r="43" />
        </g>
        <g fill="#c5d5d7"><circle cx="155" cy="215" r="21" /><circle cx="393" cy="204" r="21" /></g>
        <path d="M192 122c54-17 133-17 193 2" fill="none" stroke="#fff9ee" strokeLinecap="round" strokeOpacity=".72" strokeWidth="7" />
      </svg>
    </div>
  )
}
