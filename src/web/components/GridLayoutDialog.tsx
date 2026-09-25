import { NewSessionDialog } from './NewSessionDialog'
import * as client from '../api'
import type { Isolation, Project, SessionView, Work } from '../../shared/types'
import type { WorkChoice } from './WorkDialogs'
import { useEffect, useRef, useState } from 'react'
import type { DockviewApi, Position } from 'dockview-react'
import { MAX_GRID_PANELS } from '../gridLayout'

interface Props {
  projects: Project[]
  healthy: boolean
  onRefresh: () => Promise<void>
  api: DockviewApi
  panelId: string
  sessions: SessionView[]
  works: Work[]
  onClose: () => void
}

/** Aynı Dockview taşıma/boyut API'si; terminal tuşlarını yakalayan kısayol yoktur. */
export function GridLayoutDialog({ projects, healthy, onRefresh, api, panelId, sessions, works, onClose }: Props) {
  const [newProjectId, setNewProjectId] = useState(projects[0]?.id ?? '')
  const [creatingNew, setCreatingNew] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newDirection, setNewDirection] = useState<'right' | 'below'>('right')
  const project = projects.find(p => p.id === newProjectId)
  const create = async (input: { name: string; command: string | null; isolation: Isolation; work: WorkChoice }) => {
    if (!project || busy || !healthy || api.panels.length >= MAX_GRID_PANELS) return
    setBusy(true); setError(null)
    try {
      const workId = input.work === null ? null : 'id' in input.work ? input.work.id : (await client.createWork(project.id, input.work.name)).id
      const session = await client.createSession({ name: input.name, command: input.command, isolation: input.isolation, workId, projectId: project.id })
      await onRefresh()
      const reference = api.getPanel(panelId)
      api.addPanel({ id: session.id, component: 'terminal', title: session.name, params: { sessionId: session.id }, ...(reference ? { position: { referenceGroup: reference.api.group, direction: newDirection } } : {}) })
      setCreatingNew(false); finish()
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  const dialog = useRef<HTMLDialogElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const targets = api.panels.filter((panel) => panel.id !== panelId)
  const available = sessions.filter(s => !api.getPanel(s.id) && s.archivedAt === null)
  const [addId, setAddId] = useState(available[0]?.id ?? '')
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '')
  const [position, setPosition] = useState<Position>('right')
  const present = api.panels.some((panel) => panel.id === panelId)
  const panel = present ? api.getPanel(panelId) : undefined
  const target = api.getPanel(targetId)
  const label = (id: string) => sessions.find((session) => session.id === id)?.name ?? id

  const finish = () => {
    dialog.current?.close()
    onCloseRef.current()
    // Son panel kapanınca yerleşim tetikleyicisi de kalkar; yaşayan kromu seç.
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body || document.querySelector('dialog[open]')) return
      const next =
        document.querySelector<HTMLElement>('.grid-layout-action button') ??
        document.querySelector<HTMLElement>('.mobile-navigation button') ??
        document.querySelector<HTMLElement>('.home-nav')
      next?.focus()
    })
  }

  useEffect(() => {
    if (!present) {
      finish()
      return
    }
    const el = dialog.current
    if (el && !el.open) el.showModal()
  }, [present])

  return (
    <>
    <dialog
      ref={dialog}
      className="session-modal"
      aria-labelledby="grid-layout-title"
      onCancel={(event) => {
        event.preventDefault()
        finish()
      }}
    >
      <div className="dialog">
        <h2 id="grid-layout-title">Panel yerleşimi</h2>
        <p className="dialog-sub">{label(panelId)} · Sürükle-bırak ile de yapılabilir; Ctrl basılı bırakmak kopya açar.</p>
        <fieldset className="grid-size-actions"><legend>Bu terminali böl</legend>
          <label htmlFor="grid-add">Eklenecek terminal</label>
          <select id="grid-add" value={addId} onChange={e => setAddId(e.target.value)}>
            {available.length === 0 && <option value="">Eklenebilecek terminal yok</option>}
            {available.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <div className="command-fills">{(['right', 'below'] as const).map(direction => <button key={direction} type="button" disabled={!panel || !addId || api.panels.length >= MAX_GRID_PANELS} onClick={() => {
            const session = available.find(s => s.id === addId)
            if (!panel || !session || api.panels.length >= MAX_GRID_PANELS) return
            api.addPanel({ id: session.id, component: 'terminal', title: session.name, params: { sessionId: session.id }, position: { referenceGroup: panel.api.group, direction } })
            finish()
          }}>{direction === 'right' ? 'Sağa böl' : 'Alta böl'}</button>)}</div>
        </fieldset>
        <fieldset className="grid-size-actions"><legend>Yeni terminal oluştur ve böl</legend>
          <label>Proje<select value={newProjectId} onChange={e => setNewProjectId(e.target.value)}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <div className="command-fills">{(['right', 'below'] as const).map(direction => <button type="button" key={direction} disabled={!healthy || !project || api.panels.length >= MAX_GRID_PANELS} onClick={() => { setNewDirection(direction); setCreatingNew(true) }}>{direction === 'right' ? 'Yeni terminal · sağa' : 'Yeni terminal · alta'}</button>)}</div>
        </fieldset>
        <fieldset className="grid-size-actions"><legend>Başka panelin yanına taşı</legend>
        <label htmlFor="grid-target">Hedef panel</label>
        <select
          id="grid-target"
          value={targetId}
          onChange={(event) => setTargetId(event.target.value)}
          disabled={targets.length === 0}
        >
          {targets.length === 0 && <option value="">Başka panel yok</option>}
          {targets.map((item) => (
            <option key={item.id} value={item.id}>
              {label(item.id)}
            </option>
          ))}
        </select>
        <label htmlFor="grid-position">Konum</label>
        <select id="grid-position" value={position} onChange={(event) => setPosition(event.target.value as Position)}>
          <option value="left">Soluna böl</option>
          <option value="right">Sağına böl</option>
          <option value="top">Üstüne böl</option>
          <option value="bottom">Altına böl</option>
          <option value="center">Aynı gruba sekme olarak taşı</option>
        </select>
        <button
          type="button"
          disabled={!panel || !target}
          onClick={() => {
            if (!panel || !target) return
            panel.api.moveTo({ group: target.api.group, position })
            finish()
          }}
        >
          Paneli taşı
        </button>
        </fieldset>
        <fieldset className="grid-size-actions">
          <legend>Grup boyutu</legend>
          <p className="dialog-note muted">40 piksel adımlarla değişir; komşu gruplar ve kullanılabilir alan sınırlar.</p>
          <div className="command-fills">
            <button type="button" onClick={() => panel?.api.group.api.setSize({ width: Math.max(120, panel.api.group.width - 40) })}>
              Daralt
            </button>
            <button type="button" onClick={() => panel?.api.group.api.setSize({ width: Math.min(api.width, panel.api.group.width + 40) })}>
              Genişlet
            </button>
            <button type="button" onClick={() => panel?.api.group.api.setSize({ height: Math.max(80, panel.api.group.height - 40) })}>
              Kısalt
            </button>
            <button type="button" onClick={() => panel?.api.group.api.setSize({ height: Math.min(api.height, panel.api.group.height + 40) })}>
              Uzat
            </button>
          </div>
        </fieldset>
        <p className="dialog-note muted">Paneli kapatmak oturumu durdurmaz; dosyaları ve terminal geçmişini korur.</p>
        <div className="dialog-actions">
          <button
            type="button"
            onClick={() => {
              panel?.api.close()
              finish()
            }}
          >
            Paneli kapat
          </button>
          <button type="button" onClick={finish}>
            Bitti
          </button>
        </div>
      </div>
    </dialog>
    {creatingNew && project && <NewSessionDialog project={project} works={works.filter(w => w.projectId === project.id)}
      initialWork={(() => { const origin = sessions.find(s => s.id === panelId); return origin?.projectId === project.id ? (origin.workId ?? '') : '' })()} busy={busy} error={error} onCancel={() => { if (!busy) setCreatingNew(false) }} onCreate={input => void create(input)} />}
    </>
  )
}
