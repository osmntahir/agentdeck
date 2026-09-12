import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Her test kendi veri dizininde çalışır; gerçek ~/.agentdeck'e dokunulmaz. */
export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-test-'))
}

export function removeDir(dir: string): void {
  fs.chmodSync(dir, 0o755)
  fs.rmSync(dir, { recursive: true, force: true })
}

export const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
