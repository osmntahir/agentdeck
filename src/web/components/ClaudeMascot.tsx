import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { agentFor } from '../../shared/agents'
import type { SessionView } from '../../shared/types'
import { ACCESSORIES, currentHappiness, daysTogether, isHungry, milestoneMessage, withHappiness, type AccessoryId, type MascotStats } from '../../shared/mascotStats'
import { dayKey, dayPart, GREETINGS, specialDay, type DayPart, type SpecialDay } from '../../shared/mascotCalendar'
import { loadStats, saveStats } from '../mascotStorage'
import { usePreferences } from '../preferences'
import { ActionMenu, type MenuAction, type MenuPosition } from './ActionMenu'

type Mood = 'working' | 'attention' | 'idle' | 'sleeping'
type Trick =
  | 'hop' | 'wiggle' | 'wave' | 'look' | 'heart' | 'spin' | 'stretch' | 'dance' | 'trip'
  | 'giggle' | 'sneeze' | 'read' | 'whistle' | 'draw' | 'butterfly' | 'coffee' | 'yawn' | 'dizzy'
/** Sahne: robotun kendi başına yürüttüğü, gezinmeyi ve numaraları durduran iş. */
type Scene = 'fetch' | 'hide' | 'drag' | 'fall' | 'comeback' | null

const DURATION: Partial<Record<Trick, number>> = { dance: 2200, trip: 2200, read: 4200, whistle: 3200, draw: 3200, butterfly: 5200, coffee: 3400, yawn: 1900, dizzy: 2400, giggle: 1300 }
const PLAY: Trick[] = ['hop', 'wiggle', 'wave', 'look', 'heart', 'spin', 'stretch', 'dance', 'trip', 'sneeze']
const HOBBIES: Trick[] = ['read', 'whistle', 'draw', 'butterfly']
/** Bu kadar süre hiçbir Claude oturumunda girdi/çıktı yoksa robot uyur. */
const SLEEP_AFTER_MS = 3 * 60_000
/** Robotla bu kadar süre kimse ilgilenmezse uyur; gece daha çabuk. */
const NEGLECT_AFTER_MS = 2 * 60_000
const NIGHT_NEGLECT_AFTER_MS = 45_000
/** Bu kadar basılı tutmak sevmektir; öncesinde bu kadar kayarsa sürüklemedir. */
const PET_AFTER_MS = 220
const DRAG_AFTER_PX = 6
/** Bu kadar yüksekten bırakılırsa başı döner. */
const DIZZY_FALL_PX = 120
/** Bu kadar süren bir Claude çalışması bitince robot kutlar. */
const CELEBRATE_AFTER_MS = 20_000
/** Pencereye bu kadar süre bakılmazsa dönüşte "Neredeydin?" der. */
const AWAY_MS = 5 * 60_000
const BOT_WIDTH = 46
const BOT_TOP = 3

const PHRASES: Record<Mood, string[]> = {
  idle: ['Merhaba!', 'Hazırım 🙂', 'Ne yapıyoruz?', 'Sıkıldım…', 'Kod var mı?', 'Bip bop 🤖', 'Top oynayalım mı? 🎾'],
  working: ['Düşünüyorum…', 'Yazıyorum ✍️', 'Az kaldı!', 'Hmm…', 'Derliyorum…', 'Testler koşuyor 🏃'],
  attention: ['Bakar mısın?', 'Onay lazım!', 'Buradayım 👋'],
  sleeping: [],
}
const PART_PHRASES: Partial<Record<DayPart, string[]>> = {
  morning: ['Günaydın ☀️', 'Kahvaltı yaptın mı?'],
  noon: ['Öğle arası mı? 🍽️', 'Bir kahve? ☕'],
  night: ['Hâlâ mı çalışıyoruz? 🌙', 'Uykum geldi…', 'Yarın devam etsek?'],
}
const PET_PHRASES = ['Hihi', 'Bir daha!', 'Mırr ♥', 'Çok iyi geldi', '♥ ♥ ♥']
const TICKLE_PHRASES = ['Hihi! 😆', 'Gıdıklanıyorum!', 'Dur dur 😂', 'Kıkıkı']
const SNEEZE_PHRASES = ['Hapşu!', 'Hap-hapşu!']

const pick = <T,>(list: T[]): T | undefined => list[Math.floor(Math.random() * list.length)]
function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/** Claude çalıştıran canlı oturumlar: ön plandaki program ya da başlangıç komutu claude ise. */
export function liveClaudeSessions(sessions: SessionView[]): SessionView[] {
  return sessions.filter((s) => s.archivedAt === null && s.lifecycle === 'live' &&
    agentFor((s.foregroundAgent ?? s.command ?? '').trim().split(/\s+/)[0])?.command === 'claude')
}

function claudeMood(claude: SessionView[], now: number): Mood {
  if (claude.length === 0) return 'idle'
  if (claude.some((s) => s.attention)) return 'attention'
  if (claude.some((s) => s.activity !== 'idle')) return 'working'
  const last = Math.max(0, ...claude.map((s) => s.lastActivityAt ?? 0))
  return now - last > SLEEP_AFTER_MS ? 'sleeping' : 'idle'
}

const LABEL: Record<Mood, string> = { working: 'çalışıyor', attention: 'seni bekliyor', idle: 'hazır', sleeping: 'uyuyor' }

/** Aksesuarın piksel çizimi; birim robotun ızgarasıdır. */
function Accessory({ id, special, galatasaray }: { id: AccessoryId | null; special: SpecialDay | null; galatasaray: boolean }) {
  const party = special === 'newyear' || special === 'birthday' || special === 'robotday'
  return (
    <g className="m-accessory">
      {id === 'scarf' || (!id && galatasaray) ? (
        <g className="m-scarf">
          {galatasaray
            ? [0, 1, 2, 3, 4, 5].map((i) => <rect key={i} x={2 + i * 1.5} y="3.6" width="1.5" height="1" fill={i % 2 ? '#a90432' : '#fdb912'} />)
            : <rect x="2" y="3.6" width="9" height="1" />}
          <rect x="8.5" y="4.4" width="1" height="1.8" fill={galatasaray ? '#a90432' : undefined} />
        </g>
      ) : null}
      {id === 'glasses' && <g className="m-glasses"><rect x="3.3" y="0.9" width="2.4" height="1.4" /><rect x="7.3" y="0.9" width="2.4" height="1.4" /><rect x="5.6" y="1.3" width="1.8" height="0.4" /></g>}
      {id === 'hat' && !party && <g className="m-hat"><rect x="4" y="-2.6" width="5" height="2.4" /><rect x="3" y="-0.4" width="7" height="0.6" /><rect className="m-hat-band" x="4" y="-0.9" width="5" height="0.5" /></g>}
      {id === 'crown' && !party && <polygon className="m-crown" points="3.5,0 3.5,-1.9 5,-0.9 6.5,-2.5 8,-0.9 9.5,-1.9 9.5,0" />}
      {id === 'bow' && <g className="m-bow"><polygon points="8.4,-1.4 10,-0.6 8.4,0.2" /><polygon points="11.6,-1.4 10,-0.6 11.6,0.2" /><rect x="9.6" y="-0.9" width="0.8" height="0.7" /></g>}
      {party && <g className="m-party"><polygon points="6.5,-3.4 4.9,0 8.1,0" /><rect className="m-party-pom" x="6" y="-3.9" width="1" height="1" /></g>}
    </g>
  )
}

/**
 * Çalışma alanı çubuğunun boş şeridinde yaşayan Claude Code robotu.
 * Oturumlardan bağımsız bir yol arkadaşı: gezinir, sevilir, top getirir,
 * saklanır, sürüklenip bırakılır, günün saatine ve özel günlere göre
 * davranır, aksesuar takar. Claude oturumu varsa onun durumuna da tepki
 * verir (çalışırken koşar, onay beklerken el sallar). Durumu yalnız bu
 * profilde saklanır.
 */
export function ClaudeMascot({ sessions, now, onOpen }: { sessions: SessionView[]; now: number; onOpen: (sessionId: string) => void }) {
  const { theme } = usePreferences()
  const claude = liveClaudeSessions(sessions)
  const clock = new Date(now)
  const part = dayPart(clock)
  const [stats, setStatsState] = useState<MascotStats>(() => loadStats(Date.now()))
  const statsRef = useRef(stats)
  const setStats = (next: MascotStats) => { statsRef.current = next; saveStats(next); setStatsState(next) }
  const special = specialDay(clock, stats.birthday, stats.firstSeen)
  const happiness = currentHappiness(stats, now)
  const hungry = isHungry(stats, now)
  const [neglected, setNeglected] = useState(false)
  const baseMood = claudeMood(claude, now)
  const mood: Mood = baseMood === 'attention' ? 'attention' : neglected ? 'sleeping' : baseMood
  const [trick, setTrick] = useState<Trick | null>(null)
  const [scene, setSceneState] = useState<Scene>(null)
  const sceneRef = useRef<Scene>(null)
  const setScene = (next: Scene) => { sceneRef.current = next; setSceneState(next) }
  const [petting, setPetting] = useState(false)
  const [snack, setSnack] = useState(false)
  const [typing, setTyping] = useState(false)
  const [walking, setWalking] = useState<-1 | 0 | 1>(0)
  const [ball, setBall] = useState<{ x: number; carried: boolean } | null>(null)
  const [doodles, setDoodles] = useState<{ id: number; x: number; color: string }[]>([])
  const [say, setSay] = useState<{ text: string; side: 'left' | 'right' } | null>(null)
  const [floaters, setFloaters] = useState<{ id: number; x: number; size: number; char: string; kind?: string }[]>([])
  const [menu, setMenu] = useState<MenuPosition | null>(null)
  const [birthdayOpen, setBirthdayOpen] = useState(false)
  const track = useRef<HTMLDivElement>(null)
  const bot = useRef<HTMLButtonElement>(null)
  const pos = useRef(Number.MAX_SAFE_INTEGER)
  const lastTouch = useRef(Date.now())
  const idCounter = useRef(0)
  const walkToken = useRef(0)
  /** Süren yürüyüşü kim başlattı; gezinme yalnız kendi yürüyüşünü iptal eder. */
  const walkOwner = useRef<'wander' | 'scene' | null>(null)
  const press = useRef<{ timer: number; petted: boolean; lastHeart: number; startX: number; startY: number; grabX: number; grabY: number; dragging: boolean } | null>(null)
  const tickle = useRef<{ dir: number; flips: number[] }>({ dir: 0, flips: [] })
  const tickledAt = useRef(0)
  /** Sevme ya da sürükleme bitince tarayıcının ardından gönderdiği click yutulur. */
  const suppressClick = useRef(false)
  const closeMenu = useCallback(() => setMenu(null), [])

  const busy = petting || snack || trick !== null || scene !== null
  const galatasaray = theme === 'galatasaray'

  // --- yardımcılar -----------------------------------------------------------

  const room = () => Math.max(0, (track.current?.clientWidth ?? 0) - BOT_WIDTH)
  const place = () => {
    pos.current = Math.min(Math.max(0, pos.current), room())
    const el = bot.current
    if (el && el.style.position !== 'fixed') el.style.transform = `translateX(${pos.current}px)`
  }

  const float = (char = '♥', kind?: string) => {
    const id = ++idCounter.current
    setFloaters((list) => [...list.slice(-15), { id, x: Math.round(Math.random() * 34) - 6, size: 9 + Math.round(Math.random() * 6), char, kind }])
    window.setTimeout(() => setFloaters((list) => list.filter((f) => f.id !== id)), kind === 'orbit' ? 2400 : 1500)
  }

  const speak = (text: string | undefined) => {
    if (!text) return
    // Balon, robotun daha çok boşluk olan tarafına açılır.
    setSay({ text, side: room() - pos.current > pos.current ? 'right' : 'left' })
  }

  /** Sayacı ve mutluluğu günceller; eşik geçildiyse kutlar. */
  const reward = (change: (s: MascotStats) => MascotStats, joy: number) => {
    const before = statsRef.current
    const after = withHappiness(change(before), Date.now(), joy)
    setStats(after)
    const message = milestoneMessage(before, after)
    if (!message) return
    window.setTimeout(() => {
      setTrick('dance')
      speak(message)
      for (let i = 0; i < 5; i++) window.setTimeout(() => float(pick(['✨', '🎉', '⭐'])), i * 160)
    }, 700)
  }
  const updateStats = (change: (s: MascotStats) => MascotStats) => setStats(change(statsRef.current))

  /** Kullanıcı ilgilendi: uyuyorsa gerinerek uyanır. */
  const touch = () => {
    lastTouch.current = Date.now()
    if (neglected) {
      setNeglected(false)
      setTrick('stretch')
      speak(part === 'night' ? 'Mmh… buradayım 🌙' : 'Uyandım!')
    }
  }

  /** Hedefe yürür; yeni bir yürüyüş ya da iptal eski yürüyüşü bitirir. */
  const walkTo = (target: number, speed: number, owner: 'wander' | 'scene' = 'scene') => new Promise<boolean>((resolve) => {
    const token = ++walkToken.current
    walkOwner.current = owner
    const goal = Math.min(Math.max(0, target), room())
    if (Math.abs(goal - pos.current) < 1 || reducedMotion()) { pos.current = goal; place(); resolve(true); return }
    const dir = goal > pos.current ? 1 : -1
    setWalking(dir)
    let last = performance.now()
    const tick = (time: number) => {
      if (walkToken.current !== token) { resolve(false); return }
      pos.current += dir * speed * Math.min(0.1, (time - last) / 1000)
      last = time
      if ((dir > 0 && pos.current >= goal) || (dir < 0 && pos.current <= goal)) {
        pos.current = goal
        place()
        setWalking(0)
        resolve(true)
        return
      }
      place()
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const stopWalking = (owner?: 'wander') => {
    if (owner && walkOwner.current !== owner) return
    walkToken.current += 1
    walkOwner.current = null
    setWalking(0)
  }
  const walkSpeed = (base: number) => base * (part === 'night' ? 0.6 : 1) * (happiness < 30 ? 0.7 : 1) * (mood === 'working' || typing ? 1.6 : 1)

  // --- yerleşim ve süreler ---------------------------------------------------

  // İlk görünüşte çubuğun sağ ucunda durur; çubuk daralırsa içeride kalır.
  useLayoutEffect(() => {
    place()
    const observer = new ResizeObserver(place)
    if (track.current) observer.observe(track.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!say) return
    const timer = window.setTimeout(() => setSay(null), 2800)
    return () => window.clearTimeout(timer)
  }, [say])

  useEffect(() => {
    if (!trick) return
    if (trick === 'heart') { float(); window.setTimeout(() => float(), 250) }
    if (trick === 'whistle') for (let i = 0; i < 4; i++) window.setTimeout(() => float(pick(['♪', '♫'])), i * 600)
    if (trick === 'dizzy') float('💫', 'orbit')
    if (trick === 'sneeze') speak(pick(SNEEZE_PHRASES))
    if (trick === 'coffee') speak('Kahve molası ☕')
    if (trick === 'yawn') speak('Aaahh… 🥱')
    if (trick === 'read') speak(pick(['Güzel kitap 📖', 'Hmm, ilginç…']))
    if (trick === 'draw') {
      // Yürüdüğü yere birkaç piksel bırakır; birkaç saniye sonra silinir.
      for (let i = 0; i < 5; i++) window.setTimeout(() => {
        const id = ++idCounter.current
        setDoodles((list) => [...list.slice(-20), { id, x: pos.current + 8 + Math.random() * 30, color: pick(['#8b9cff', '#6fd49c', '#f2b36b', '#f08aa6', '#5ec8e5'])! }])
        window.setTimeout(() => setDoodles((list) => list.filter((d) => d.id !== id)), 6000)
      }, i * 450)
    }
    const timer = window.setTimeout(() => setTrick(null), DURATION[trick] ?? 1600)
    return () => window.clearTimeout(timer)
  }, [trick])

  // --- ilgi, uyku, selam -----------------------------------------------------

  // İlgisiz kalınca uyur (gece daha çabuk); onay beklenirse kendiliğinden uyanır.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const limit = dayPart(new Date()) === 'night' ? NIGHT_NEGLECT_AFTER_MS : NEGLECT_AFTER_MS
      if (Date.now() - lastTouch.current > limit && !press.current) setNeglected(true)
    }, 5000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (baseMood !== 'attention') return
    lastTouch.current = Date.now()
    setNeglected(false)
  }, [baseMood])

  // Günün ilk görüşmesinde selam: özel gün, sabah ya da gece.
  useEffect(() => {
    const today = dayKey(new Date())
    if (stats.greetedOn === today) return
    const timer = window.setTimeout(() => {
      updateStats((s) => ({ ...s, greetedOn: today }))
      if (special) {
        setTrick('dance')
        speak(GREETINGS[special])
        for (let i = 0; i < 5; i++) window.setTimeout(() => float(special === 'valentine' ? '♥' : pick(['🎉', '✨', '⭐'])), i * 180)
      } else if (part === 'morning') { setTrick('yawn'); window.setTimeout(() => speak('Günaydın! ☀️'), 1900) }
      else speak(part === 'night' ? 'İyi geceler 🌙' : 'Merhaba! 👋')
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [stats.greetedOn, special, part])

  // Uzun süre pencereye bakılmazsa dönüşte koşup gelir.
  useEffect(() => {
    let awaySince: number | null = null
    const away = () => { awaySince ??= Date.now() }
    const back = () => {
      const since = awaySince
      awaySince = null
      if (since === null || Date.now() - since < AWAY_MS) return
      lastTouch.current = Date.now()
      setNeglected(false)
      setScene('comeback')
      void walkTo(room() / 2, 90).then(() => {
        setScene(null)
        setTrick('hop')
        speak('Neredeydin? 🥺')
        float(); window.setTimeout(() => float(), 200)
        reward((s) => s, 3)
      })
    }
    const onVisibility = () => (document.visibilityState === 'hidden' ? away() : back())
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', away)
    window.addEventListener('focus', back)
    return () => { document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('blur', away); window.removeEventListener('focus', back) }
  }, [])

  // Uzun süren bir Claude çalışması (onay beklemeden) bitince dans eder.
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

  // Klavye temposu: yalnız tuşa basma sıklığı sayılır, içerik okunmaz.
  useEffect(() => {
    const presses: number[] = []
    const onKey = () => { presses.push(Date.now()) }
    window.addEventListener('keydown', onKey, true)
    const timer = window.setInterval(() => {
      const cutoff = Date.now() - 2000
      while (presses.length && presses[0]! < cutoff) presses.shift()
      setTyping(presses.length >= 10)
    }, 500)
    return () => { window.removeEventListener('keydown', onKey, true); window.clearInterval(timer) }
  }, [])

  // --- kendi hayatı ----------------------------------------------------------

  // Uyanıkken çubukta rastgele bir yere yürür.
  useEffect(() => {
    if (mood === 'sleeping' || mood === 'attention' || busy || reducedMotion()) return
    let timer = 0
    const plan = () => {
      timer = window.setTimeout(() => {
        const target = Math.random() * room()
        if (Math.abs(target - pos.current) < 12) return plan()
        void walkTo(target, walkSpeed(24), 'wander').then((done) => { if (done) plan() })
      }, (happiness < 30 ? 5000 : 2500) + Math.random() * 6000)
    }
    plan()
    return () => { window.clearTimeout(timer); stopWalking('wander') }
  }, [mood, busy, part, happiness < 30, typing])

  // 8-20 sn'de bir kendi başına bir şey yapar: numara, uğraş, saklanma ya da laf.
  useEffect(() => {
    if (mood === 'sleeping' || scene !== null) return
    let timer = 0
    let last: Trick | null = null
    const schedule = () => {
      timer = window.setTimeout(() => {
        const roll = Math.random()
        if (mood === 'idle' && roll < 0.08 && !reducedMotion()) { void hideAndSeek(); return }
        const pool = [...PLAY, ...(mood === 'idle' ? HOBBIES : []), ...(part === 'noon' ? ['coffee' as const, 'coffee' as const] : []), ...(part === 'morning' || part === 'night' ? ['yawn' as const] : [])]
        const choices = pool.filter((t) => t !== last && !(mood === 'attention' && t === 'wave'))
        last = pick(choices) ?? 'hop'
        setTrick(last)
        if (last === 'butterfly') speak('Kelebek! 🦋')
        else if (Math.random() < 0.35) {
          const moodLine = happiness < 30 ? 'Biraz ilgi? 🥺' : hungry ? 'Acıktım… 🍪' : null
          speak(moodLine ?? pick([...PHRASES[mood], ...(PART_PHRASES[part] ?? [])]))
        }
        schedule()
      }, (happiness < 30 ? 14000 : 8000) + Math.random() * 12000)
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [mood, scene, part, happiness < 30, hungry])

  // --- oyunlar ----------------------------------------------------------------

  /** Saklambaç: bir kenara gidip çubuğun altına saklanır, yalnız gözleri görünür. */
  const hideAndSeek = async () => {
    setScene('hide')
    const edge = pos.current > room() / 2 ? room() : 0
    const arrived = await walkTo(edge, walkSpeed(40))
    if (!arrived) { setScene(null); return }
    speak('Ara beni! 🙈')
    window.setTimeout(() => {
      if (sceneRef.current !== 'hide') return
      setScene(null)
      speak('Beni bulamadın 😜')
      setTrick('hop')
    }, 60_000)
  }
  const found = () => {
    setScene(null)
    setTrick('hop')
    speak('Buldun! 🎉')
    float()
    reward((s) => s, 5)
  }

  /** Topu at: robot koşup alır, başladığı yere getirir. */
  const fetchBall = async (target?: number) => {
    if (sceneRef.current !== null) return
    const home = pos.current
    const x = target ?? (home > room() / 2 ? Math.random() * room() * 0.3 : room() * (0.7 + Math.random() * 0.3))
    setScene('fetch')
    setBall({ x: Math.min(Math.max(0, x), room()) + BOT_WIDTH / 2 - 6, carried: false })
    speak(pick(['Top! 🎾', 'Getiriyorum!']))
    await new Promise((r) => window.setTimeout(r, 450))
    if (!(await walkTo(x, 95))) { setBall(null); setScene(null); return }
    setBall((b) => (b ? { ...b, carried: true } : b))
    await walkTo(home, 70)
    setBall(null)
    setScene(null)
    setTrick('hop')
    speak(pick(['Yine! 🎾', 'Getirdim!', 'Bir daha at!']))
    float()
    reward((s) => ({ ...s, fetches: s.fetches + 1 }), 8)
  }

  const feed = () => {
    if (snack) return
    touch()
    setTrick(null)
    setSnack(true)
    window.setTimeout(() => {
      setSnack(false)
      float(); window.setTimeout(() => float(), 200)
      speak('Nom nom! 🍪')
      reward((s) => ({ ...s, cookies: s.cookies + 1, lastFed: Date.now() }), 15)
    }, 1500)
  }

  // --- işaretçi: sevme, sürükleme, gıdıklama ------------------------------------

  const endPress = (event: { clientX: number; clientY: number } | null) => {
    const current = press.current
    press.current = null
    if (!current) return
    window.clearTimeout(current.timer)
    if (current.dragging) {
      suppressClick.current = true
      drop(event)
      return
    }
    if (current.petted) {
      suppressClick.current = true
      setPetting(false)
      if (event) { setTrick('hop'); float(); speak(pick(PET_PHRASES)); reward((s) => ({ ...s, pets: s.pets + 1 }), 6) }
    }
  }

  const startDrag = () => {
    const el = bot.current
    if (!el || !press.current) return
    press.current.dragging = true
    window.clearTimeout(press.current.timer)
    stopWalking()
    setScene('drag')
    setTrick(null)
    const box = el.getBoundingClientRect()
    el.style.transition = 'none'
    el.style.position = 'fixed'
    el.style.left = `${box.left}px`
    el.style.top = `${box.top}px`
    el.style.transform = 'none'
    speak(pick(['Uçuyorum! 🚀', 'Yükseklik korkum var!', 'Wiii!']))
  }

  const moveDrag = (clientX: number, clientY: number) => {
    const el = bot.current
    const current = press.current
    if (!el || !current) return
    el.style.left = `${clientX - current.grabX}px`
    el.style.top = `${clientY - current.grabY}px`
  }

  /** Bırakılınca çubuğa düşer; yüksekten düşerse başı döner. */
  const drop = (event: { clientX: number; clientY: number } | null) => {
    const el = bot.current
    const area = track.current?.getBoundingClientRect()
    if (!el || !area) { setScene(null); return }
    const box = el.getBoundingClientRect()
    pos.current = Math.min(Math.max(0, box.left - area.left), room())
    const landingTop = area.top + BOT_TOP
    const height = Math.abs(box.top - landingTop)
    setScene('fall')
    el.style.transition = `left 220ms ease-out, top ${Math.min(700, 250 + height * 1.5)}ms cubic-bezier(0.55, 0, 1, 0.45)`
    el.style.left = `${area.left + pos.current}px`
    el.style.top = `${landingTop}px`
    window.setTimeout(() => {
      el.style.transition = ''
      el.style.position = ''
      el.style.left = ''
      el.style.top = ''
      place()
      setScene(null)
      if (height > DIZZY_FALL_PX) { setTrick('dizzy'); speak('Başım döndü 😵‍💫') }
      else { setTrick('wiggle'); speak(event ? pick(['Pat!', 'Oh be, yerdeyim', 'Tekrar!']) : undefined) }
    }, Math.min(720, 270 + height * 1.5))
  }

  /** Fareyi robotun üstünde hızla sağa sola gezdirmek gıdıklar. */
  const checkTickle = (movementX: number) => {
    const dir = Math.sign(movementX)
    if (dir === 0) return
    const state = tickle.current
    if (state.dir !== 0 && dir !== state.dir) state.flips.push(Date.now())
    state.dir = dir
    state.flips = state.flips.filter((t) => Date.now() - t < 1200)
    if (state.flips.length >= 5 && Date.now() - tickledAt.current > 3000 && scene === null && !busy) {
      tickledAt.current = Date.now()
      state.flips = []
      setTrick('giggle')
      speak(pick(TICKLE_PHRASES))
      reward((s) => s, 3)
      // Kıkırdayarak fareden biraz uzaklaşır.
      window.setTimeout(() => { void walkTo(pos.current + (dir > 0 ? 50 : -50), 90) }, 1300)
    }
  }

  // Sevilirken kalpler düzenli çıkar; okşadıkça (onPointerMove) daha sık.
  useEffect(() => {
    if (!petting) return
    const timer = window.setInterval(() => {
      if (press.current && Date.now() - press.current.lastHeart > 380) { press.current.lastHeart = Date.now(); float() }
    }, 120)
    return () => window.clearInterval(timer)
  }, [petting])

  // Gözler yakındaki fareyi izler.
  useEffect(() => {
    if (mood === 'sleeping') return
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
  }, [mood])

  // --- görünüm ----------------------------------------------------------------

  const waiting = claude.find((s) => s.attention)
  const working = claude.filter((s) => s.activity !== 'idle').length
  const hearts = '♥'.repeat(Math.max(1, Math.round(happiness / 20))) + '♡'.repeat(5 - Math.max(1, Math.round(happiness / 20)))
  const title = [
    `Claude ${LABEL[mood]} · ${hearts}${hungry ? ' · acıktı' : ''}`,
    ...(claude.length > 0 ? [`${claude.length} Claude oturumu${working > 0 ? ` · ${working} çalışıyor` : ''}${waiting ? ` · ${claude.filter((s) => s.attention).length} bekliyor` : ''}`] : []),
    waiting ? `Tıkla: ${waiting.name} oturumuna geç` : 'Tıkla: numara · basılı tut: sev · sürükle: taşı',
    'Çift tık: kurabiye · sağ tık: oyunlar ve aksesuarlar',
  ].join('\n')
  const accessory = stats.accessory && ACCESSORIES.find((a) => a.id === stats.accessory)?.unlocked(stats) ? stats.accessory : null

  const menuActions: MenuAction[] = [
    { label: 'Kurabiye ver 🍪', icon: 'plus', run: feed },
    { label: 'Top at 🎾', icon: 'play', disabled: scene !== null, run: () => { touch(); void fetchBall() } },
    { label: 'Saklambaç oyna 🙈', icon: 'search', disabled: scene !== null || reducedMotion(), run: () => { touch(); void hideAndSeek() } },
    ...ACCESSORIES.map((a, i) => ({
      label: `${accessory === a.id ? '✓ ' : ''}${a.label}`,
      icon: 'palette' as const,
      divider: i === 0,
      disabled: !a.unlocked(stats),
      description: a.unlocked(stats) ? (accessory === a.id ? 'Çıkarmak için tekrar seç' : 'Tak') : `Kilitli · ${a.hint}`,
      run: () => { updateStats((s) => ({ ...s, accessory: s.accessory === a.id ? null : a.id })); setTrick('spin') },
    })),
    { label: stats.birthday ? `Doğum günüm: ${stats.birthday.split('-').reverse().join('.')}` : 'Doğum günümü ayarla…', icon: 'edit', divider: true, run: () => setBirthdayOpen(true) },
  ]

  return (
    <div className="mascot-track" ref={track} onDoubleClick={(event) => {
      // Şeridin boş yerine çift tık o noktaya top atar.
      if (event.target !== event.currentTarget) return
      const area = event.currentTarget.getBoundingClientRect()
      touch()
      void fetchBall(event.clientX - area.left - BOT_WIDTH / 2)
    }}>
      {doodles.map((d) => <span key={d.id} className="m-doodle" style={{ left: d.x, background: d.color }} aria-hidden="true" />)}
      {ball && !ball.carried && <span className="m-ball" style={{ left: ball.x }} aria-hidden="true">🎾</span>}
      {trick === 'butterfly' && <span className="m-butterfly" style={{ left: pos.current }} aria-hidden="true">🦋</span>}
      <button
        ref={bot}
        type="button"
        className="claude-mascot"
        data-mood={mood}
        data-trick={petting || snack || scene === 'drag' ? undefined : (trick ?? undefined)}
        data-scene={scene ?? undefined}
        data-petting={petting || undefined}
        data-snack={snack || undefined}
        data-typing={typing && mood !== 'sleeping' && !busy ? true : undefined}
        data-pout={happiness < 30 || undefined}
        data-night={part === 'night' || undefined}
        data-walking={walking !== 0 ? (walking > 0 ? 'right' : 'left') : undefined}
        title={menu || scene === 'drag' ? undefined : title}
        aria-label={`Claude ${LABEL[mood]}`}
        onContextMenu={(event) => {
          event.preventDefault()
          touch()
          setMenu({ x: event.clientX, y: event.clientY, origin: event.currentTarget })
        }}
        onPointerEnter={() => {
          touch()
          if (sceneRef.current === 'hide') found()
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || scene === 'fall') return
          touch()
          suppressClick.current = false
          event.currentTarget.setPointerCapture(event.pointerId)
          const box = event.currentTarget.getBoundingClientRect()
          press.current = {
            petted: false,
            dragging: false,
            lastHeart: 0,
            startX: event.clientX,
            startY: event.clientY,
            grabX: event.clientX - box.left,
            grabY: event.clientY - box.top,
            timer: window.setTimeout(() => {
              if (!press.current || press.current.dragging) return
              press.current.petted = true
              stopWalking()
              setPetting(true)
              setTrick(null)
            }, PET_AFTER_MS),
          }
        }}
        onPointerMove={(event) => {
          const current = press.current
          if (!current) { checkTickle(event.movementX); return }
          if (current.dragging) { moveDrag(event.clientX, event.clientY); return }
          if (!current.petted && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > DRAG_AFTER_PX) {
            startDrag()
            moveDrag(event.clientX, event.clientY)
            return
          }
          // Okşarken kalpler daha sık çıkar.
          if (current.petted && Date.now() - current.lastHeart > 180) { current.lastHeart = Date.now(); float() }
        }}
        onPointerUp={(event) => endPress(event)}
        onPointerCancel={() => endPress(null)}
        onLostPointerCapture={(event) => endPress(event)}
        onClick={() => {
          if (suppressClick.current) { suppressClick.current = false; return }
          touch()
          if (waiting) onOpen(waiting.id)
          if (scene === null) setTrick(waiting ? 'hop' : pick([...PLAY, 'giggle']) ?? 'hop')
        }}
        onDoubleClick={(event) => { event.stopPropagation(); feed() }}
      >
        <svg viewBox="-1 -4 15 12" aria-hidden="true" shapeRendering="crispEdges">
          <g className="m-all">
            <g className="m-legs-a"><rect x="3" y="5" width="1" height="2" /><rect x="7" y="5" width="1" height="2" /></g>
            <g className="m-legs-b"><rect x="5" y="5" width="1" height="2" /><rect x="9" y="5" width="1" height="2" /></g>
            <g className="m-body">
              <rect x="2" y="0" width="9" height="5" />
              <rect className="m-arm-l" x="0" y="2" width="2" height="2" />
              <rect className="m-arm-r" x="11" y="2" width="2" height="2" />
              <g className="m-gaze"><g className="m-eyes"><rect x="4" y="1" width="1" height="2" /><rect x="8" y="1" width="1" height="2" /></g></g>
              <g className="m-blush"><rect x="2.6" y="3" width="1.2" height="0.8" /><rect x="9.2" y="3" width="1.2" height="0.8" /></g>
              <Accessory id={accessory} special={special} galatasaray={galatasaray} />
            </g>
          </g>
        </svg>
        {snack && <span className="m-held m-cookie" aria-hidden="true">🍪</span>}
        {ball?.carried && <span className="m-held" aria-hidden="true">🎾</span>}
        {trick === 'read' && <span className="m-held m-book" aria-hidden="true">📖</span>}
        {trick === 'coffee' && <span className="m-held" aria-hidden="true">☕</span>}
        {special === 'republic' && !busy && <span className="m-held m-flag" aria-hidden="true">🇹🇷</span>}
        {mood === 'attention' && <span className="m-bubble" aria-hidden="true">!</span>}
        {mood === 'sleeping' && <span className="m-zzz" aria-hidden="true">z</span>}
        {floaters.map((f) => <span key={f.id} className={f.kind === 'orbit' ? 'm-orbit' : 'm-heart'} style={f.kind === 'orbit' ? undefined : { left: f.x, fontSize: f.size }} aria-hidden="true">{f.char}</span>)}
        {say && <span className="m-say" data-side={say.side} role="status">{say.text}</span>}
      </button>
      {menu && <ActionMenu label="Claude" position={menu} onClose={closeMenu} actions={menuActions} header={<>
        <strong>Claude {hearts}</strong>
        <span>{daysTogether(stats, now)}. günümüz · {LABEL[mood]}{hungry ? ' · acıktı' : ''}</span>
        <span>{stats.pets} sevgi · {stats.cookies} kurabiye · {stats.fetches} top</span>
      </>} />}
      {birthdayOpen && <BirthdayDialog value={stats.birthday} onClose={() => setBirthdayOpen(false)} onSave={(value) => {
        updateStats((s) => ({ ...s, birthday: value, greetedOn: null }))
        setBirthdayOpen(false)
        speak(value ? 'Not aldım! 🎂' : 'Tamam, sildim')
      }} />}
    </div>
  )
}

/** Kullanıcının doğum günü (gün ve ay); yıl sorulmaz ve saklanmaz. */
function BirthdayDialog({ value, onClose, onSave }: { value: string | null; onClose: () => void; onSave: (value: string | null) => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [day, setDay] = useState(value ? Number(value.slice(3)) : 1)
  const [month, setMonth] = useState(value ? Number(value.slice(0, 2)) : 1)
  useEffect(() => { ref.current?.showModal() }, [])
  const months = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık']
  const days = new Date(2024, month, 0).getDate()
  return (
    <dialog ref={ref} className="session-modal" aria-labelledby="birthday-title" onCancel={(e) => { e.preventDefault(); onClose() }}>
      <form className="dialog" onSubmit={(e) => { e.preventDefault(); onSave(`${String(month).padStart(2, '0')}-${String(Math.min(day, days)).padStart(2, '0')}`) }}>
        <header className="dialog-head"><h2 id="birthday-title">Doğum günün</h2><p className="dialog-sub">Claude o gün seni kutlar. Yalnız gün ve ay bu profilde saklanır.</p></header>
        <div className="birthday-fields">
          <label>Gün<select value={Math.min(day, days)} onChange={(e) => setDay(Number(e.target.value))}>{Array.from({ length: days }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select></label>
          <label>Ay<select value={month} onChange={(e) => setMonth(Number(e.target.value))}>{months.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}</select></label>
        </div>
        <div className="dialog-actions">
          {value && <button type="button" className="ghost-button" onClick={() => onSave(null)}>Sil</button>}
          <button type="button" className="ghost-button" onClick={onClose}>Vazgeç</button>
          <button type="submit" className="primary">Kaydet</button>
        </div>
      </form>
    </dialog>
  )
}
