import fs from 'node:fs'
import path from 'node:path'
import { agentFor } from '../shared/agents'

/** Linux süreç ağacı; yalnız program adı döner, argümanlar API'ye taşınmaz. */
export function processAgent(rootPid: number): string | null {
  const queue = [rootPid]; const seen = new Set<number>(); const found = new Set<string>()
  const deadline = performance.now() + 4
  while (queue.length && seen.size < 32 && performance.now() < deadline) {
    const pid = queue.shift()!
    if (seen.has(pid)) continue
    seen.add(pid)
    try {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
      const program = path.basename(args[0] ?? '')
      const direct = agentFor(program)
      const script = ['node', 'bun', 'deno'].includes(program) ? path.basename(args[1] ?? '').replace(/\.(?:js|mjs|cjs)$/, '') : ''
      const scriptPath = args[1] ?? ''
      const packaged = ['node', 'bun', 'deno'].includes(program)
        ? /\/@anthropic-ai\/claude-code\//.test(scriptPath) ? 'claude'
          : /\/@openai\/codex\//.test(scriptPath) ? 'codex'
            : /\/@google\/gemini-cli\//.test(scriptPath) ? 'gemini' : null
        : null
      const agent = direct ?? agentFor(script) ?? agentFor(packaged)
      if (agent) found.add(agent.command)
      // Shell -c içeriğini aramayız: echo veya prompt metni program değildir.
      const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).map(Number).filter(n => n > 0)
      queue.push(...children)
    } catch { /* Süreç okuma sırasında sonlanabilir; tahmin üretmeyiz. */ }
  }
  return found.size === 1 ? [...found][0] : null
}
