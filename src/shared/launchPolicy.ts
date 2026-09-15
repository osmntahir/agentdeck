import type { LastLaunch, Session } from './types'

/** CLI'ın kendi konuşma seçicisi olan programlar. */
export const CLI_COMMANDS = {
  claude: { label: 'Claude', picker: 'claude --resume' },
  codex: { label: 'Codex', picker: 'codex resume' },
  gemini: { label: 'Gemini', picker: 'gemini --resume' },
} as const

export type LaunchCli = keyof typeof CLI_COMMANDS

/** Açık konuşma kimliğiyle doğrudan devam edebilen komutlar. */
const RESUME_PREFIXES = {
  claude: 'claude --resume ',
  codex: 'codex resume ',
  gemini: 'gemini --resume ',
  grok: 'grok --resume ',
  opencode: 'opencode --session ',
  agy: 'agy --conversation=',
} as const

export type ResumeCli = keyof typeof RESUME_PREFIXES

/** Yalnız tam literal çağrı tanınır; genel kabuk programı ayrıştırılmaz. */
export function launchCli(command: string | null): LaunchCli | null {
  const literal = command?.trim()
  return literal === 'claude' || literal === 'codex' || literal === 'gemini' ? literal : null
}

function resumeCli(cli: string): ResumeCli | null {
  return Object.hasOwn(RESUME_PREFIXES, cli) ? cli as ResumeCli : null
}

/** CLI'ın kendi seçicisi; UUID veya serbest komut bu kısayola girmez. */
export function pickerCli(command: string | null): LaunchCli | null {
  const trimmed = command?.trim()
  if (!trimmed) return null
  for (const cli of Object.keys(CLI_COMMANDS) as LaunchCli[]) {
    if (CLI_COMMANDS[cli].picker === trimmed) return cli
  }
  return null
}

/** UUID dışında ad, yol, latest ve kabuk ifadeleri bu kısayola kabul edilmez. */
export function explicitResumeCommand(cli: ResumeCli, conversationId: string): string | null {
  const id = conversationId.trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null
  return `${RESUME_PREFIXES[cli]}${id}`
}

/** Kullanıcının açık UUID komutu; yönetilen kimlik üretimi değildir. */
export function explicitResumeOf(command: string | null): { cli: ResumeCli; conversationId: string } | null {
  const trimmed = command?.trim()
  if (!trimmed) return null
  for (const cli of Object.keys(RESUME_PREFIXES) as ResumeCli[]) {
    const prefix = RESUME_PREFIXES[cli]
    if (!trimmed.startsWith(prefix)) continue
    const conversationId = trimmed.slice(prefix.length)
    if (explicitResumeCommand(cli, conversationId) === trimmed) return { cli, conversationId }
  }
  return null
}

/**
 * Yeniden çalıştırmanın tekrarlayacağı program. fresh/picker/resume
 * niyeti command string'e çevrilir; UUID üretilmez. undefined desteklenmeyen
 * eski niyettir; null ise geçerli etkileşimli kabuktur. Sessiz fallback yoktur.
 */
export function repeatLaunchCommand(session: Pick<Session, 'command' | 'lastLaunch'>): string | null | undefined {
  const last = session.lastLaunch
  if (!last) return session.command
  if (last.mode === 'command') return last.command
  if (last.mode === 'fresh') return launchCli(last.cli) ?? undefined
  if (last.mode === 'picker') {
    const cli = launchCli(last.cli)
    return cli ? CLI_COMMANDS[cli].picker : undefined
  }
  const cli = resumeCli(last.cli)
  return (cli && explicitResumeCommand(cli, last.conversationId)) || undefined
}

/** Launch isteğinin kayda yazacağı niyet; G2 UUID üretmez. */
export function lastLaunchFor(
  mode: 'command' | 'fresh' | 'picker',
  command: string | null,
): LastLaunch | null {
  if (mode === 'fresh') {
    const cli = launchCli(command)
    return cli ? { mode: 'fresh', cli, conversationId: null } : null
  }
  if (mode === 'picker') {
    const cli = pickerCli(command)
    return cli ? { mode: 'picker', cli } : null
  }
  return { mode: 'command', command }
}
