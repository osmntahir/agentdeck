import { useEffect, useState } from 'react'
import { agentFor } from '../../shared/agents'
import type { SessionView } from '../../shared/types'

type Mood = 'working' | 'attention' | 'idle' | 'sleeping'
type Trick = 'hop' | 'wiggle' | 'wave' | 'look' | 'heart' | 'spin' | 'stretch'

const TRICKS: Trick[] = ['hop', 'wiggle', 'wave', 'look', 'heart', 'spin', 'stretch']
/** Bu kadar süre hiçbir Claude oturumunda girdi/çıktı yoksa robot uyur. */
const SLEEP_AFTER_MS = 3 * 60_000

/** Claude çalıştıran canlı oturumlar: ön plandaki program ya da başlangıç komutu claude ise. */
export function liveClaudeSessions(sessions: SessionView[]): SessionView[] {
  return sessions.filter((s) => s.archivedAt === null && s.lifecycle === 'live' &&
    agentFor((s.foregroundAgent ?? s.command ?? '').trim().split(/\s+/)[0])?.command === 'claude')
}

function moodOf(claude: SessionView[], now: number): Mood {
  if (claude.some((s) => s.attention)) return 'attention'
  if (claude.some((s) => s.activity !== 'idle')) return 'working'
  const last = Math.max(0, ...claude.map((s) => s.lastActivityAt ?? 0))
  return now - last > SLEEP_AFTER_MS ? 'sleeping' : 'idle'
}

const LABEL: Record<Mood, string> = {
  working: 'çalışıyor',
  attention: 'seni bekliyor',
  idle: 'hazır',
  sleeping: 'uyuyor',
}

/**
 * Claude oturumu varken çalışma alanının sağ üstünde duran Claude Code
 * robotu. Ruh hali oturumlardan gelir: çalışırken yürür, onay beklerken el
 * sallar, uzun sessizlikte uyur; arada kendiliğinden küçük hareketler yapar.
 * Tıklamak onay bekleyen oturumu açar, yoksa bir hareket yaptırır.
 */
export function ClaudeMascot({ sessions, now, onOpen }: { sessions: SessionView[]; now: number; onOpen: (sessionId: string) => void }) {
  const claude = liveClaudeSessions(sessions)
  const mood = moodOf(claude, now)
  const [trick, setTrick] = useState<Trick | null>(null)
  const present = claude.length > 0

  // Uyumuyorken 8-20 sn'de bir rastgele küçük bir hareket; aynısı üst üste gelmez.
  useEffect(() => {
    if (!present || mood === 'sleeping') return
    let timer: number
    let last: Trick | null = null
    const schedule = () => {
      timer = window.setTimeout(() => {
        const choices = TRICKS.filter((t) => t !== last && !(mood === 'attention' && t === 'wave'))
        last = choices[Math.floor(Math.random() * choices.length)] ?? 'hop'
        setTrick(last)
        schedule()
      }, 8000 + Math.random() * 12000)
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [present, mood])

  useEffect(() => {
    if (!trick) return
    const timer = window.setTimeout(() => setTrick(null), 1600)
    return () => window.clearTimeout(timer)
  }, [trick])

  if (!present) return null
  const waiting = claude.find((s) => s.attention)
  const working = claude.filter((s) => s.activity !== 'idle').length
  const title = [
    `Claude ${LABEL[mood]}`,
    `${claude.length} Claude oturumu${working > 0 ? ` · ${working} çalışıyor` : ''}${waiting ? ` · ${claude.filter((s) => s.attention).length} bekliyor` : ''}`,
    waiting ? `Tıkla: ${waiting.name} oturumuna geç` : 'Tıkla: bir numara yapsın',
  ].join('\n')

  return (
    <button
      type="button"
      className="claude-mascot"
      data-mood={mood}
      data-trick={trick ?? undefined}
      title={title}
      aria-label={`Claude ${LABEL[mood]}`}
      onClick={() => {
        if (waiting) onOpen(waiting.id)
        setTrick(waiting ? 'hop' : TRICKS[Math.floor(Math.random() * TRICKS.length)]!)
      }}
    >
      <svg viewBox="-1 -3 15 11" aria-hidden="true" shapeRendering="crispEdges">
        <g className="m-all">
          <g className="m-legs-a"><rect x="3" y="5" width="1" height="2" /><rect x="7" y="5" width="1" height="2" /></g>
          <g className="m-legs-b"><rect x="5" y="5" width="1" height="2" /><rect x="9" y="5" width="1" height="2" /></g>
          <g className="m-body">
            <rect x="2" y="0" width="9" height="5" />
            <rect className="m-arm-l" x="0" y="2" width="2" height="2" />
            <rect className="m-arm-r" x="11" y="2" width="2" height="2" />
            <g className="m-eyes"><rect x="4" y="1" width="1" height="2" /><rect x="8" y="1" width="1" height="2" /></g>
          </g>
        </g>
      </svg>
      {mood === 'attention' && <span className="m-bubble" aria-hidden="true">!</span>}
      {mood === 'sleeping' && <span className="m-zzz" aria-hidden="true">z</span>}
      {trick === 'heart' && <span className="m-heart" aria-hidden="true">♥</span>}
    </button>
  )
}
