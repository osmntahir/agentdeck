import { useEffect, useState } from 'react'
import type { ClaudeAgentView, ConversationSource, ConversationView, SessionView, Work } from '../../shared/types'
import { formatAge } from '../../shared/types'
import { ActionMenu, type MenuPosition } from './ActionMenu'
import { Icon } from './Icon'

const SOURCE_LABELS: Record<ConversationSource, string> = {
  startup: 'yeni',
  resume: 'sürdürüldü',
  clear: '/clear sonrası',
  compact: '/compact sonrası',
  other: 'başladı',
}

/**
 * Bir işin Claude konuşmaları. Liste açıkken tazelenir; kayıt konuşmanın hâlâ
 * açılabildiğini kanıtlamaz, sürdürme CLI'ın kararıdır. Taşıma yalnız
 * AgentDeck'te görünümü değiştirir.
 */
export function ConversationList({ load, sessions, claude, works, currentWorkId, now, onResume, onOpen, onMove, onUnmove }: {
  load: () => Promise<{ conversations: ConversationView[] }>
  sessions: SessionView[]
  /** İşe bağlı Claude oturumları; konuşmanın hangi oturumdan geldiğini adlandırmak için. */
  claude: ClaudeAgentView[]
  /** Taşınabilecek işler (aynı proje). */
  works: Work[]
  currentWorkId: string
  now: number
  onResume: (conversation: ConversationView) => void
  onOpen: (sessionId: string) => void
  onMove: (conversation: ConversationView, workId: string) => Promise<void>
  onUnmove: (conversation: ConversationView) => Promise<void>
}) {
  const [items, setItems] = useState<ConversationView[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ item: ConversationView; position: MenuPosition } | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let cancelled = false
    const read = () => load()
      .then((result) => { if (!cancelled) { setItems(result.conversations); setFailed(null) } })
      .catch((err: Error) => { if (!cancelled) setFailed(err.message) })
    void read()
    const timer = window.setInterval(read, 5000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [load, tick])

  if (failed && !items) return <p className="conversation-empty">Konuşmalar okunamadı: {failed}</p>
  if (!items) return <p className="conversation-empty">Konuşmalar yükleniyor…</p>
  if (items.length === 0) {
    return <p className="conversation-empty">Henüz konuşma yok. Bu işte Claude başlattığında veya bir Claude oturumu bağladığında, <code>/clear</code> sonrası açılanlar dahil burada görünür.</p>
  }
  const others = works.filter((w) => w.id !== currentWorkId)
  const after = (promise: Promise<void>) => { void promise.then(() => setTick((n) => n + 1)) }
  return (
    <>
      <ul className="conversation-list">
        {items.map((item) => {
          const session = sessions.find((s) => s.id === item.sessionId)
          const agent = claude.find((a) => a.id === item.claudeSessionId)
          const topic = item.firstPrompt ?? item.lastPrompt ?? item.title ?? 'İstem yok'
          const age = formatAge(now - (item.updatedAt ?? item.lastSeenAt))
          const origin = item.origin === 'reference'
            ? 'başka yerden taşındı'
            : item.origin === 'claude-session'
              ? `Claude oturumu: ${agent?.name ?? item.claudeSessionId}`
              : (item.source ? SOURCE_LABELS[item.source] : 'terminal')
          return (
            <li key={item.id} className={`conversation-row${item.current ? ' current' : ''}`}>
              <span className="conversation-icon" aria-hidden="true"><Icon name="chat" size={14} /></span>
              <div className="conversation-text">
                <strong title={item.firstPrompt ?? undefined}>{topic}</strong>
                {item.lastPrompt && item.lastPrompt !== topic && <span className="conversation-last" title={item.lastPrompt}>Son: {item.lastPrompt}</span>}
                <span className="conversation-meta">
                  {item.current && <span className="chip live-chip">{item.origin === 'terminal' ? 'Şu an açık' : 'Oturumun güncel konuşması'}</span>}
                  <span>{origin}</span>
                  <span aria-hidden="true">·</span>
                  <span>{age === 'az önce' ? age : `${age} önce`}</span>
                  {session && <><span aria-hidden="true">·</span><span title="Konuşmanın görüldüğü terminal">{session.name}</span></>}
                  {item.title && <><span aria-hidden="true">·</span><span title="Claude'da /rename ile verilen ad; /clear sonrası yeni konuşmaya da kopyalanır">“{item.title}”</span></>}
                  <span aria-hidden="true">·</span><code title="Konuşma kimliği">{item.id.slice(0, 8)}</code>
                </span>
              </div>
              {item.current && item.sessionId
                ? <button className="ghost-button" onClick={() => onOpen(item.sessionId!)}><Icon name="terminal" size={14} /> Aç</button>
                : <button className="ghost-button" onClick={() => onResume(item)} title={item.current && item.claudeSessionId ? `claude attach ${item.claudeSessionId}` : `claude --resume ${item.id}`}><Icon name="play" size={14} /> {item.current ? 'Aç' : 'Sürdür'}</button>}
              <button className="icon-button ghost" title="Taşı" aria-label="Konuşma işlemleri" onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                setMenu({ item, position: { x: rect.left, y: rect.bottom + 4, origin: e.currentTarget } })
              }}><Icon name="more" size={14} /></button>
            </li>
          )
        })}
      </ul>
      {menu && <ActionMenu label="Konuşma işlemleri" position={menu.position} onClose={() => setMenu(null)} actions={[
        ...others.map((work) => ({ label: `“${work.name}” işine taşı`, icon: 'work' as const, run: () => after(onMove(menu.item, work.id)) })),
        ...(menu.item.origin === 'reference' ? [{ label: 'Bu işten çıkar', icon: 'close' as const, description: 'Konuşma asıl yerine döner; Claude dosyası değişmez.', run: () => after(onUnmove(menu.item)) }] : []),
        ...(others.length === 0 && menu.item.origin !== 'reference' ? [{ label: 'Taşınacak başka iş yok', icon: 'work' as const, disabled: true, run: () => undefined }] : []),
      ]} />}
    </>
  )
}
