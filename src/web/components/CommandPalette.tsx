import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { fuzzyScore } from '../../shared/fuzzy'
import { commandLabel, PRESETS, type Preset, type ProjectView, type StateResponse } from '../../shared/types'
import { projectStyle, usePreferences } from '../preferences'
import { stateLabel, statusTone, StatusDot } from '../sessionStatus'
import { AgentMark, ProgramIcon } from './AgentMark'
import { Icon, type IconName } from './Icon'

export interface PaletteCommand {
  id: string
  label: string
  icon: IconName
  hint?: string
  keywords?: string
  run: () => void
}

interface Item {
  id: string
  section: string
  text: string
  run: () => void
  render: ReactNode
}

const TONE_ORDER = { attention: 0, active: 1, idle: 2, orphaned: 3, error: 4, done: 5 } as const

/**
 * Tek giriş noktası: oturuma atla, yeni ajan başlat veya komut çalıştır.
 * Enter seçili satırı çalıştırır; palet kendiliğinden kapanır.
 */
export function CommandPalette({ state, sessionOrder, commands, onSelectSession, onQuickCreate, onClose }: {
  state: StateResponse
  /** Kenar çubuğu sırası; ilk dokuzu Alt+rakam ipucu alır. */
  sessionOrder: string[]
  commands: PaletteCommand[]
  onSelectSession: (id: string) => void
  onQuickCreate: (project: ProjectView, preset: Preset) => void
  onClose: () => void
}) {
  const preferences = usePreferences()
  const dialog = useRef<HTMLDialogElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  useEffect(() => { dialog.current?.showModal() }, [])

  const items = useMemo(() => {
    const searching = query.trim() !== ''
    const scored: Array<Item & { score: number }> = []
    const push = (item: Item) => {
      const score = fuzzyScore(query, item.text)
      if (score !== null) scored.push({ ...item, score })
    }
    const projectName = (id: string) => state.projects.find((p) => p.id === id)?.name ?? ''
    const sessions = state.sessions
      .filter((s) => s.archivedAt === null)
      .map((s, index) => ({ s, index }))
      .sort((a, b) => TONE_ORDER[statusTone(a.s)] - TONE_ORDER[statusTone(b.s)] || a.index - b.index)
    for (const { s } of sessions) {
      const jump = sessionOrder.indexOf(s.id)
      push({
        id: `session:${s.id}`,
        section: 'Oturumlar',
        text: `${s.name} ${projectName(s.projectId)} ${commandLabel(s.command)} ${stateLabel(s)}`,
        run: () => onSelectSession(s.id),
        render: <>
          <span className="palette-lead" style={projectStyle(s.projectId, preferences)}><AgentMark session={s} /><StatusDot session={s} /></span>
          <span className="palette-main"><strong>{s.name}</strong><small>{projectName(s.projectId)} · {stateLabel(s)}</small></span>
          {jump >= 0 && jump < 9 && <kbd>Alt+{jump + 1}</kbd>}
        </>,
      })
    }
    for (const project of state.projects) {
      if (project.degraded) continue
      const last = PRESETS.find((p) => p.label === preferences.lastProgram[project.id]) ?? PRESETS[0]!
      // Aramasızken proje başına yalnız son kullanılan program önerilir; liste boğulmaz.
      for (const preset of searching ? PRESETS : [last]) {
        push({
          id: `new:${project.id}:${preset.label}`,
          section: 'Yeni oturum',
          text: `yeni ${preset.label} ${project.name} başlat`,
          run: () => onQuickCreate(project, preset),
          render: <>
            <span className="palette-lead" style={projectStyle(project.id, preferences)}><ProgramIcon command={preset.command} /></span>
            <span className="palette-main"><strong>{preset.label}</strong><small>{project.name} içinde yeni oturum başlat</small></span>
            <span className="palette-tag">Başlat</span>
          </>,
        })
      }
    }
    for (const command of commands) {
      push({
        id: `cmd:${command.id}`,
        section: 'Komutlar',
        text: `${command.label} ${command.keywords ?? ''}`,
        run: command.run,
        render: <>
          <span className="palette-lead"><Icon name={command.icon} /></span>
          <span className="palette-main"><strong>{command.label}</strong></span>
          {command.hint && <kbd>{command.hint}</kbd>}
        </>,
      })
    }
    const sections = ['Oturumlar', 'Yeni oturum', 'Komutlar']
    return sections.flatMap((section) => {
      const inSection = scored.filter((item) => item.section === section)
      return searching ? inSection.sort((a, b) => b.score - a.score) : inSection
    })
  }, [query, state, sessionOrder, commands, preferences, onSelectSession, onQuickCreate])

  useEffect(() => { setCursor(0) }, [query])
  const active = Math.min(cursor, Math.max(0, items.length - 1))
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (item: Item | undefined) => {
    if (!item) return
    dialog.current?.close()
    onClose()
    item.run()
  }

  return (
    <dialog ref={dialog} className="palette-modal" aria-label="Komut paleti"
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="palette">
        <div className="palette-search">
          <Icon name="search" size={18} />
          <input
            autoFocus
            value={query}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[active] ? `palette-${active}` : undefined}
            aria-label="Oturum, ajan veya komut ara"
            placeholder="Oturuma geç, ajan başlat veya komut ara…"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const delta = event.key === 'ArrowDown' ? 1 : -1
                setCursor((active + delta + items.length) % Math.max(1, items.length))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                choose(items[active])
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list} aria-label="Sonuçlar">
          {items.length === 0 && <p className="palette-empty">“{query}” için sonuç yok.</p>}
          {items.map((item, index) => (
            <Fragment key={item.id}>
              {item.section !== items[index - 1]?.section && <div className="palette-section" role="presentation">{item.section}</div>}
              <div
                id={`palette-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === active}
                className="palette-item"
                onMouseMove={() => { if (index !== active) setCursor(index) }}
                onClick={() => choose(item)}
              >
                {item.render}
              </div>
            </Fragment>
          ))}
        </div>
        <footer className="palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> gezin</span>
          <span><kbd>↵</kbd> seç</span>
          <span><kbd>Alt+1…9</kbd> oturuma atla</span>
          <span><kbd>Ctrl+PgUp/PgDn</kbd> sıradaki</span>
        </footer>
      </div>
    </dialog>
  )
}
