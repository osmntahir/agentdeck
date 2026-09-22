import { ColorDialog } from './ColorDialog'
import { THEMES, usePreferences } from '../preferences'
import { ActionMenu, type MenuPosition } from './ActionMenu'
import { Icon } from './Icon'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { SessionView } from '../../shared/types'
import { inputChunks, TerminalStream, type StreamStatus } from '../../shared/terminalStream'
import { TOKEN } from '../api'

/** Paketle gelen yazı tipi; main.tsx ilk çizimden önce yükler, xterm hücre ölçüsünü doğru alır. */
export const TERMINAL_FONT = '"JetBrains Mono Variable", ui-monospace, "Fira Code", Menlo, monospace'

/** Menü odağı çalsa da son odaklanan pane F6 alır. */
let lastPtyF6: (() => void) | null = null

interface Props {
  session: SessionView
  onLayout?: () => void
  daemonId: string
  stateHealthy: boolean
  /** Tek görünümde terminal odağı alır; grid'de paneller birbirinin odağını çalmaz. */
  autoFocus?: boolean
  /** Grid paneli: durum şeridi terminalin üstünde yüzen kompakt çubuk olur. */
  compact?: boolean
  /** Açık kullanıcı isteği; hazır replay üzerinde bir kez tüketilir. */
  focusRequest?: { sequence: number; origin: HTMLElement }
  onFocusHandled?: () => void
  /** Salt okunur incelenecek önceki Run; verilmezse oturumun güncel Run'ı açılır. */
  runId?: string | null
}

export function TerminalPane({
  session,
  onLayout,
  daemonId,
  stateHealthy,
  autoFocus = true,
  compact = false,
  focusRequest,
  onFocusHandled,
  runId: inspectRunId = null,
}: Props) {
  const preferences = usePreferences()
  const [colorOpen, setColorOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
  const [clipboardError, setClipboardError] = useState<string | null>(null)
  const closeMenu = useCallback(() => setMenuPosition(null), [])
  const runId = inspectRunId ?? session.runId
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const actions = useRef({ history: () => {}, control: () => {}, f6: () => {} })
  const healthy = useRef(stateHealthy)
  healthy.current = stateHealthy
  const wantFocus = useRef(autoFocus)
  wantFocus.current = autoFocus
  const focusedReady = useRef(false)
  const [retry, setRetry] = useState(0)
  const [status, setStatus] = useState<StreamStatus | null>(null)

  useEffect(() => {
    if (focusRequest !== undefined && status?.ready) {
      if (document.activeElement === focusRequest.origin) termRef.current?.focus()
      onFocusHandled?.()
    }
  }, [focusRequest, status?.ready, onFocusHandled])

  useEffect(() => {
    focusedReady.current = false
  }, [session.id, runId, daemonId])

  useEffect(() => {
    if (!runId) { setStatus(null); return }
    const term = new Terminal({
      cols: 120, rows: 32, scrollback: 1000,
      fontSize: 13,
      lineHeight: 1.15,
      fontFamily: TERMINAL_FONT,
      cursorBlink: !compact, cursorInactiveStyle: 'block', disableStdin: true,
      theme: {
        ...THEMES[preferences.theme].terminal,
        // Uygulamanın kaydırma çubuklarıyla aynı palet.
        scrollbarSliderBackground: 'rgba(160, 163, 174, 0.18)',
        scrollbarSliderHoverBackground: 'rgba(160, 163, 174, 0.36)',
        scrollbarSliderActiveBackground: 'rgba(160, 175, 255, 0.5)',
      },
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    let disposed = false
    let socket: WebSocket | null = null
    let stream: TerminalStream | null = null
    let reconnect: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    let requestedSize = ''

    const send = (message: object) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    }
    const canInput = () => healthy.current && stream?.status.ready && stream.status.live && stream.status.owned
    const resize = () => {
      if (disposed || !stream?.status.ready) return
      if (!stream.status.live) { fit.fit(); return }
      if (!canInput()) return
      const size = fit.proposeDimensions()
      if (!size) return
      const cols = Math.max(2, Math.min(300, size.cols))
      const rows = Math.max(1, Math.min(120, size.rows))
      const key = `${cols}:${rows}`
      if (cols === term.cols && rows === term.rows) { requestedSize = ''; return }
      if (key === requestedSize) return
      requestedSize = key
      send({ type: 'resize', cols, rows, generation: stream!.status.generation })
    }

    const connect = () => {
      if (disposed) return
      requestedSize = ''
      let claimed = 0
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const query = new URLSearchParams({ session: session.id, run: runId, token: TOKEN, scope: 'scrollback' })
      const ws = new WebSocket(`${proto}://${location.host}/ws?${query}`)
      socket = ws
      let protocolFailed = false
      const consumer = new TerminalStream(term, { daemonId, sessionId: session.id, runId }, (next) => {
        if (disposed || socket !== ws) return
        setStatus(next)
        term.options.disableStdin = !healthy.current || !next.ready || !next.live || !next.owned
        if (next.ready) { attempts = 0; resize() }
        // Açık kullanıcı seçiminden sonra replay hazırken odaklanır; reconnect çalmaz.
        if (next.ready && wantFocus.current && !focusedReady.current) {
          focusedReady.current = true
          term.focus()
        }
        // Sahipsiz kontrol kimseden alınmaz: grid ile tek görünüm arasında geçişte
        // eski bağlantı yeni bağlantıdan sonra kapansa da terminal girdiye açılır.
        if (next.ready && next.live && !next.owned && next.vacant && claimed !== next.generation) {
          claimed = next.generation
          send({ type: 'take-control' })
        }
      }, () => { protocolFailed = true; ws.close() })
      stream = consumer
      setStatus(consumer.status)
      ws.onmessage = (event) => { if (typeof event.data === 'string') void consumer.receive(event.data).then(resize) }
      ws.onclose = (event) => {
        if (disposed || socket !== ws) return
        // İnceleme bağlantısı replay kuyruğa alındıktan sonra kapanır; yazımlar kendi callback'leriyle biter.
        if (event.code === 1000 || protocolFailed) return
        consumer.dispose()
        term.options.disableStdin = true
        if (event.code === 1008) { setStatus({ ...consumer.status, message: 'Erişim reddedildi; bağlantı bilgilerini kontrol edin' }); return }
        const delay = [2000, 4000, 8000, 10000][Math.min(attempts++, 3)]
        setStatus({ ...consumer.status, message: `Bağlantı koptu · ${delay / 1000} sn sonra yeniden denenecek` })
        reconnect = setTimeout(connect, delay)
      }
    }
    // Initialize xterm's cursor on its empty normal buffer without taking focus.
    // Do this before replay so application cursor visibility/buffer modes win.
    // This local display sequence is never sent to the PTY.
    if (compact) term.write('\x1b[?1047l', connect)
    else connect()
    const input = term.onData((data) => {
      if (!canInput()) return
      for (const part of inputChunks(data)) {
        if (!canInput() || socket?.readyState !== WebSocket.OPEN) break
        if (socket.bufferedAmount > 1024 * 1024) {
          stream?.suspend('Girdi gönderimi yetişmiyor; kalan yapıştırma gönderilmedi')
          break
        }
        send({ type: 'input', data: part, generation: stream!.status.generation })
      }
    })
    actions.current = {
      history: () => {
        if (!stream?.status.ready || !stream.status.live || stream.status.historyLoaded) return
        stream.suspend('Geçmiş yükleniyor…')
        send({ type: 'request-scrollback' })
      },
      control: () => send({ type: 'take-control' }),
      f6: () => {
        if (!canInput()) return
        send({ type: 'input', data: '\x1b[17~', generation: stream!.status.generation })
      },
    }
    term.attachCustomKeyEventHandler((event) => {
      if (event.key !== 'F6') return true
      if (event.type === 'keydown') {
        ;(document.querySelector<HTMLElement>('.topbar-back') ?? document.querySelector<HTMLElement>('.mobile-navigation button') ?? document.querySelector<HTMLElement>('.home-nav'))?.focus()
      }
      return false
    })
    const sendMine = () => actions.current.f6()
    const onTermFocus = () => {
      lastPtyF6 = sendMine
    }
    term.textarea?.addEventListener('focus', onTermFocus)
    let resizeFrame = 0
    const scheduleResize = () => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(resize) }
    document.fonts.ready.then(() => { if (!disposed) scheduleResize() })
    window.addEventListener('resize', scheduleResize)
    const observer = new ResizeObserver(scheduleResize)
    observer.observe(hostRef.current!)
    return () => {
      disposed = true
      if (reconnect) clearTimeout(reconnect)
      observer.disconnect()
      cancelAnimationFrame(resizeFrame)
      window.removeEventListener('resize', scheduleResize)
      term.textarea?.removeEventListener('focus', onTermFocus)
      if (lastPtyF6 === sendMine) lastPtyF6 = null
      input.dispose()
      stream?.dispose()
      socket?.close()
      termRef.current = null
      term.dispose()
    }
  }, [session.id, runId, daemonId, retry])

  useEffect(() => {
    if (termRef.current) termRef.current.options.disableStdin = !stateHealthy || !status?.ready || !status.live || !status.owned
  }, [stateHealthy, status])

  useEffect(() => {
    const sendF6 = () => {
      lastPtyF6?.()
    }
    const onWindow = () => sendF6()
    window.addEventListener('agentdeck-pty-f6', onWindow)
    const unsub = window.agentdeckDesktop?.onPtyF6?.(sendF6)
    return () => {
      window.removeEventListener('agentdeck-pty-f6', onWindow)
      unsub?.()
    }
  }, [])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = { ...termRef.current.options.theme, ...THEMES[preferences.theme].terminal }
  }, [preferences.theme])

  const needsControl = Boolean(status?.ready && status.live && !status.owned)
  // Salt okunur kalma veya bağlantı mesajı kompakt şeritte de sürekli görünür.
  const attention = !stateHealthy || Boolean(status?.message) || needsControl
  return (
    <div className="terminal-pane" onContextMenu={event => {
      event.preventDefault(); event.stopPropagation()
      setMenuPosition({ x: event.clientX, y: event.clientY, origin: document.activeElement as HTMLElement })
    }}>
      {menuPosition && <ActionMenu label="Terminal işlemleri" position={menuPosition} onClose={closeMenu} actions={[
        ...(onLayout ? [{ label: 'Böl / panel yerleşimi…', icon: 'grid' as const, run: onLayout }] : []),
        { label: 'Terminal rengi…', icon: 'palette', run: () => setColorOpen(true) },
        { label: 'Seçimi kopyala', icon: 'copy', disabled: !termRef.current?.hasSelection(), run: () => { navigator.clipboard.writeText(termRef.current?.getSelection() ?? '').catch(() => setClipboardError('Pano erişimi reddedildi. Ctrl+Shift+C ile kopyalayabilirsiniz.')) } },
        { label: 'Yapıştır', icon: 'terminal', disabled: !stateHealthy || !status?.ready || !status.live || !status.owned, run: () => { navigator.clipboard.readText().then(text => termRef.current?.paste(text)).catch(() => setClipboardError('Pano erişimi reddedildi. Ctrl+Shift+V ile yapıştırabilirsiniz.')) } },
        { label: 'Tümünü seç', icon: 'copy', run: () => termRef.current?.selectAll() },
        { label: 'En alta git', icon: 'chevron', run: () => termRef.current?.scrollToBottom() },
        { label: 'Terminal geçmişini yükle', icon: 'archive', disabled: !status?.ready || !status.live || status.historyLoaded, run: () => actions.current.history() },
        { label: 'Terminale F6 gönder', icon: 'terminal', disabled: !stateHealthy || !status?.owned, run: () => actions.current.f6() },
        { label: 'Yeniden bağlan', icon: 'refresh', run: () => setRetry(value => value + 1) },
      ]} />}
      {colorOpen && <ColorDialog id={session.id} projectId={session.projectId} name={session.name} onClose={() => setColorOpen(false)} />}
      {clipboardError && <div className="error" role="alert">{clipboardError}<button onClick={() => setClipboardError(null)}>×</button></div>}
      <div className={`terminal-status floating${attention ? ' attention' : ''}`} role="status">
        <span title="F6 uygulama çubuğuna geçer; menü gerçek F6'yı terminale gönderir.">
          {!stateHealthy
            ? 'Durum güncel değil · girdi kapalı'
            : `${status?.message || (status?.owned ? 'Kontrol sizde' : 'Salt okunur izleyici')}${status?.pressure ? ' · Çıktı işleniyor' : ''}`}
        </span>
        {needsControl && <button onClick={() => actions.current.control()}>Kontrolü al</button>}
        {status?.ready && status.live && !status.historyLoaded && (
          <button title="Terminal geçmişini yükle" onClick={() => actions.current.history()}>
            Geçmiş
          </button>
        )}
        <button title="Yeniden bağlan" aria-label="Yeniden bağlan" onClick={() => setRetry((value) => value + 1)}>
          <Icon name="refresh" />
        </button>
      </div>
      {!runId && <p className="terminal-empty">Bu oturumda henüz Run çalışmadı.</p>}
      <div ref={hostRef} className="term-host" />
    </div>
  )
}
