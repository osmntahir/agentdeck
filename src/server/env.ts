import fs from 'node:fs'

/**
 * Run ortamı sözleşmesi. Daemon'ın açıldığı kabuğun tüm env'i PTY'ye
 * kopyalanmaz: yalnız temel izin listesi taşınır. Liste dışı her şey — parent
 * ajan işaretçileri, NODE_OPTIONS, ELECTRON_RUN_AS_NODE, BASH_ENV/ENV ve
 * BASH_FUNC_* dahil — düşer. Kullanıcının environment.json değerleri bunun
 * üzerine eklenir (spec §3).
 */
const ALLOWED = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'TERMINFO',
  'TERMINFO_DIRS',
  'COLORTERM',
  // Kullanıcının CLI evini korumak için:
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'GEMINI_CLI_HOME',
]

export interface RunIdentity {
  sessionId: string
  runId: string
  /** Claude konuşma kancasının olay dizini (ADR 0018); yoksa kanca hiçbir şey yazmaz. */
  hookDir?: string
  /** Oturuma ayrılan port (ADR 0023); PORT olarak verilir, kullanıcı ortamı ezebilir. */
  port?: number
}

const USER_ENVIRONMENT_MAX_BYTES = 64 * 1024

/**
 * Bir ajan terminalinin kendi çocuklarına bıraktığı gözlenmiş işaretçiler.
 * CLAUDE_CODE_* öneki topluca yasaklanmaz: CLAUDE_CODE_USE_BEDROCK gibi
 * meşru API yapılandırması da bu önekle gelir.
 */
const PARENT_AGENT_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'GEMINI_CLI_SESSION_ID',
]

export type UserEnvironment = { ok: true; values: Record<string, string> } | { ok: false; message: string }

/**
 * Kullanıcının bilinçli Run yapılandırması; her Run öncesi yeniden okunur.
 * Dosya yoksa boştur. Shell evaluation yoktur. Kullanıcı sahibi olmayan,
 * grup/diğer erişimi açık, 64 KiB'yi aşan veya düz string nesnesi olmayan
 * dosya reddedilir. Mesajlar değer içermez; JSON hatasının metni bile içerik
 * parçası taşıyabileceği için aktarılmaz.
 */
export function readUserEnvironment(file: string): UserEnvironment {
  const reject = (reason: string): UserEnvironment => ({ ok: false, message: `${file}: ${reason}` })
  let raw: string
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, values: {} }
    return reject(`okunamadı (${(err as NodeJS.ErrnoException).code ?? 'bilinmeyen hata'})`)
  }
  try {
    // Denetim okunan dosyanın kendisine yapılır; yol arada değişse de sonuç tutarlıdır.
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) return reject('düzenli dosya değil')
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return reject('kullanıcıya ait değil')
    if ((stat.mode & 0o077) !== 0) return reject('grup veya diğer kullanıcılar erişebiliyor; chmod 600 ile kapatın')
    if (stat.size > USER_ENVIRONMENT_MAX_BYTES) return reject('64 KiB sınırını aşıyor')
    raw = fs.readFileSync(fd, 'utf8')
  } catch (err) {
    return reject(`okunamadı (${(err as NodeJS.ErrnoException).code ?? 'bilinmeyen hata'})`)
  } finally {
    fs.closeSync(fd)
  }
  if (Buffer.byteLength(raw) > USER_ENVIRONMENT_MAX_BYTES) return reject('64 KiB sınırını aşıyor')

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return reject('JSON olarak okunamadı')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return reject('ad → string değer eşleyen bir JSON nesnesi olmalı')
  }
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return reject(`geçersiz değişken adı: ${JSON.stringify(key.slice(0, 64))}`)
    if (typeof value !== 'string') return reject(`${key} değeri string olmalı`)
    if (value.includes('\u0000')) return reject(`${key} değeri NUL karakteri içeriyor`)
    if (key === 'TERM' || key.startsWith('AGENTDECK_')) return reject(`${key} uygulama tarafından atanır`)
    if (PARENT_AGENT_MARKERS.includes(key)) return reject(`${key} ajan oturumu işaretçisidir; kabul edilmez`)
    values[key] = value
  }
  return { ok: true, values }
}

export function runEnv(
  base: NodeJS.ProcessEnv,
  ids: RunIdentity,
  user: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (ALLOWED.includes(key) || key.startsWith('LC_')) env[key] = value
  }
  // PORT kullanıcının environment.json değeriyle ezilebilir; AGENTDECK_PORT her zaman ayrılan porttur.
  if (ids.port !== undefined) env.PORT = String(ids.port)
  Object.assign(env, user)

  // Ekran tarafımızdaki xterm truecolor'ı destekler; miras varsa kullanıcının
  // değeri korunur, yoksa daemon'ın başlatıldığı ortam belirleyici olmaz.
  if (env.COLORTERM === undefined) env.COLORTERM = 'truecolor'

  // TERM ve AGENTDECK_* rezervdir: mirastan gelen değer kabul edilmez.
  env.TERM = 'xterm-256color'
  env.AGENTDECK_SESSION = ids.sessionId
  env.AGENTDECK_RUN = ids.runId
  if (ids.hookDir) env.AGENTDECK_HOOK_DIR = ids.hookDir
  if (ids.port !== undefined) env.AGENTDECK_PORT = String(ids.port)

  return env
}
