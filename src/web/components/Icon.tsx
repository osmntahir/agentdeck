export type IconName = 'settings' | 'more' | 'play' | 'stop' | 'branch' | 'copy' | 'archive' | 'trash' | 'grid' | 'terminal' | 'diff' | 'refresh' | 'plus' | 'back'
const paths: Record<IconName, string> = {
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  play: 'm8 5 11 7-11 7Z', stop: 'M6 6h12v12H6Z',
  branch: 'M6 6v12M6 12c8 0 12 0 12-6M4 3h4v4H4ZM4 17h4v4H4ZM16 3h4v4h-4Z',
  copy: 'M9 9h11v11H9ZM15 5V3H3v12h2',
  archive: 'M3 3h18v5H3ZM5 8v13h14V8M9 12h6',
  trash: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
  grid: 'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',
  terminal: 'm4 6 6 6-6 6M13 18h7', diff: 'M14 3h7M17.5 0v6M3 16h7M13 10l-3 4M5 3v7M19 14v7',
  refresh: 'M20 8a8 8 0 1 0 0 8M20 3v5h-5', plus: 'M12 4v16M4 12h16', back: 'm10 5-7 7 7 7M3 12h18',
}
export function Icon({ name }: { name: IconName }) {
  return <svg className="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
