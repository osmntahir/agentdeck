import type { Project, Session, World } from './model'
import { attentionRank, overlays, uiStatus } from './model'
import { FakeScrollback, Glyph, MetaLine, OverlayList, StatusWord, projectOf } from './shared'

export function VariantB({
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
  const flagged = world.sessions
    .filter((s) => attentionRank(s, projectOf(world, s), world.now) <= 3)
    .sort((a, b) => attentionRank(a, projectOf(world, a), world.now) - attentionRank(b, projectOf(world, b), world.now))

  return (
    <div className="pg-b">
      <aside className="pg-b-map">
        <div className="pg-b-brand">agentdeck</div>
        {flagged.length > 0 && (
          <div className="pg-b-bucket">
            <div className="pg-b-label">dikkat</div>
            <div className="pg-b-note">idle · degraded · orphaned · hata — “seni bekliyor” değil</div>
            {flagged.map((session) => (
              <Row
                key={`f-${session.id}`}
                session={session}
                project={projectOf(world, session)}
                now={world.now}
                selected={session.id === selectedId}
                onSelect={() => onSelect(session.id)}
                showProject
              />
            ))}
          </div>
        )}
        {world.projects.map((project) => {
          const owned = world.sessions.filter((s) => s.projectId === project.id)
          return (
            <div key={project.id} className="pg-b-proj">
              <div className="pg-b-label" style={{ color: project.color }}>
                {project.name}
              </div>
              {owned.map((session) => (
                <Row
                  key={session.id}
                  session={session}
                  project={project}
                  now={world.now}
                  selected={session.id === selectedId}
                  onSelect={() => onSelect(session.id)}
                />
              ))}
            </div>
          )
        })}
      </aside>

      <main className="pg-b-main">
        {selected && selectedProject ? (
          <>
            <header className="pg-b-top">
              <Glyph command={selected.command} />
              <div>
                <div className="pg-title">{selected.name}</div>
                <div className="pg-muted">
                  {selectedProject.name} · {selected.cwd}
                </div>
              </div>
              <StatusWord session={selected} now={world.now} />
              <OverlayList session={selected} project={selectedProject} />
              <MetaLine session={selected} now={world.now} />
            </header>
            <FakeScrollback
              lines={padTerm(selected)}
              dim={selected.lifecycle !== 'live'}
              cursor={selected.lifecycle === 'live' && uiStatus(selected, world.now) === 'running'}
            />
          </>
        ) : (
          <div className="pg-muted pg-pad">Soldan bir oturum seç. Grid yok; tek PTY.</div>
        )}
      </main>
    </div>
  )
}

function Row({
  session,
  project,
  now,
  selected,
  onSelect,
  showProject,
}: {
  session: Session
  project: Project
  now: number
  selected: boolean
  onSelect: () => void
  showProject?: boolean
}) {
  const hot = overlays(session, project).length > 0 || uiStatus(session, now) !== 'running'
  return (
    <button type="button" className={`pg-b-row${selected ? ' on' : ''}${hot ? ' hot' : ''}`} onClick={onSelect}>
      <span className="pg-b-dot" style={{ background: project.color }} />
      <Glyph command={session.command} />
      <span className="pg-b-row-body">
        <span className="pg-name">{session.name}</span>
        {showProject && <span className="pg-muted"> {project.name}</span>}
        <span className="pg-b-row-sub">
          <StatusWord session={session} now={now} />
          <OverlayList session={session} project={project} />
          <MetaLine session={session} now={now} />
        </span>
      </span>
    </button>
  )
}

function padTerm(session: Session): string[] {
  const extra = session.lifecycle === 'live' ? ['', '', ''] : ['', '(PTY yok — kayıt duruyor)']
  return [...session.lines, ...extra]
}
