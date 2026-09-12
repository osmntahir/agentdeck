import type { Project, Session, World } from './model'
import { attentionRank, uiStatus } from './model'
import { FakeScrollback, Glyph, OverlayList, StatusWord, projectOf } from './shared'

export function VariantC({
  world,
  selectedId,
  onSelect,
}: {
  world: World
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const ordered = [...world.sessions].sort(
    (a, b) =>
      attentionRank(a, projectOf(world, a), world.now) - attentionRank(b, projectOf(world, b), world.now) ||
      a.name.localeCompare(b.name),
  )

  return (
    <div className="pg-c">
      <div className="pg-c-mosaic">
        {ordered.map((session) => {
          const project = projectOf(world, session)
          return (
            <Tile
              key={session.id}
              session={session}
              project={project}
              now={world.now}
              selected={session.id === selectedId}
              onSelect={() => onSelect(session.id)}
            />
          )
        })}
      </div>
      <aside className="pg-c-mini" title="ısı haritası">
        {ordered.map((session) => {
          const project = projectOf(world, session)
          const status = uiStatus(session, world.now)
          return (
            <button
              key={session.id}
              type="button"
              className={`pg-c-heat ${status}${session.id === selectedId ? ' on' : ''}`}
              style={{ boxShadow: `inset 3px 0 ${project.color}` }}
              title={`${session.name} · ${project.name} · ${status}`}
              onClick={() => onSelect(session.id)}
            />
          )
        })}
      </aside>
    </div>
  )
}

function Tile({
  session,
  project,
  now,
  selected,
  onSelect,
}: {
  session: Session
  project: Project
  now: number
  selected: boolean
  onSelect: () => void
}) {
  const status = uiStatus(session, now)
  const liveCursor = status === 'running'
  return (
    <button
      type="button"
      className={`pg-c-tile${selected ? ' on' : ''}`}
      style={{ borderTopColor: project.color }}
      onClick={onSelect}
    >
      <div className="pg-c-tile-bar">
        <Glyph command={session.command} />
        <span className="pg-name">{session.name}</span>
        <span className="pg-c-tag">{project.name.slice(0, 3)}</span>
        <StatusWord session={session} now={now} />
      </div>
      <OverlayList session={session} project={project} />
      <FakeScrollback lines={session.lines} dim={!liveCursor} cursor={liveCursor} />
    </button>
  )
}
