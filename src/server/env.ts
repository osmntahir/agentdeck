/**
 * Run ortamı sözleşmesi. Daemon'ın açıldığı kabuğun tüm env'i PTY'ye
 * kopyalanmaz: yalnız temel izin listesi taşınır. Liste dışı her şey — parent
 * ajan işaretçileri, NODE_OPTIONS, ELECTRON_RUN_AS_NODE, BASH_ENV/ENV ve
 * BASH_FUNC_* dahil — düşer. Kullanıcının environment.json dosyası bu
 * fonksiyonun kapsamı dışındadır (spec §3, uygulama sırası §8/2).
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
}

export function runEnv(base: NodeJS.ProcessEnv, ids: RunIdentity): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (ALLOWED.includes(key) || key.startsWith('LC_')) env[key] = value
  }

  // Ekran tarafımızdaki xterm truecolor'ı destekler; miras varsa kullanıcının
  // değeri korunur, yoksa daemon'ın başlatıldığı ortam belirleyici olmaz.
  if (env.COLORTERM === undefined) env.COLORTERM = 'truecolor'

  // TERM ve AGENTDECK_* rezervdir: mirastan gelen değer kabul edilmez.
  env.TERM = 'xterm-256color'
  env.AGENTDECK_SESSION = ids.sessionId
  env.AGENTDECK_RUN = ids.runId

  return env
}
