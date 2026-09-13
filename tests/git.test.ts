import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { diff } from '../src/server/git'
import { removeDir, tempDir } from './helpers'

test('diff okuma sırasında HEAD değişirse stale işaretlenir', { timeout: 15000 }, async () => {
  const dir = tempDir()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  try {
    fs.mkdirSync(dir, { recursive: true })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@agentdeck.local')
    git('config', 'user.name', 'AgentDeck Test')
    const slow = path.join(dir, 'slow-filter.sh')
    fs.writeFileSync(slow, '#!/bin/sh\nsleep 0.3\ncat\n')
    fs.chmodSync(slow, 0o755)
    git('config', 'filter.slow.clean', slow)
    git('config', 'filter.slow.smudge', 'cat')
    git('config', 'filter.slow.required', 'true')
    fs.writeFileSync(path.join(dir, 'README.md'), 'ilk\n')
    fs.writeFileSync(path.join(dir, '.gitattributes'), 'README.md filter=slow\n')
    git('add', '.')
    git('commit', '-qm', 'ilk')
    fs.writeFileSync(path.join(dir, 'README.md'), 'ikinci\n')

    const pending = diff(dir, 'HEAD')
    await new Promise((resolve) => setTimeout(resolve, 80))
    git('commit', '--allow-empty', '-qm', 'yarış')
    const result = await pending
    assert.equal(result.error, null, result.error ?? '')
    assert.equal(result.stale, true)

    const quiet = await diff(dir, 'HEAD')
    assert.equal(quiet.error, null, quiet.error ?? '')
    assert.equal(quiet.stale, false)
  } finally {
    removeDir(dir)
  }
})
