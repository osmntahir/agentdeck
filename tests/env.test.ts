import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { readUserEnvironment, runEnv } from '../src/server/env'
import { removeDir, tempDir } from './helpers'

const ids = { sessionId: 's1', runId: 'r1' }

test('environment.json yoksa boş sayılır; düz string değerler Run ortamına eklenir', () => {
  const dir = tempDir()
  const file = path.join(dir, 'environment.json')
  try {
    assert.deepEqual(readUserEnvironment(file), { ok: true, values: {} })

    fs.writeFileSync(file, JSON.stringify({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9000', PATH: '/opt/bin:/usr/bin' }), {
      mode: 0o600,
    })
    const read = readUserEnvironment(file)
    assert.ok(read.ok, JSON.stringify(read))
    const env = runEnv({ PATH: '/usr/bin', HOME: '/home/x' }, ids, read.values)
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9000')
    assert.equal(env.PATH, '/opt/bin:/usr/bin', 'kullanıcı dosyası temel değeri geçersiz kılar')
    assert.equal(env.HOME, '/home/x')
  } finally {
    removeDir(dir)
  }
})

test('geçersiz environment.json reddedilir; hata mesajı değer içermez', () => {
  const dir = tempDir()
  const secret = 'sk-gizli-deger-123'
  const cases: [string, string | Buffer, number][] = [
    ['grup/diğer erişimi açık', JSON.stringify({ API_KEY: secret }), 0o644],
    ['64 KiB tavanı aşıldı', JSON.stringify({ API_KEY: secret, PAD: 'x'.repeat(64 * 1024) }), 0o600],
    ['JSON değil', `{"API_KEY": "${secret}"`, 0o600],
    ['nesne değil', JSON.stringify([secret]), 0o600],
    ['string olmayan değer', JSON.stringify({ API_KEY: secret, PORT: 9000 }), 0o600],
    ['geçersiz ad', JSON.stringify({ API_KEY: secret, 'A=B': secret }), 0o600],
    ['NUL içeren değer', JSON.stringify({ API_KEY: `${secret}\u0000` }), 0o600],
    ['TERM rezerv', JSON.stringify({ API_KEY: secret, TERM: 'dumb' }), 0o600],
    ['AGENTDECK_* rezerv', JSON.stringify({ API_KEY: secret, AGENTDECK_RUN: secret }), 0o600],
    ['parent ajan işaretçisi', JSON.stringify({ API_KEY: secret, CLAUDECODE: '1' }), 0o600],
  ]
  try {
    for (const [name, content, mode] of cases) {
      const file = path.join(dir, `${cases.findIndex((c) => c[0] === name)}.json`)
      fs.writeFileSync(file, content)
      fs.chmodSync(file, mode)
      const read = readUserEnvironment(file)
      assert.equal(read.ok, false, `${name}: reddedilmeli`)
      if (!read.ok) {
        assert.ok(read.message.length > 0, `${name}: nedeni söylenmeli`)
        assert.ok(!read.message.includes(secret), `${name}: mesaj değeri sızdırmamalı`)
      }
    }
  } finally {
    removeDir(dir)
  }
})

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

test('ayrılan port PORT olarak verilir; miras düşer, kullanıcı ortamı ezebilir', () => {
  const withPort = { ...ids, port: 4803 }
  const env = runEnv({ PORT: '3000' }, withPort)
  assert.equal(env.PORT, '4803')
  assert.equal(env.AGENTDECK_PORT, '4803')
  const user = runEnv({}, withPort, { PORT: '3000' })
  assert.equal(user.PORT, '3000')
  assert.equal(user.AGENTDECK_PORT, '4803')
  assert.equal(runEnv({ PORT: '3000' }, ids).PORT, undefined)
})
