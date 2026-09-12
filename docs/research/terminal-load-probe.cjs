// AgentDeck headless terminal kaynak maliyeti ölçümü.
// Koşum: depo kökünden `node docs/research/terminal-load-probe.cjs` (bağımlılıklar depoda).
// sonra: `node terminal-load-probe.cjs [terminalSayisi] [saniye] [hedefMBs]`
// hedefMBs=0 → etkileşimli profil (ajan TUI benzeri düşük hacimli yeniden çizim).
const {Terminal} = require('@xterm/headless')
const {SerializeAddon} = require('@xterm/addon-serialize')
const {performance, monitorEventLoopDelay} = require('node:perf_hooks')

const N = Number(process.argv[2] || 32)
const SECS = Number(process.argv[3] || 20)
const TARGET = Number(process.argv[4] ?? 0)
const SCROLLBACK = Number(process.env.SCROLLBACK || 1000)
const HIGH_WATER = 16                       // Run başına bekleyen write üst sınırı

const h = monitorEventLoopDelay({resolution: 5}); h.enable()
const mb = b => Math.round(b / 1048576)
const terms = []
for (let i = 0; i < N; i++) {
  const t = new Terminal({cols: 120, rows: 32, scrollback: SCROLLBACK, allowProposedApi: true})
  const s = new SerializeAddon(); t.loadAddon(s)
  t.write('\x1b[?1049h\x1b[2J\x1b[HHEADER ' + i + '\r\n')
  terms.push({t, s, i, inflight: 0})
}

// Etkileşimli profil: ajan TUI'si gibi küçük bölgeleri yeniden çizer.
let seq = 0
const SPIN = '|/-\\'
const interactiveFrame = i => {
  seq++
  return `\x1b[${3 + (seq % 15)};1H\x1b[2K\x1b[38;5;${(seq % 200) + 16}m${SPIN[seq % 4]} worker ${i} step ${seq}\x1b[39m`
       + `\x1b[2;1H\x1b[2Kâçü tokens=${seq * 7} elapsed=${(seq / 10).toFixed(1)}s`
       + (seq % 40 === 0 ? '\x1b[H\x1b[2J\x1b[HHEADER ' + i + '\r\n' : '')
}
// Yoğun profil: derleme/log akışı, sürekli scroll.
const FLOOD = ('\x1b[32m[info]\x1b[39m compiling module ' + 'x'.repeat(90) + '\r\n').repeat(40)

let bytes = 0, acked = 0, backpressure = 0, latMax = 0
const lat = []
const TICK_HZ = TARGET > 0 ? 20 : 64
const perTick = TARGET > 0
  ? Math.max(1, Math.round(TARGET * 1048576 / (N * Buffer.byteLength(FLOOD)) / TICK_HZ))
  : 1
const start = performance.now()
const timer = setInterval(() => {
  for (const T of terms) {
    for (let k = 0; k < perTick; k++) {
      if (T.inflight > HIGH_WATER) { backpressure++; break }   // üretici baskısı: PTY pause noktası
      const data = TARGET > 0 ? FLOOD : interactiveFrame(T.i)
      T.inflight++; bytes += Buffer.byteLength(data)
      const t0 = performance.now()
      T.t.write(data, () => {
        T.inflight--; acked++
        const d = performance.now() - t0
        if (d > latMax) latMax = d
        lat.push(d)
      })
    }
  }
}, 1000 / TICK_HZ)

setTimeout(() => {
  clearInterval(timer)
  setTimeout(() => {
    const dur = (performance.now() - start) / 1000
    const s0 = performance.now()
    let screenBytes = 0, fullBytes = 0
    for (const T of terms) screenBytes += Buffer.byteLength(T.s.serialize({scrollback: 0}))
    const msScreen = performance.now() - s0
    const s1 = performance.now()
    for (const T of terms) fullBytes += Buffer.byteLength(T.s.serialize({scrollback: SCROLLBACK}))
    const msFull = performance.now() - s1
    lat.sort((a, b) => a - b)
    const p = q => lat.length ? Math.round(lat[Math.floor(lat.length * q)] * 100) / 100 : 0
    const m = process.memoryUsage()
    console.log(JSON.stringify({
      profil: TARGET > 0 ? `yoğun ~${TARGET} MiB/s hedef` : 'etkileşimli',
      terminal: N, saniye: Math.round(dur), scrollbackSatır: SCROLLBACK,
      işlenenMB: Math.round(bytes / 1048576 * 10) / 10,
      gerçekAkışMBs: Math.round(bytes / 1048576 / dur * 10) / 10,
      ackEdilen: acked, backpressureOlayı: backpressure,
      writeLat_p50: p(.5), writeLat_p95: p(.95), writeLat_p99: p(.99), writeLat_max: Math.round(latMax * 100) / 100,
      eventLoop_p95_ms: Math.round(h.percentile(95) / 1e6 * 100) / 100,
      eventLoop_max_ms: Math.round(h.max / 1e6 * 100) / 100,
      rss_MB: mb(m.rss), heapUsed_MB: mb(m.heapUsed),
      snapshotYalnızEkran_her_KB: Math.round(screenBytes / N / 1024 * 10) / 10,
      snapshotYalnızEkran_hepsi_ms: Math.round(msScreen),
      snapshotTam_her_KB: Math.round(fullBytes / N / 1024),
      snapshotTam_hepsi_ms: Math.round(msFull),
    }, null, 1))
    for (const T of terms) T.t.dispose()
    process.exit(0)
  }, 500)
}, SECS * 1000)
