import type { Project, Session, World } from './model'
import { FakeScrollback, Glyph, MetaLine, OverlayList, StatusWord, projectOf } from './shared'

export function VariantA({
  world,
  selectedId,
  onSelect,
}: {
  world: World
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const selected = world.sessions.find((s) => s.id === selectedId) ?? null
  const selectedProject = selected ? projectOf(world, selected) : null

  return (
    <div className="pg-a">
      <div className="pg-a-bands">
        {world.projects.map((project) => {
          const owned = world.sessions.filter((s) => s.projectId === project.id)
          return (
            <section key={project.id} className="pg-a-band">
              <header className="pg-a-head" style={{ borderColor: project.color }}>
                <div>
                  <div className="pg-a-proj">{project.name}</div>
                  <div className="pg-muted">{project.path}</div>
                </div>
                <div className="pg-muted">{owned.length} oturum</div>
              </header>
              <div className="pg-a-cells">
                {owned.map((session) => (
                  <Cell
                    key={session.id}
                    session={session}
                    project={project}
                    now={world.now}
                    selected={session.id === selectedId}
                    onSelect={() => onSelect(session.id)}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>

      <div className="pg-a-detail">
        {selected && selectedProject ? (
          <>
            <div className="pg-a-detail-bar">
              <Glyph command={selected.command} />
              <strong>{selected.name}</strong>
              <span className="pg-muted">{selectedProject.name}</span>
              <StatusWord session={selected} now={world.now} />
              <OverlayList session={selected} project={selectedProject} />
              <MetaLine session={selected} now={world.now} />
            </div>
            <FakeScrollback
              lines={selected.lines}
              dim={selected.lifecycle !== 'live'}
              cursor={selected.lifecycle === 'live'}
            />
          </>
        ) : (
          <div className="pg-muted pg-pad">Bir kutu seç — altta tek PTY açılır. Kutular canlı xterm değil.</div>
        )}
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
