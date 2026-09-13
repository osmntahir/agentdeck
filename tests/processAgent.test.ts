import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { processAgent } from '../src/server/processAgent'
import { tempDir, removeDir } from './helpers'

test('elle açılan ajan süreçten tanınır; kabuk komutu metninden tahmin yapılmaz', async () => {
  const dir = tempDir()
  fs.copyFileSync('/bin/sleep', path.join(dir, 'opencode')); fs.chmodSync(path.join(dir, 'opencode'), 0o755)
  const child = spawn(path.join(dir, 'opencode'), ['20'])
  const shell = spawn('/bin/bash', ['-c', 'echo claude >/dev/null; sleep 20'])
  try {
    await once(child, 'spawn');
    assert.equal(processAgent(child.pid!), 'opencode')
    assert.equal(processAgent(shell.pid!), null)
    assert.equal(processAgent(99999999), null)
  } finally {
    child.kill('SIGKILL'); shell.kill('SIGKILL');
    await Promise.all([once(child, 'exit'), once(shell, 'exit')]); removeDir(dir)
  }
})
