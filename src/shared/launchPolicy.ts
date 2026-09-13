/** Seçiciler ve açık UUID komutları; yönetilen kimlik üretimi değildir. */
export const CLI_COMMANDS = {
  claude: { label: 'Claude', picker: 'claude --resume' },
  codex: { label: 'Codex', picker: 'codex resume' },
  gemini: { label: 'Gemini', picker: 'gemini --resume' },
} as const

export type LaunchCli = keyof typeof CLI_COMMANDS

/** Yalnız tam literal çağrı tanınır; genel kabuk programı ayrıştırılmaz. */
export function launchCli(command: string | null): LaunchCli | null {
  const literal = command?.trim()
  return literal === 'claude' || literal === 'codex' || literal === 'gemini' ? literal : null
}

/** UUID dışında ad, yol, latest ve kabuk ifadeleri bu kısayola kabul edilmez. */
export function explicitResumeCommand(cli: LaunchCli, conversationId: string): string | null {
  const id = conversationId.trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null
  return `${CLI_COMMANDS[cli].picker} ${id}`
}

/** Kullanıcının açık UUID komutu; yönetilen kimlik üretimi değildir. */
export function explicitResumeOf(command: string | null): { cli: LaunchCli; conversationId: string } | null {
  const trimmed = command?.trim()
  if (!trimmed) return null
  for (const cli of Object.keys(CLI_COMMANDS) as LaunchCli[]) {
    const prefix = `${CLI_COMMANDS[cli].picker} `
    if (!trimmed.startsWith(prefix)) continue
    const conversationId = trimmed.slice(prefix.length)
    if (explicitResumeCommand(cli, conversationId) === trimmed) return { cli, conversationId }
  }
  return null
}
