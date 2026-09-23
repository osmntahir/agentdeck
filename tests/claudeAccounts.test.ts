import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { claudePaths, openClaudeAccounts, type ClaudePaths } from '../src/server/claudeAccounts'
import { startDaemon } from '../src/server/daemon'
import { tempDir, removeDir } from './helpers'

function login(paths: ClaudePaths, n: number, extra: { credentials?: object; config?: object } = {}): void {
  fs.mkdirSync(path.dirname(paths.credentials), { recursive: true })
  fs.writeFileSync(paths.credentials, JSON.stringify({
    ...extra.credentials,
    claudeAiOauth: { accessToken: `access-${n}`, refreshToken: `refresh-${n}`, subscriptionType: 'pro' },
  }), { mode: 0o600 })
  fs.writeFileSync(paths.config, JSON.stringify({
    ...extra.config,
    oauthAccount: { accountUuid: `uuid-${n}`, emailAddress: `kisi${n}@example.com`, organizationName: `Org ${n}` },
  }))
}

const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))

function withAccounts(fn: (ctx: { dir: string; live: ClaudePaths; store: string }) => void): void {
  const dir = tempDir()
  try {
    fn({ dir, live: claudePaths({}, dir), store: path.join(dir, 'agentdeck', 'claude-accounts.json') })
  } finally {
    removeDir(dir)
  }
}

test('canlı dosya yolları CLAUDE_CONFIG_DIR varsa onun içindedir', () => {
  assert.deepEqual(claudePaths({}, '/h'), { credentials: '/h/.claude/.credentials.json', config: '/h/.claude.json' })
  assert.deepEqual(claudePaths({ CLAUDE_CONFIG_DIR: '/c' }, '/h'), { credentials: '/c/.credentials.json', config: '/c/.claude.json' })
})

test('kayıtsız canlı oturum listede görünür, kaydedilince etkin olur', () => withAccounts(({ live, store }) => {
  const accounts = openClaudeAccounts(store, live)
  assert.deepEqual(accounts.list(), { accounts: [], unsaved: null })
  login(live, 1)
  assert.deepEqual(accounts.list().unsaved, { email: 'kisi1@example.com' })
  const saved = accounts.saveLive()
  assert.equal(saved?.active, true)
  assert.equal(saved?.subscription, 'pro')
  assert.equal(accounts.list().unsaved, null)
  assert.equal(fs.statSync(store).mode & 0o777, 0o600)
}))

test('yanıtlarda token taşınmaz', () => withAccounts(({ live, store }) => {
  login(live, 1)
  const accounts = openClaudeAccounts(store, live)
  accounts.saveLive()
  assert.doesNotMatch(JSON.stringify(accounts.list()), /access-1|refresh-1/)
}))

test('geçiş yalnız kimlik alanlarını değiştirir, komşu alanları korur', () => withAccounts(({ dir, live, store }) => {
  login(live, 1, { credentials: { mcpOAuth: { server: 'x' } }, config: { theme: 'dark', projects: { a: 1 } } })
  const accounts = openClaudeAccounts(store, live)
  const other = claudePaths({ CLAUDE_CONFIG_DIR: path.join(dir, 'login') })
  login(other, 2)
  const imported = accounts.importFrom(other)
  assert.equal(imported.active, false)
  // İçe aktarma canlı hesabı da kaydeder mi? Hayır; yalnız geçişte kaydedilir.
  assert.equal(read(live.credentials).claudeAiOauth.accessToken, 'access-1')

  accounts.activate('uuid-2')
  const credentials = read(live.credentials)
  const config = read(live.config)
  assert.equal(credentials.claudeAiOauth.accessToken, 'access-2')
  assert.deepEqual(credentials.mcpOAuth, { server: 'x' })
  assert.equal(config.oauthAccount.emailAddress, 'kisi2@example.com')
  assert.equal(config.theme, 'dark')
  assert.deepEqual(config.projects, { a: 1 })
  assert.equal(fs.statSync(live.credentials).mode & 0o777, 0o600)

  const list = accounts.list()
  assert.deepEqual(list.accounts.map((a) => [a.id, a.active]), [['uuid-2', true], ['uuid-1', false]])
}))

test('geçişten önce canlı hesabın yenilenmiş token ı kayda alınır', () => withAccounts(({ dir, live, store }) => {
  login(live, 1)
  const accounts = openClaudeAccounts(store, live)
  accounts.saveLive()
  const other = claudePaths({ CLAUDE_CONFIG_DIR: path.join(dir, 'login') })
  login(other, 2)
  accounts.importFrom(other)
  // Claude Code token'ı kendi yeniledi.
  const credentials = read(live.credentials)
  credentials.claudeAiOauth.refreshToken = 'refresh-1-yeni'
  fs.writeFileSync(live.credentials, JSON.stringify(credentials))

  accounts.activate('uuid-2')
  accounts.activate('uuid-1')
  assert.equal(read(live.credentials).claudeAiOauth.refreshToken, 'refresh-1-yeni')
}))

test('hesap bilgisi olmayan canlı oturum ezilmez', () => withAccounts(({ dir, live, store }) => {
  login(live, 1)
  const config = read(live.config)
  delete config.oauthAccount
  fs.writeFileSync(live.config, JSON.stringify(config))
  const accounts = openClaudeAccounts(store, live)
  const other = claudePaths({ CLAUDE_CONFIG_DIR: path.join(dir, 'login') })
  login(other, 2)
  accounts.importFrom(other)
  assert.deepEqual(accounts.list().unsaved, { email: null })
  assert.throws(() => accounts.activate('uuid-2'), { code: 'unknown_live' })
  assert.equal(read(live.credentials).claudeAiOauth.accessToken, 'access-1')
}))

test('oturum kapalıyken geçiş dosyaları oluşturur; etkin hesap kaldırılamaz', () => withAccounts(({ dir, live, store }) => {
  const accounts = openClaudeAccounts(store, live)
  const other = claudePaths({ CLAUDE_CONFIG_DIR: path.join(dir, 'login') })
  login(other, 2)
  accounts.importFrom(other)
  accounts.activate('uuid-2')
  assert.equal(read(live.credentials).claudeAiOauth.accessToken, 'access-2')
  assert.throws(() => accounts.remove('uuid-2'), { code: 'active' })
  assert.throws(() => accounts.activate('yok'), { code: 'not_found' })
}))

test('tamamlanmamış giriş içe aktarılmaz', () => withAccounts(({ dir, live, store }) => {
  const accounts = openClaudeAccounts(store, live)
  assert.throws(() => accounts.importFrom(claudePaths({ CLAUDE_CONFIG_DIR: path.join(dir, 'bos') })), { code: 'login_incomplete' })
}))

test('daemon: geçici dizinde giriş, içe aktarma ve tek tuşla geçiş', { timeout: 20000 }, async () => {
  const dir = tempDir()
  const live = claudePaths({}, path.join(dir, 'home'))
  login(live, 1)
  // Gerçek CLI yerine: adres basar, kodu bekler, kimliği CLAUDE_CONFIG_DIR'e yazar.
  const fake = path.join(dir, 'fake-claude.cjs')
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const dir = process.env.CLAUDE_CONFIG_DIR
process.stdout.write('Browser didn\\'t open? https://claude.ai/oauth/authorize?code=true&state=abc\\r\\nPaste code here: ')
process.stdin.setRawMode(true)
let got = ''
process.stdin.on('data', (d) => {
  got += d
  if (!got.includes('\\r')) return
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'access-2', subscriptionType: 'pro' } }))
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-2', emailAddress: 'kisi2@example.com' } }))
  process.exit(got.startsWith('kod') ? 0 : 3)
})
`, { mode: 0o755 })

  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir)
  const daemon = await startDaemon({ dataDir, port: 0, claudeAccounts: { live, command: fake } })
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${daemon.url}${route}`, {
      method,
      headers: { 'X-Agentdeck-Token': daemon.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() as any }
  }
  const until = async (check: (body: any) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const { body } = await call('GET', '/api/claude-accounts')
      if (check(body)) return body
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('zaman aşımı')
  }
  try {
    let state = (await call('GET', '/api/claude-accounts')).body
    assert.equal(state.supported, true)
    assert.deepEqual(state.unsaved, { email: 'kisi1@example.com' })

    assert.equal((await call('POST', '/api/claude-accounts/login')).status, 200)
    assert.equal((await call('POST', '/api/claude-accounts/login')).body.code, 'login_running')
    state = await until((b) => b.login?.url)
    assert.equal(state.login.url, 'https://claude.ai/oauth/authorize?code=true&state=abc')
    await call('POST', '/api/claude-accounts/login/input', { text: 'kod\r' })
    state = await until((b) => b.login?.state !== 'running')
    assert.equal(state.login.state, 'done', state.login.message)
    assert.equal(state.login.account.email, 'kisi2@example.com')
    // Mevcut hesap da kendiliğinden kaydedildi.
    assert.equal(state.unsaved, null)
    assert.deepEqual(state.accounts.map((a: any) => [a.email, a.active]), [['kisi1@example.com', true], ['kisi2@example.com', false]])
    // Giriş canlı hesabı değiştirmedi; geçici dizin kalmadı.
    assert.equal(read(live.credentials).claudeAiOauth.accessToken, 'access-1')
    assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.startsWith('claude-login-')), [])

    assert.equal((await call('POST', '/api/claude-accounts/uuid-2/activate')).status, 200)
    assert.equal(read(live.credentials).claudeAiOauth.accessToken, 'access-2')
    state = (await call('GET', '/api/claude-accounts')).body
    assert.equal(state.unsaved, null)
    assert.deepEqual(state.accounts.map((a: any) => [a.email, a.active]), [['kisi1@example.com', false], ['kisi2@example.com', true]])
    assert.doesNotMatch(JSON.stringify(state), /access-/)
    assert.equal((await call('DELETE', '/api/claude-accounts/uuid-2')).status, 409)
  } finally {
    await daemon.close()
    removeDir(dir)
  }
})

test('daemon: yapılandırılmamışsa hesap paneli desteklenmez', async () => {
  const dataDir = tempDir()
  const daemon = await startDaemon({ dataDir, port: 0 })
  try {
    const res = await fetch(`${daemon.url}/api/claude-accounts`, { headers: { 'X-Agentdeck-Token': daemon.token } })
    assert.deepEqual(await res.json(), { supported: false, accounts: [], unsaved: null, login: null })
  } finally {
    await daemon.close()
    removeDir(dataDir)
  }
})
