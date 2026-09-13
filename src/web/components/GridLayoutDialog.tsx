import { useEffect, useRef, useState } from 'react'
import type { DockviewApi, Position } from 'dockview-react'
import type { SessionView } from '../../shared/types'

interface Props {
  api: DockviewApi
  panelId: string
  sessions: SessionView[]
  onClose: () => void
}

/** Aynı Dockview taşıma/boyut API'si; terminal tuşlarını yakalayan kısayol yoktur. */
export function GridLayoutDialog({ api, panelId, sessions, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const targets = api.panels.filter((panel) => panel.id !== panelId)
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
        <p>{label(panelId)}</p>
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
  )
}
