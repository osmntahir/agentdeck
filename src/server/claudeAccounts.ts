import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ClaudeAccountView } from '../shared/types'

/**
 * Claude hesap geçişi (ADR 0017). Claude Code Linux/Windows'ta kimliği iki
 * dosyada tutar: `.credentials.json` içindeki `claudeAiOauth` (token) ve
 * `.claude.json` içindeki `oauthAccount` (hesap bilgisi). Geçiş yalnız bu iki
 * alanı değiştirir; `mcpOAuth` gibi komşu alanlar ve diğer ayarlar korunur.
 * Canlı dosyadaki hesap üzerine yazılmadan önce her zaman kayda alınır: tanınmayan
 * bir oturum hiçbir yolla silinmez.
 */
export interface ClaudePaths {
  credentials: string
  config: string
}

/** Claude Code'un kullandığı canlı dosyalar; CLAUDE_CONFIG_DIR varsa ikisi de onun içindedir. */
export function claudePaths(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): ClaudePaths {
  const dir = env.CLAUDE_CONFIG_DIR
  if (dir) return { credentials: path.join(dir, '.credentials.json'), config: path.join(dir, '.claude.json') }
  return { credentials: path.join(home, '.claude', '.credentials.json'), config: path.join(home, '.claude.json') }
}

type Json = Record<string, unknown>

interface StoredAccount {
  id: string
  oauthAccount: Json
  claudeAiOauth: Json
  savedAt: number
}

interface Identity {
  oauthAccount: Json
  claudeAiOauth: Json
}

export class AccountError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'AccountError'
  }
}

function readJson(file: string): Json | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new AccountError('unreadable', `${file} okunamadı (${(err as NodeJS.ErrnoException).code ?? 'bilinmeyen hata'})`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // İçerik token taşıyabilir; hata metni aktarılmaz.
    throw new AccountError('unreadable', `${file} JSON olarak okunamadı`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AccountError('unreadable', `${file} beklenen biçimde değil`)
  }
  return parsed as Json
}

/** Aynı dizinde geçici dosya + rename; mevcut izinler korunur, yoksa 0600. */
function writeJson(file: string, value: Json, fallbackMode = 0o600): void {
  let mode = fallbackMode
  try {
    mode = fs.statSync(file).mode & 0o777
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  }
  const tmp = `${file}.agentdeck-${process.pid}-${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode })
  fs.renameSync(tmp, file)
}

const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)

function accountId(oauthAccount: Json): string | null {
  const id = oauthAccount.accountUuid ?? oauthAccount.emailAddress
  return typeof id === 'string' && id !== '' ? id : null
}

function readIdentity(paths: ClaudePaths): Identity | null {
  const credentials = readJson(paths.credentials)
  const config = readJson(paths.config)
  if (!isObject(credentials?.claudeAiOauth)) return null
  if (!isObject(config?.oauthAccount)) {
    throw new AccountError('unknown_live', 'Claude oturumu açık ama hesap bilgisi (oauthAccount) bulunamadı; üzerine yazılmadı')
  }
  return { oauthAccount: config.oauthAccount, claudeAiOauth: credentials.claudeAiOauth }
}

const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null)

function view(account: StoredAccount, activeId: string | null): ClaudeAccountView {
  return {
    id: account.id,
    email: text(account.oauthAccount.emailAddress),
    displayName: text(account.oauthAccount.displayName),
    organization: text(account.oauthAccount.organizationName),
    subscription: text(account.claudeAiOauth.subscriptionType),
    active: account.id === activeId,
    savedAt: account.savedAt,
  }
}

export interface ClaudeAccounts {
  list(): { accounts: ClaudeAccountView[]; unsaved: { email: string | null } | null }
  /** Canlı dosyadaki hesabı kayda alır veya kaydını tazeler; oturum yoksa null. */
  saveLive(): ClaudeAccountView | null
  /** Başka bir yapılandırma dizininde açılmış oturumu kayda alır; canlı dosyaya dokunmaz. */
  importFrom(source: ClaudePaths): ClaudeAccountView
  activate(id: string): ClaudeAccountView
  remove(id: string): void
}

/** storeFile token içerir: 0600 yazılır ve yanıtlarda token hiç taşınmaz. */
export function openClaudeAccounts(storeFile: string, live: ClaudePaths): ClaudeAccounts {
  const load = (): StoredAccount[] => {
    const data = readJson(storeFile)
    const accounts = data?.accounts
    if (!Array.isArray(accounts)) return []
    return accounts.filter((a): a is StoredAccount =>
      isObject(a) && typeof a.id === 'string' && isObject(a.oauthAccount) && isObject(a.claudeAiOauth))
  }
  const save = (accounts: StoredAccount[]) => writeJson(storeFile, { version: 1, accounts }, 0o600)

  const upsert = (identity: Identity): StoredAccount => {
    const id = accountId(identity.oauthAccount)
    if (!id) throw new AccountError('unknown_live', 'Hesap kimliği okunamadı')
    const accounts = load()
    const stored: StoredAccount = { id, ...identity, savedAt: Date.now() }
    const index = accounts.findIndex((a) => a.id === id)
    if (index >= 0) accounts[index] = stored
    else accounts.push(stored)
    save(accounts)
    return stored
  }

  /** Tanınmayan canlı oturumda etkin hesap yoktur; ezilmesini activate ayrıca reddeder. */
  const liveId = () => {
    try {
      const identity = readIdentity(live)
      return identity ? accountId(identity.oauthAccount) : null
    } catch (err) {
      if (err instanceof AccountError && err.code === 'unknown_live') return null
      throw err
    }
  }

  return {
    list() {
      let identity: Identity | null
      try {
        identity = readIdentity(live)
      } catch (err) {
        // Tanınmayan canlı oturum listeyi düşürmez; geçiş yine reddedilir.
        if (err instanceof AccountError && err.code === 'unknown_live') return { accounts: load().map((a) => view(a, null)), unsaved: { email: null } }
        throw err
      }
      const activeId = identity ? accountId(identity.oauthAccount) : null
      const accounts = load()
      const unsaved = identity && !accounts.some((a) => a.id === activeId)
        ? { email: text(identity.oauthAccount.emailAddress) }
        : null
      return { accounts: accounts.map((a) => view(a, activeId)), unsaved }
    },

    saveLive() {
      const identity = readIdentity(live)
      if (!identity) return null
      return view(upsert(identity), accountId(identity.oauthAccount))
    },

    importFrom(source) {
      const identity = readIdentity(source)
      if (!identity) throw new AccountError('login_incomplete', 'Giriş tamamlanmadı; kimlik dosyası oluşmadı')
      return view(upsert(identity), liveId())
    },

    activate(id) {
      // Canlı hesap önce kayda alınır: yenilenmiş token'ı kaybolmaz, tanınmayan oturum ezilmez.
      const current = readIdentity(live)
      if (current) upsert(current)
      const target = load().find((a) => a.id === id)
      if (!target) throw new AccountError('not_found', 'Hesap bulunamadı')
      if (current && accountId(current.oauthAccount) === id) return view(target, id)

      const credentials = readJson(live.credentials) ?? {}
      const config = readJson(live.config) ?? {}
      writeJson(live.credentials, { ...credentials, claudeAiOauth: target.claudeAiOauth })
      try {
        writeJson(live.config, { ...config, oauthAccount: target.oauthAccount })
      } catch (err) {
        // Yarım geçiş bırakılmaz: token eski hesaba döner.
        writeJson(live.credentials, credentials)
        throw err
      }
      return view(target, id)
    },

    remove(id) {
      if (liveId() === id) throw new AccountError('active', 'Etkin hesap kaldırılamaz; önce başka hesaba geçin')
      const accounts = load()
      if (!accounts.some((a) => a.id === id)) throw new AccountError('not_found', 'Hesap bulunamadı')
      save(accounts.filter((a) => a.id !== id))
    },
  }
}
