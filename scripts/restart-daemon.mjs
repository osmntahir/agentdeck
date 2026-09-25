import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Derleyip yerel daemon'u yeni derlemeyle yeniden başlatır.
 *
 *   node scripts/restart-daemon.mjs              her zaman derle ve yeniden başlat
 *   node scripts/restart-daemon.mjs --if-changed yalnız kaynak derlemeden yeniyse
 *                                                veya daemon eski derlemeyle çalışıyorsa
 *
 * Yeniden başlatma canlı terminalleri kapatır (daemon onları durdurur);
 * Claude konuşmaları açılışta kendiliğinden sürdürülür. Derleme başarısızsa
 * çalışan daemon'a dokunulmaz.
 *
 * Daemon, bu betiği çalıştıran ajanın ortamını devralmasın diye CLAUDE*
 * değişkenleri temizlenerek başlatılır; yoksa terminallerde açılan claude
 * kendini iç içe oturum sanar.
 */
const root = path.resolve(import.meta.dirname, '..')
const server = path.join(root, 'dist', 'server', 'index.js')
const stamp = path.join(root, 'dist', '.build-stamp.json')
const port = Number(process.env.AGENTDECK_PORT || process.env.PORT || 4711)
const dataDir = process.env.AGENTDECK_DATA_DIR || path.join(os.homedir(), '.agentdeck')
const log = path.join(dataDir, 'daemon.log')
const ifChanged = process.argv.includes('--if-changed')

const say = (message) => console.log(`[daemon] ${message}`)

/** Derlemeye giren dosyalar: izlenen ve izlenmeyen (yok sayılmayan) kaynaklar. */
function sourceMtime() {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src', 'index.html', 'vite.config.ts', 'tsconfig.json', 'tsconfig.server.json', 'package.json', 'package-lock.json'], { cwd: root, encoding: 'utf8' })
  if (listed.status !== 0) return Date.now()
  let newest = 0
  for (const file of listed.stdout.split('\n').filter(Boolean)) {
    try { newest = Math.max(newest, fs.statSync(path.join(root, file)).mtimeMs) } catch { /* silinmiş dosya */ }
  }
  return newest
}

function readStamp() {
  try { return JSON.parse(fs.readFileSync(stamp, 'utf8')) } catch { return null }
}

/** Bu depodaki dist/server/index.js'i çalıştıran süreçler. */
function daemonPids() {
  const pids = []
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const args = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean)
      if (!/(^|\/)node$/.test(args[0] ?? '')) continue
      const script = args[1] && path.resolve(fs.readlinkSync(`/proc/${entry}/cwd`), args[1])
      if (script === server) pids.push(Number(entry))
    } catch { /* süreç kapanmış veya okunamıyor */ }
  }
  return pids
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function healthy() {
  try { return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })).ok } catch { return false }
}

const newestSource = sourceMtime()
let built = readStamp()
const running = daemonPids()

if (!built || !ifChanged || newestSource > built.sourceMtime) {
  say('derleniyor…')
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8' })
  if (build.status !== 0) {
    console.error(`${build.stdout}\n${build.stderr}`.trim().split('\n').slice(-25).join('\n'))
    say('derleme başarısız; çalışan daemon olduğu gibi bırakıldı')
    process.exit(1)
  }
  built = { builtAt: Date.now(), sourceMtime: newestSource }
  fs.writeFileSync(stamp, JSON.stringify(built))
}

// Daemon bu derlemeden sonra başladıysa güncel sayılır.
const bootTime = (pid) => {
  const ticks = Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19])
  const uptime = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0])
  return Date.now() - (uptime - ticks / 100) * 1000
}
if (ifChanged && running.length === 1 && bootTime(running[0]) > built.builtAt && (await healthy())) {
  say('güncel; değişiklik yok')
  process.exit(0)
}

for (const pid of running) {
  say(`durduruluyor (pid ${pid}); canlı terminaller kapanır`)
  process.kill(pid, 'SIGTERM')
}
for (let waited = 0; running.some(alive); waited += 250) {
  if (waited > 30_000) {
    say(`daemon 30 sn içinde kapanmadı (pid ${running.filter(alive).join(', ')}); yeni daemon başlatılmadı`)
    process.exit(1)
  }
  await sleep(250)
}

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CLAUDE')))
env.AGENTDECK_NODE = process.execPath
env.PATH = [path.dirname(process.execPath), path.join(os.homedir(), '.local', 'bin'), env.PATH ?? ''].join(path.delimiter)
fs.mkdirSync(dataDir, { recursive: true })
const out = fs.openSync(log, 'a')
const child = spawn(process.execPath, [server], { cwd: root, env, detached: true, stdio: ['ignore', out, out] })
child.unref()

for (let waited = 0; !(await healthy()); waited += 250) {
  if (waited > 20_000 || !alive(child.pid)) {
    say(`yeni daemon ayağa kalkmadı; ayrıntı: ${log}`)
    process.exit(1)
  }
  await sleep(250)
}
say(`hazır (pid ${child.pid}, port ${port}); pencereyi Ctrl+Shift+R ile yenileyin`)
