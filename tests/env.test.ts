import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEnv } from '../src/server/env'

const ids = { sessionId: 's1', runId: 'r1' }

test('temel izin listesindeki değişkenler taşınır', () => {
  const env = runEnv(
    { HOME: '/home/x', PATH: '/usr/bin', LANG: 'tr_TR.UTF-8', LC_TIME: 'tr_TR.UTF-8', SSH_AUTH_SOCK: '/run/ssh', CODEX_HOME: '/home/x/.codex' },
    ids,
  )
  assert.equal(env.HOME, '/home/x')
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.LANG, 'tr_TR.UTF-8')
  assert.equal(env.LC_TIME, 'tr_TR.UTF-8', 'LC_* öneki taşınır')
  assert.equal(env.SSH_AUTH_SOCK, '/run/ssh')
  assert.equal(env.CODEX_HOME, '/home/x/.codex', 'kullanıcı CLI evi korunur')
})

test('daemon kabuğunun geri kalan ortamı kopyalanmaz', () => {
  const env = runEnv(
    {
      HOME: '/home/x',
      NODE_OPTIONS: '--inspect',
      ELECTRON_RUN_AS_NODE: '1',
      BASH_ENV: '/tmp/kotu.sh',
      ENV: '/tmp/kotu.sh',
      BASH_FUNC_foo: '() { :; }',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION: 'abc',
      GEMINI_CLI_SESSION_ID: 'xyz',
      RASTGELE_DEGISKEN: 'var',
    },
    ids,
  )
  for (const key of [
    'NODE_OPTIONS',
    'ELECTRON_RUN_AS_NODE',
    'BASH_ENV',
    'ENV',
    'BASH_FUNC_foo',
    'CLAUDECODE',
    'CLAUDE_CODE_SESSION',
    'GEMINI_CLI_SESSION_ID',
    'RASTGELE_DEGISKEN',
  ]) {
    assert.equal(env[key], undefined, `${key} taşınmamalı`)
  }
})

test('TERM ve AGENTDECK_* uygulama tarafından atanır, miras ezilir', () => {
  const env = runEnv({ TERM: 'dumb', AGENTDECK_SESSION: 'sahte', AGENTDECK_RUN: 'sahte' }, ids)
  assert.equal(env.TERM, 'xterm-256color')
  assert.equal(env.AGENTDECK_SESSION, 's1')
  assert.equal(env.AGENTDECK_RUN, 'r1')
})

test('COLORTERM mirası korunur, yoksa uygulama varsayılanı verilir', () => {
  assert.equal(runEnv({ COLORTERM: '24bit' }, ids).COLORTERM, '24bit')
  assert.equal(runEnv({}, ids).COLORTERM, 'truecolor')
})

test('tanımsız değer taşınmaz', () => {
  const env = runEnv({ HOME: undefined, USER: 'x' }, ids)
  assert.equal('HOME' in env, false)
  assert.equal(env.USER, 'x')
})
