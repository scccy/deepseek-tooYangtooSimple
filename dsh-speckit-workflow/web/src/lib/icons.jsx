// Inline SVG icon set — ported verbatim from lib/client.js (lucide-style).
const SVG = {
  file: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h10M7 17h6"/>',
  message: '<path d="M21 12a8 8 0 0 1-8 8H6l-3 2v-5a8 8 0 0 1 10-16 8 8 0 0 1 8 8z"/><path d="M10 10a2 2 0 1 1 3 1.7c-.7.6-1 1.1-1 2.3"/><path d="M12 17h.01"/>',
  hammer: '<path d="M14 4l6 6-3.5 1L13 7.5z"/><path d="M9 9l-5 5a2.1 2.1 0 0 0 3 3l5-5"/><path d="M14 14l5 5"/>',
  merge: '<circle cx="6" cy="5" r="2.5"/><circle cx="18" cy="5" r="2.5"/><circle cx="13" cy="19" r="2.5"/><path d="M6 7.5v2a4 4 0 0 0 4 4h3"/>',
  kanban: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="9.5" y="4" width="5" height="10" rx="1"/><rect x="16" y="4" width="5" height="13" rx="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  'git-fork': '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M6 8.5v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-2"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
  text: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  alert: '<path d="M12 3 2 21h20z"/><path d="M12 9v5M12 17.5h.01"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  rotate: '<path d="M20 11a8 8 0 1 0-2.3 6.2"/><path d="M20 4v7h-7"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9"/><path d="M10 13h4"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.8.7 1 1.5 1 2.5h6c0-1 .2-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.2"/><path d="M20 4v7h-7"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7L12.5 19"/>'
}

export function Icon({ name, size = 15, style, className }) {
  const body = SVG[name] || SVG.file
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <g dangerouslySetInnerHTML={{ __html: body }} />
    </svg>
  )
}
