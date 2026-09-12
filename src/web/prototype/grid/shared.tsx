import type { Project, Session, UiStatus, World } from './model'
import { commandGlyph, commandLabel, exitLabel, overlays, relative, uiStatus } from './model'

export const VARIANTS = [
  { key: 'A', name: 'Proje şeritleri' },
  { key: 'B', name: 'Minimap + tek PTY' },
  { key: 'C', name: 'Dikkat mozaiği' },
] as const

export const THESES: Record<string, { cell: string; layout: string; minimap: string; marks: string }> = {
  A: {
    cell: 'ucuz önizleme — son satırlar; canlı xterm yok',
    layout: 'proje şeritleri — kutular yerinde kalır; dikkat işaretle, sıra değiştirme',
    minimap: 'ayrı yüzey yok; tarama grid’in kendisi',
    marks: 'komut glifi + proje adı + izolasyon + durum sözcüğü; renk yalnızca 3px şerit',
  },
  B: {
    cell: 'kutu yok — satır yalnızca durum yığını; tek canlı PTY ana yüzeyde',
    layout: 'proje gruplu minimap; dikkat kovası üstte, satırlar yerinde',
    minimap: 'ayrı yüzey — “ne sessiz / bozuk / bitmiş” sorusunun yeri',
    marks: 'glif + ad + göreli zaman + overlay satırı; renk ikincil nokta',
  },
  C: {
    cell: 'canlı görünümlü kutu (sahte xterm); aynı anda N kutu pahalı',
    layout: 'proje gruplaması yok; dikkat sırası kutuları yerinden oynatır',
    minimap: 'sağda ayrı ısı haritası',
    marks: 'glif + 3 harfli proje + durum çubuğu; renk dolgu değil kenar',
  },
}

export function projectOf(world: World, session: Session): Project {
  return world.projects.find((p) => p.id === session.projectId)!
}

export function FakeScrollback({
  lines,
  dim,
  cursor,
}: {
  lines: string[]
  dim?: boolean
  cursor?: boolean
}) {
  return (
    <pre className={`pg-term${dim ? ' dim' : ''}`}>
      {lines.join('\n')}
      {cursor ? <span className="pg-cursor">█</span> : null}
    </pre>
  )
}

export function Glyph({ command }: { command: string | null }) {
  return (
    <span className="pg-glyph" title={commandLabel(command)}>
      {commandGlyph(command)}
    </span>
  )
}

export function StatusWord({ session, now }: { session: Session; now: number }) {
  const status = uiStatus(session, now)
  return <span className={`pg-status ${status}`}>{label(status, session)}</span>
}

export function OverlayList({ session, project }: { session: Session; project: Project }) {
  const items = overlays(session, project)
  if (items.length === 0) return null
  return (
    <span className="pg-overlays">
      {items.map((item) => (
        <span key={item} className="pg-overlay">
          {item}
        </span>
      ))}
    </span>
  )
}

export function MetaLine({ session, now }: { session: Session; now: number }) {
  const bits = [
    session.isolation === 'worktree' ? 'izole' : 'ortak',
    session.branch ?? 'session branch yok',
  ]
  if (session.lifecycle === 'live' && session.lastActivity != null) {
    bits.unshift(relative(now - session.lastActivity))
  }
  const exit = exitLabel(session)
  if (exit) bits.unshift(exit)
  return <span className="pg-meta">{bits.join(' · ')}</span>
}

export function StateDump({
  variant,
  world,
  selectedId,
}: {
  variant: string
  world: World
  selectedId: string | null
}) {
  const thesis = THESES[variant]
  const session = world.sessions.find((s) => s.id === selectedId) ?? null
  const project = session ? projectOf(world, session) : null
  return (
    <aside className="pg-dump">
      <div className="pg-dump-title">durum — {variant}</div>
      {thesis && (
        <ul>
          <li>
            <b>kutu</b> {thesis.cell}
          </li>
          <li>
            <b>düzen</b> {thesis.layout}
          </li>
          <li>
            <b>minimap</b> {thesis.minimap}
          </li>
          <li>
            <b>işaret</b> {thesis.marks}
          </li>
        </ul>
      )}
      {session && project && (
        <pre>
          {JSON.stringify(
            {
              name: session.name,
              project: project.name,
              command: session.command,
              label: commandLabel(session.command),
              isolation: session.isolation,
              lifecycle: session.lifecycle,
              ui: uiStatus(session, world.now),
              lastActivity:
                session.lastActivity == null ? null : relative(world.now - session.lastActivity),
              overlays: overlays(session, project),
              exitCode: session.exitCode,
              exitSignal: session.exitSignal,
              cwdMissing: session.cwdMissing,
              projectRootMissing: project.rootMissing,
            },
            null,
            2,
          )}
        </pre>
      )}
    </aside>
  )
}

function label(status: UiStatus, session: Session): string {
  if (status === 'exited') return exitLabel(session) ?? 'exited'
  return status
}
