import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { fuzzyScore } from '../../shared/fuzzy'
import { commandLabel, formatAge, PRESETS, type ConversationSearchHit, type ConversationView, type Preset, type ProjectView, type StateResponse } from '../../shared/types'
import { searchConversations } from '../api'
import { projectStyle, usePreferences } from '../preferences'
import { stateLabel, statusTone, StatusDot } from '../sessionStatus'
import { AgentMark, ProgramIcon } from './AgentMark'
import { Icon, type IconName } from './Icon'
import { SHORTCUT_LABELS } from '../../shared/shortcuts'

export interface PaletteCommand {
  id: string
  label: string
  icon: IconName
  hint?: string
  keywords?: string
  /** Palet açık kalır (ör. arama kapsamını değiştiren komut). */
  keepOpen?: boolean
  run: () => void
}

interface Item {
  id: string
  section: string
  text: string
  run: () => void
  render: ReactNode
  /** Palet açık kalır (ör. kapsam değiştiren satır). */
  keepOpen?: boolean
}

const TONE_ORDER = { attention: 0, active: 1, idle: 2, orphaned: 3, error: 4, done: 5 } as const

export type PaletteScope = 'all' | 'conversations'

/** Genel palette konuşma araması bu uzunluktan sonra başlar; konuşma kapsamında ilk harfte. */
const ALL_SCOPE_MIN_CHARS = 3
/** Genel palette gösterilen en çok konuşma sonucu; kalanı konuşma kapsamında. */
const ALL_SCOPE_HITS = 4

interface SearchState {
  query: string
  hits: ConversationSearchHit[]
  pending: number
  loading: boolean
  error: string | null
}

/** Sorgu değiştikçe (kısa gecikmeyle) arar; dizin dolarken sonuçlar kendiliğinden tazelenir. */
function useConversationSearch(query: string, enabled: boolean): SearchState {
  const [state, setState] = useState<SearchState>({ query: '', hits: [], pending: 0, loading: false, error: null })
  const [round, setRound] = useState(0)
  useEffect(() => {
    if (!enabled) {
      setState({ query: '', hits: [], pending: 0, loading: false, error: null })
      return
    }
    const controller = new AbortController()
    setState((current) => ({ ...current, loading: true }))
    let retry: number | undefined
    const timer = window.setTimeout(() => {
      searchConversations(query, controller.signal)
        .then((result) => {
          setState({ query, hits: result.hits, pending: result.pending, loading: false, error: null })
          if (result.pending > 0) retry = window.setTimeout(() => setRound((n) => n + 1), 500)
        })
        .catch((err: Error) => {
          if (!controller.signal.aborted) setState({ query, hits: [], pending: 0, loading: false, error: err.message })
        })
    }, round === 0 ? 160 : 0)
    return () => { controller.abort(); window.clearTimeout(timer); window.clearTimeout(retry) }
  }, [query, enabled, round])
  useEffect(() => { setRound(0) }, [query])
  return state
}

function Highlighted({ text, ranges }: { text: string; ranges: Array<[number, number]> }) {
  const parts: ReactNode[] = []
  let at = 0
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start))
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>)
    at = end
  }
  parts.push(text.slice(at))
  return <>{parts}</>
}

/**
 * Tek giriş noktası: oturuma atla, yeni ajan başlat veya komut çalıştır.
 * Enter seçili satırı çalıştırır; palet kendiliğinden kapanır.
 */
export function CommandPalette({ state, sessionOrder, commands, scope, onScope, onSelectSession, onQuickCreate, onResumeConversation, onClose }: {
  state: StateResponse
  /** Kenar çubuğu sırası; ilk dokuzu Alt+rakam ipucu alır. */
  sessionOrder: string[]
  commands: PaletteCommand[]
  onSelectSession: (id: string) => void
  onQuickCreate: (project: ProjectView, preset: Preset) => void
  /** conversations: yalnız konuşma metninde arar (Ctrl+Shift+F). */
  scope: PaletteScope
  onScope: (scope: PaletteScope) => void
  onResumeConversation: (conversation: ConversationView, projectId: string) => void
  onClose: () => void
}) {
  const preferences = usePreferences()
  const dialog = useRef<HTMLDialogElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => { input.current?.focus() }, [scope])
  const trimmed = query.trim()
  const conversationsOnly = scope === 'conversations'
  const search = useConversationSearch(trimmed, trimmed.length >= (conversationsOnly ? 1 : ALL_SCOPE_MIN_CHARS))

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
        keepOpen: command.keepOpen,
        render: <>
          <span className="palette-lead"><Icon name={command.icon} /></span>
          <span className="palette-main"><strong>{command.label}</strong></span>
          {command.hint && <kbd>{command.hint}</kbd>}
        </>,
      })
    }
    const sections = ['Oturumlar', 'Yeni oturum', 'Komutlar']
    const local: Item[] = conversationsOnly ? [] : sections.flatMap((section) => {
      const inSection = scored.filter((item) => item.section === section)
      return searching ? inSection.sort((a, b) => b.score - a.score) : inSection
    })
    // Sunucu sırası korunur: en çok terimi taşıyan, sonra en yeni konuşma.
    const hits = search.query === trimmed ? search.hits : []
    const shown = conversationsOnly ? hits : hits.slice(0, ALL_SCOPE_HITS)
    const conversationItems: Item[] = shown.map((hit) => conversationItem(hit, projectName(hit.projectId)))
    if (!conversationsOnly && hits.length > shown.length) {
      conversationItems.push({
        id: 'conversations:more',
        section: 'Konuşmalar',
        text: '',
        run: () => onScope('conversations'),
        render: <>
          <span className="palette-lead"><Icon name="search" /></span>
          <span className="palette-main"><strong>Bütün konuşma sonuçları</strong><small>{hits.length}{search.pending > 0 ? '+' : ''} konuşmada geçiyor</small></span>
          <kbd>{SHORTCUT_LABELS.searchConversations}</kbd>
        </>,
        keepOpen: true,
      })
    }
    return [...local, ...conversationItems]
  }, [query, state, sessionOrder, commands, preferences, onSelectSession, onQuickCreate, search, trimmed, conversationsOnly, onScope])

  function conversationItem(hit: ConversationSearchHit, project: string): Item {
    const c = hit.conversation
    const open = c.current && c.sessionId !== null
    const title = c.title ?? c.firstPrompt ?? c.lastPrompt ?? 'İstem yok'
    const age = formatAge(Date.now() - (hit.snippet.at ?? c.updatedAt ?? c.lastSeenAt))
    // Eşleşme başlıktaki istemin kendisiyse aynı metin iki kez yazılmaz: vurgu başlığa geçer.
    const bare = (text: string) => text.replace(/…/g, '').replace(/\s+/g, ' ').trim()
    const inTitle = hit.snippet.role === 'user' && bare(title).startsWith(bare(hit.snippet.text).slice(0, 60))
    const secondary = inTitle ? (c.lastPrompt && bare(c.lastPrompt) !== bare(title) ? c.lastPrompt : null) : null
    return {
      id: `conversation:${c.id}`,
      section: 'Konuşmalar',
      text: '',
      run: () => (open ? onSelectSession(c.sessionId!) : onResumeConversation(c, hit.projectId)),
      render: <>
        <span className="palette-lead" style={projectStyle(hit.projectId, preferences)}><Icon name="chat" /></span>
        <span className="palette-main palette-conversation">
          {inTitle ? <>
            <strong><Highlighted text={hit.snippet.text} ranges={hit.snippet.ranges} /></strong>
            {secondary && <small>Son istem: {secondary}</small>}
          </> : <>
            <strong>{title}</strong>
            <small className="palette-snippet">
              <span className="palette-role" data-role={hit.snippet.role}>{hit.snippet.role === 'user' ? 'Sen' : 'Ajan'}</span>
              <Highlighted text={hit.snippet.text} ranges={hit.snippet.ranges} />
            </small>
          </>}
        </span>
        <span className="palette-hit-meta">
          {open ? <span className="palette-tag live">Açık</span> : <span className="palette-tag">Sürdür</span>}
          <small>{project} · {age === 'az önce' ? age : `${age} önce`}{hit.matches > 1 ? ` · ${hit.matches} mesaj` : ''}</small>
        </span>
      </>,
    }
  }

  useEffect(() => { setCursor(0) }, [query])
  const active = Math.min(cursor, Math.max(0, items.length - 1))
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  function emptyMessage(): string {
    if (!conversationsOnly) return search.loading ? 'Aranıyor…' : `“${query}” için sonuç yok.`
    if (trimmed === '') return 'İstemlerinde veya ajan yanıtlarında geçen bir kelime yaz.'
    if (search.error) return `Konuşmalar aranamadı: ${search.error}`
    if (search.loading || search.query !== trimmed || search.pending > 0) return 'Konuşmalar aranıyor…'
    return `“${trimmed}” geçen konuşma yok.`
  }

  /** Dizin dolarken sonuçların eksik olabileceği söylenir. */
  function searchStatus(): string | null {
    if (search.query !== trimmed || trimmed === '') return null
    if (search.pending > 0) return `${search.pending} konuşma daha taranıyor…`
    return null
  }

  const choose = (item: Item | undefined) => {
    if (!item) return
    if (item.keepOpen) {
      // Komutla kapsam değişince komut adını aramak anlamsızdır; sonuç satırından gelince sorgu korunur.
      if (item.id.startsWith('cmd:')) setQuery('')
      item.run()
      return
    }
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
          <Icon name={conversationsOnly ? 'chat' : 'search'} size={18} />
          {conversationsOnly && (
            <button className="palette-scope" title="Genel aramaya dön (boşken ⌫)" onClick={() => onScope('all')}>
              Konuşmalar <Icon name="close" size={12} />
            </button>
          )}
          <input
            ref={input}
            autoFocus
            value={query}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[active] ? `palette-${active}` : undefined}
            aria-label={conversationsOnly ? 'Konuşmalarda ara' : 'Oturum, ajan veya komut ara'}
            placeholder={conversationsOnly ? 'Bütün Claude konuşmalarında ara: istem, yanıt, dosya adı…' : 'Oturuma geç, ajan başlat veya komut ara…'}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Backspace' && query === '' && conversationsOnly) {
                event.preventDefault()
                onScope('all')
                return
              }
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
          {items.length === 0 && <p className="palette-empty">{emptyMessage()}</p>}
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
          {items.length > 0 && searchStatus() && <p className="palette-status" role="status">{searchStatus()}</p>}
        </div>
        <footer className="palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> gezin</span>
          {conversationsOnly ? <>
            <span><kbd>↵</kbd> sürdür veya aç</span>
            <span><kbd>⌫</kbd> genel aramaya dön</span>
            <span className="palette-footer-note">Araç çıktıları aranmaz</span>
          </> : <>
            <span><kbd>↵</kbd> seç</span>
            <span><kbd>{SHORTCUT_LABELS.searchConversations}</kbd> konuşmalarda ara</span>
            <span><kbd>Alt+1…9</kbd> oturuma atla</span>
          </>}
        </footer>
      </div>
    </dialog>
  )
}
