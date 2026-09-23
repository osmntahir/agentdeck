import { useEffect, useState } from 'react'
import type { ConversationSource, ConversationView, SessionView } from '../../shared/types'
import { formatAge } from '../../shared/types'
import { Icon } from './Icon'

const SOURCE_LABELS: Record<ConversationSource, string> = {
  startup: 'yeni',
  resume: 'sürdürüldü',
  clear: '/clear sonrası',
  compact: '/compact sonrası',
  other: 'başladı',
}

/**
 * Bir işin veya oturumun Claude konuşmaları. Liste açıkken tazelenir; kayıt
 * konuşmanın hâlâ açılabildiğini kanıtlamaz, sürdürme CLI'ın kararıdır.
 */
export function ConversationList({ load, sessions, now, onResume, onOpen }: {
  load: () => Promise<{ conversations: ConversationView[] }>
  sessions: SessionView[]
  now: number
  onResume: (conversation: ConversationView) => void
  onOpen: (sessionId: string) => void
}) {
  const [items, setItems] = useState<ConversationView[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const read = () => load()
      .then((result) => { if (!cancelled) { setItems(result.conversations); setFailed(null) } })
      .catch((err: Error) => { if (!cancelled) setFailed(err.message) })
    void read()
    const timer = window.setInterval(read, 5000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [load])

  if (failed && !items) return <p className="conversation-empty">Konuşmalar okunamadı: {failed}</p>
  if (!items) return <p className="conversation-empty">Konuşmalar yükleniyor…</p>
  if (items.length === 0) {
    return <p className="conversation-empty">Henüz Claude konuşması yok. Bu işte Claude başlattığında, <code>/clear</code> veya <code>/resume</code> yaptığında burada görünür.</p>
  }
  return (
    <ul className="conversation-list">
      {items.map((item) => {
        const session = sessions.find((s) => s.id === item.sessionId)
        const topic = item.firstPrompt ?? item.lastPrompt ?? item.title ?? 'İstem yok'
        const age = formatAge(now - (item.updatedAt ?? item.lastSeenAt))
        return (
          <li key={item.id} className={`conversation-row${item.current ? ' current' : ''}`}>
            <span className="conversation-icon" aria-hidden="true"><Icon name="chat" size={14} /></span>
            <div className="conversation-text">
              <strong title={item.firstPrompt ?? undefined}>{topic}</strong>
              {item.lastPrompt && item.lastPrompt !== topic && <span className="conversation-last" title={item.lastPrompt}>Son: {item.lastPrompt}</span>}
              <span className="conversation-meta">
                {item.current ? <span className="chip live-chip">Şu an açık</span> : <span>{SOURCE_LABELS[item.source]}</span>}
                <span aria-hidden="true">·</span>
                <span>{age === 'az önce' ? age : `${age} önce`}</span>
                {session && <><span aria-hidden="true">·</span><span title="Konuşmanın görüldüğü terminal">{session.name}</span></>}
                {item.title && <><span aria-hidden="true">·</span><span title="Claude'da /rename ile verilen ad; /clear sonrası yeni konuşmaya da kopyalanır">“{item.title}”</span></>}
              </span>
            </div>
            {item.current
              ? <button className="ghost-button" onClick={() => onOpen(item.sessionId)}><Icon name="terminal" size={14} /> Aç</button>
              : <button className="ghost-button" onClick={() => onResume(item)} title={`claude --resume ${item.id}`}><Icon name="play" size={14} /> Sürdür</button>}
          </li>
        )
      })}
    </ul>
  )
}
