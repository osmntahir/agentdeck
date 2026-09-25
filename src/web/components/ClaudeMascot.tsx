import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { agentFor } from '../../shared/agents'
import type { SessionView } from '../../shared/types'

type Mood = 'working' | 'attention' | 'idle' | 'sleeping'
type Trick = 'hop' | 'wiggle' | 'wave' | 'look' | 'heart' | 'spin' | 'stretch' | 'dance' | 'trip'

const TRICKS: Trick[] = ['hop', 'wiggle', 'wave', 'look', 'heart', 'spin', 'stretch', 'dance', 'trip']
/** Bu kadar süre hiçbir Claude oturumunda girdi/çıktı yoksa robot uyur. */
const SLEEP_AFTER_MS = 3 * 60_000
/** Robotla bu kadar süre kimse ilgilenmezse uyur. */
const NEGLECT_AFTER_MS = 2 * 60_000
/** Bu kadar basılı tutmak sevmektir; daha kısası tıklamadır. */
const PET_AFTER_MS = 220
/** Bu kadar süren bir Claude çalışması bitince robot kutlar. */
const CELEBRATE_AFTER_MS = 20_000
const BOT_WIDTH = 46
const LOVE_KEY = 'agentdeck.mascotLove'

const PHRASES: Record<Mood, string[]> = {
  idle: ['Merhaba!', 'Hazırım 🙂', 'Bir kahve? ☕', 'Ne yapıyoruz?', 'Sıkıldım…', 'Kod var mı?', 'Bip bop 🤖'],
  working: ['Düşünüyorum…', 'Yazıyorum ✍️', 'Az kaldı!', 'Hmm…', 'Derliyorum…', 'Testler koşuyor 🏃'],
  attention: ['Bakar mısın?', 'Onay lazım!', 'Buradayım 👋'],
  sleeping: [],
}
const PET_PHRASES = ['Hihi', 'Bir daha!', 'Mırr ♥', 'Çok iyi geldi', '♥ ♥ ♥']

function readLove(): number {
  try { return Number(localStorage.getItem(LOVE_KEY)) || 0 } catch { return 0 }
}
function saveLove(count: number): void {
  try { localStorage.setItem(LOVE_KEY, String(count)) } catch { /* sayaç yalnız bu açılışta kalır */ }
}
function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}
const pick = <T,>(list: T[]): T | undefined => list[Math.floor(Math.random() * list.length)]

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
 * Claude oturumu varken çalışma alanı çubuğunun boş şeridinde gezinen
 * Claude Code robotu. Ruh hali oturumlardan gelir: çalışırken hızlı yürür,
 * onay beklerken durup el sallar, uzun sessizlikte ya da kimse ilgilenmeyince
 * uyur. Gözleriyle fareyi izler, arada numara yapar ve konuşur. Basılı tutmak
 * sever, çift tık kurabiye yedirir, uzun bir iş bitince dans eder. Tıklamak
 * onay bekleyen oturumu açar.
 */
export function ClaudeMascot({ sessions, now, onOpen }: { sessions: SessionView[]; now: number; onOpen: (sessionId: string) => void }) {
  const claude = liveClaudeSessions(sessions)
  const present = claude.length > 0
  const [neglected, setNeglected] = useState(false)
  const baseMood = moodOf(claude, now)
  const mood: Mood = baseMood === 'attention' ? 'attention' : neglected ? 'sleeping' : baseMood
  const [trick, setTrick] = useState<Trick | null>(null)
  const [petting, setPetting] = useState(false)
  const [snack, setSnack] = useState(false)
  const [walking, setWalking] = useState<-1 | 0 | 1>(0)
  const [say, setSay] = useState<{ text: string; side: 'left' | 'right' } | null>(null)
  const [floaters, setFloaters] = useState<{ id: number; x: number; size: number; char: string }[]>([])
  const [love, setLove] = useState(readLove)
  const track = useRef<HTMLDivElement>(null)
  const bot = useRef<HTMLButtonElement>(null)
  const pos = useRef(0)
  const lastTouch = useRef(Date.now())
  const floaterId = useRef(0)
  const press = useRef<{ timer: number; petted: boolean; lastHeart: number } | null>(null)
  /** Sevme bitince tarayıcının ardından gönderdiği click yutulur. */
  const suppressClick = useRef(false)

  const place = () => {
    const width = Math.max(0, (track.current?.clientWidth ?? 0) - BOT_WIDTH)
    pos.current = Math.min(Math.max(0, pos.current), width)
    if (bot.current) bot.current.style.transform = `translateX(${pos.current}px)`
  }

  const float = (char = '♥') => {
    const id = ++floaterId.current
    setFloaters((list) => [...list.slice(-13), { id, x: Math.round(Math.random() * 34) - 6, size: 9 + Math.round(Math.random() * 6), char }])
    window.setTimeout(() => setFloaters((list) => list.filter((f) => f.id !== id)), 1400)
  }

  const speak = (text: string | undefined) => {
    if (!text) return
    // Balon, robotun daha çok boşluk olan tarafına açılır.
    const room = (track.current?.clientWidth ?? 0) - pos.current - BOT_WIDTH
    setSay({ text, side: room > pos.current ? 'right' : 'left' })
  }
  useEffect(() => {
    if (!say) return
    const timer = window.setTimeout(() => setSay(null), 2600)
    return () => window.clearTimeout(timer)
  }, [say])

  /** Kullanıcı ilgilendi: uyuyorsa gerinerek uyanır. */
  const touch = () => {
    lastTouch.current = Date.now()
    if (neglected) {
      setNeglected(false)
      setTrick('stretch')
      speak('Uyandım!')
    }
  }

  // İlk görünüşte çubuğun sağ ucunda durur; çubuk daralırsa içeride kalır.
  useLayoutEffect(() => {
    if (!present) return
    pos.current = Number.MAX_SAFE_INTEGER
    place()
    const observer = new ResizeObserver(place)
    if (track.current) observer.observe(track.current)
    return () => observer.disconnect()
  }, [present])

  // İlgisiz kalınca uyur; onay beklenirse kendiliğinden uyanır.
  useEffect(() => {
    if (!present) return
    const timer = window.setInterval(() => {
      if (Date.now() - lastTouch.current > NEGLECT_AFTER_MS) setNeglected(true)
    }, 5000)
    return () => window.clearInterval(timer)
  }, [present])
  useEffect(() => {
    if (baseMood !== 'attention') return
    lastTouch.current = Date.now()
    setNeglected(false)
  }, [baseMood])

  // Uzun süren bir çalışma bitince (onay beklemeden) dans eder.
  const workingSince = useRef<number | null>(null)
  useEffect(() => {
    if (baseMood === 'working') { workingSince.current ??= Date.now(); return }
    const since = workingSince.current
    workingSince.current = null
    if (since !== null && baseMood === 'idle' && Date.now() - since > CELEBRATE_AFTER_MS) {
      setTrick('dance')
      speak('Bitti! 🎉')
      for (let i = 0; i < 4; i++) window.setTimeout(() => float('✨'), i * 180)
    }
  }, [baseMood])

  const busy = petting || snack || trick !== null
  // Uyanıkken çubukta rastgele bir yere yürür; çalışırken daha hızlı.
  useEffect(() => {
    if (!present || mood === 'sleeping' || mood === 'attention' || busy || reducedMotion()) return
    let raf = 0
    let timer = 0
    let cancelled = false
    const plan = () => {
      timer = window.setTimeout(() => {
        const room = (track.current?.clientWidth ?? 0) - BOT_WIDTH
        if (room < 24) return plan()
        const target = Math.random() * room
        if (Math.abs(target - pos.current) < 12) return plan()
        const dir = target > pos.current ? 1 : -1
        const speed = mood === 'working' ? 40 : 24
        setWalking(dir)
        let last = performance.now()
        const tick = (time: number) => {
          if (cancelled) return
          pos.current += dir * speed * Math.min(0.1, (time - last) / 1000)
          last = time
          if ((dir > 0 && pos.current >= target) || (dir < 0 && pos.current <= target)) {
            pos.current = target
            place()
            setWalking(0)
            plan()
            return
          }
          place()
          raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
      }, 2500 + Math.random() * 6000)
    }
    plan()
    return () => { cancelled = true; window.clearTimeout(timer); cancelAnimationFrame(raf); setWalking(0) }
  }, [present, mood, busy])

  // Gözler yakındaki fareyi izler.
  useEffect(() => {
    if (!present || mood === 'sleeping') return
    let frame = 0
    const onMove = (event: PointerEvent) => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const box = bot.current?.getBoundingClientRect()
        if (!box) return
        const dx = event.clientX - (box.left + box.width / 2)
        const dy = event.clientY - (box.top + box.height / 2)
        const near = Math.abs(dx) < 320 && Math.abs(dy) < 220
        bot.current?.style.setProperty('--gaze', near ? String(Math.max(-1, Math.min(1, dx / 70)) * 0.8) : '0')
      })
    }
    window.addEventListener('pointermove', onMove)
    return () => { window.removeEventListener('pointermove', onMove); cancelAnimationFrame(frame); bot.current?.style.setProperty('--gaze', '0') }
  }, [present, mood])

  // Uyumuyorken 8-20 sn'de bir rastgele numara; bazen konuşur. Aynısı üst üste gelmez.
  useEffect(() => {
    if (!present || mood === 'sleeping') return
    let timer: number
    let last: Trick | null = null
    const schedule = () => {
      timer = window.setTimeout(() => {
        const choices = TRICKS.filter((t) => t !== last && !(mood === 'attention' && t === 'wave'))
        last = pick(choices) ?? 'hop'
        setTrick(last)
        if (Math.random() < 0.4) speak(pick(PHRASES[mood]))
        schedule()
      }, 8000 + Math.random() * 12000)
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [present, mood])

  useEffect(() => {
    if (!trick) return
    if (trick === 'heart') { float(); window.setTimeout(() => float(), 250) }
    const timer = window.setTimeout(() => setTrick(null), trick === 'dance' || trick === 'trip' ? 2200 : 1600)
    return () => window.clearTimeout(timer)
  }, [trick])

  // Sevilirken kalpler düzenli çıkar; fare üstünde gezdikçe (onPointerMove) daha sık.
  useEffect(() => {
    if (!petting) return
    const timer = window.setInterval(() => {
      if (press.current && Date.now() - press.current.lastHeart > 380) { press.current.lastHeart = Date.now(); float() }
    }, 120)
    return () => window.clearInterval(timer)
  }, [petting])

  const endPress = (released: boolean) => {
    const current = press.current
    press.current = null
    if (!current) return
    window.clearTimeout(current.timer)
    if (current.petted) {
      suppressClick.current = true
      setPetting(false)
      if (released) { setTrick('hop'); float(); speak(pick(PET_PHRASES)) }
    }
  }

  // Robot kaybolursa (son Claude oturumu kapandı) basılı tutma yarım kalmasın.
  useEffect(() => { if (!present) endPress(false) }, [present])

  if (!present) return <div className="mascot-track" />
  const waiting = claude.find((s) => s.attention)
  const working = claude.filter((s) => s.activity !== 'idle').length
  const title = [
    `Claude ${LABEL[mood]}`,
    `${claude.length} Claude oturumu${working > 0 ? ` · ${working} çalışıyor` : ''}${waiting ? ` · ${claude.filter((s) => s.attention).length} bekliyor` : ''}`,
    waiting ? `Tıkla: ${waiting.name} oturumuna geç` : 'Tıkla: bir numara yapsın',
    `Basılı tut: sev · çift tık: kurabiye ver${love > 0 ? ` · ${love} kez sevildi ♥` : ''}`,
  ].join('\n')

  return (
    <div className="mascot-track" ref={track}>
      <button
        ref={bot}
        type="button"
        className="claude-mascot"
        data-mood={mood}
        data-trick={petting || snack ? undefined : (trick ?? undefined)}
        data-petting={petting || undefined}
        data-snack={snack || undefined}
        data-walking={walking !== 0 && !busy ? (walking > 0 ? 'right' : 'left') : undefined}
        title={title}
        aria-label={`Claude ${LABEL[mood]}`}
        onPointerEnter={touch}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          touch()
          suppressClick.current = false
          event.currentTarget.setPointerCapture(event.pointerId)
          press.current = {
            petted: false,
            lastHeart: 0,
            timer: window.setTimeout(() => {
              if (!press.current) return
              press.current.petted = true
              setPetting(true)
              setTrick(null)
              setLove((count) => { saveLove(count + 1); return count + 1 })
            }, PET_AFTER_MS),
          }
        }}
        onPointerMove={() => {
          // Okşarken kalpler daha sık çıkar.
          if (press.current?.petted && Date.now() - press.current.lastHeart > 180) { press.current.lastHeart = Date.now(); float() }
        }}
        onPointerUp={() => endPress(true)}
        onPointerCancel={() => endPress(false)}
        onLostPointerCapture={() => endPress(false)}
        onClick={() => {
          // Basılı tutup sevmek tıklama sayılmaz.
          if (suppressClick.current) { suppressClick.current = false; return }
          touch()
          if (waiting) onOpen(waiting.id)
          setTrick(waiting ? 'hop' : pick(TRICKS) ?? 'hop')
        }}
        onDoubleClick={() => {
          if (snack) return
          touch()
          setTrick(null)
          setSnack(true)
          window.setTimeout(() => {
            setSnack(false)
            float(); window.setTimeout(() => float(), 200)
            speak('Nom nom! 🍪')
          }, 1500)
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
              <g className="m-gaze"><g className="m-eyes"><rect x="4" y="1" width="1" height="2" /><rect x="8" y="1" width="1" height="2" /></g></g>
              <g className="m-blush"><rect x="2.6" y="3" width="1.2" height="0.8" /><rect x="9.2" y="3" width="1.2" height="0.8" /></g>
            </g>
          </g>
        </svg>
        {snack && <span className="m-cookie" aria-hidden="true">🍪</span>}
        {mood === 'attention' && <span className="m-bubble" aria-hidden="true">!</span>}
        {mood === 'sleeping' && <span className="m-zzz" aria-hidden="true">z</span>}
        {floaters.map((f) => <span key={f.id} className="m-heart" style={{ left: f.x, fontSize: f.size }} aria-hidden="true">{f.char}</span>)}
        {say && <span className="m-say" data-side={say.side} role="status">{say.text}</span>}
      </button>
    </div>
  )
}
