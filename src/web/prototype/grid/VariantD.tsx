import type { Project, Session, World } from './model'
import { FakeScrollback, Glyph, OverlayList, StatusWord, projectOf } from './shared'

export function VariantD({
  world,
  selectedId,
  onSelect,
}: {
  world: World
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div className="pg-d">
      <aside className="pg-b-map">
        <div className="pg-b-brand">agentdeck</div>
        {world.projects.map((project) => {
          const owned = world.sessions.filter((s) => s.projectId === project.id)
          return (
            <div key={project.id} className="pg-b-proj">
              <div className="pg-b-label" style={{ color: project.color }}>
                {project.name}
              </div>
              {owned.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className={`pg-b-row${session.id === selectedId ? ' on' : ''}`}
                  onClick={() => onSelect(session.id)}
                >
                  <span className="pg-b-dot" style={{ background: project.color }} />
                  <Glyph command={session.command} />
                  <span className="pg-b-row-body">
                    <span className="pg-name">{session.name}</span>
                    <span className="pg-b-row-sub">
                      <StatusWord session={session} now={world.now} />
                      <span className="pg-meta">
                        {session.isolation === 'worktree' ? session.branch : 'ortak kopya'}
                      </span>
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )
        })}
      </aside>

      <div className="pg-d-grid">
        {world.sessions.map((session) => (
          <Cell
            key={session.id}
            session={session}
            project={projectOf(world, session)}
            now={world.now}
            selected={session.id === selectedId}
            onSelect={() => onSelect(session.id)}
          />
        ))}
      </div>
    </div>
  )
}

function Cell({
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
  return (
    <button
      type="button"
      className={`pg-a-cell${selected ? ' on' : ''}`}
      style={{ borderLeftColor: project.color }}
      onClick={onSelect}
    >
      <div className="pg-a-cell-top">
        <Glyph command={session.command} />
        <span className="pg-name">{session.name}</span>
        <StatusWord session={session} now={now} />
      </div>
      <div className="pg-a-cell-mid">
        <span className="pg-muted">{project.name}</span>
        <OverlayList session={session} project={project} />
      </div>
      <FakeScrollback lines={session.lines.slice(-4)} dim={session.lifecycle !== 'live'} />
    </button>
  )
}
