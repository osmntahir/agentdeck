import { explicitResumeCommand, type ResumeCli } from './launchPolicy'

export interface ResumeTarget {
  cli: ResumeCli
  conversationId: string
  command: string
}

/** Açık konuşma kimliğini kabul eden her AgentDeck CLI'ının komut biçimi. */
const COMMANDS: ReadonlyArray<{ cli: ResumeCli; pattern: RegExp }> = [
  { cli: 'claude', pattern: /\bclaude\s+(?:--resume|-r)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i },
  { cli: 'codex', pattern: /\bcodex\s+resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i },
  { cli: 'gemini', pattern: /\bgemini\s+(?:--resume|-r)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i },
  { cli: 'grok', pattern: /\bgrok\s+(?:--resume|-r)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i },
  { cli: 'opencode', pattern: /\bopencode\s+(?:--session|-s)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i },
  { cli: 'agy', pattern: /\bagy\s+--conversation(?:=|\s+)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i },
]

function visibleText(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
}

/** CLI'ın kendi footer'ı dışındaki komut örnekleri konuşma kimliği sayılmaz. */
function isResumeFooter(line: string): boolean {
  return /^\s*(?:resume(?: this session| with -c)?|to resume(?: this session)?|continue(?: this session)?)\b/i.test(line)
}

/** Görüntü veya canlı çıktı içinde son doğrulanmış resume footer'ını döndürür. */
export function resumeTargetFromTerminalText(value: string): ResumeTarget | null {
  const lines = visibleText(value).split(/\r?\n/)
  let found: ResumeTarget | null = null
  for (let index = 0; index < lines.length; index += 1) {
    if (!isResumeFooter(lines[index] ?? '')) continue
    // Bazı CLI'lar komutu footer ile aynı satırda, bazıları sonraki satırda basar.
    const footer = lines.slice(index, index + 4).join('\n')
    for (const { cli, pattern } of COMMANDS) {
      const match = footer.match(pattern)
      if (!match) continue
      const conversationId = match[1]
      const command = explicitResumeCommand(cli, conversationId)
      if (command) found = { cli, conversationId, command }
    }
  }
  return found
}
