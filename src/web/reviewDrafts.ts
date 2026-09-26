import { useCallback, useState } from 'react'
import type { ReviewComment } from '../shared/review'

/**
 * Oturumun inceleme taslağı: notlar, görüldü işaretleri ve genel not. Yalnız
 * bu tarayıcı/uygulama profilinde tutulur; daemon'a yazılmaz. Okunamayan kayıt
 * boş taslakla açılır, uygulamayı durdurmaz.
 */
export interface ReviewDraft {
  comments: ReviewComment[]
  /** `kaynak|depo|yol` → dosya farkının özeti; fark değişince işaret düşer. */
  viewed: Record<string, string>
  summary: string
}

const EMPTY: ReviewDraft = { comments: [], viewed: {}, summary: '' }
const key = (sessionId: string) => `agentdeck.review.v1.${sessionId}`
const MAX_COMMENTS = 500

function isComment(value: unknown): value is ReviewComment {
  const c = value as ReviewComment
  return typeof c === 'object' && c !== null && typeof c.id === 'string' && typeof c.source === 'string' && typeof c.repo === 'string' &&
    (c.path === null || typeof c.path === 'string') && (c.side === 'new' || c.side === 'old') &&
    (c.line === null || typeof c.line === 'number') && (c.startLine === null || typeof c.startLine === 'number') &&
    Array.isArray(c.snippet) && c.snippet.every(s => typeof s === 'string') && typeof c.body === 'string' &&
    typeof c.createdAt === 'number' && (c.sentAt === null || typeof c.sentAt === 'number')
}

function load(sessionId: string): ReviewDraft {
  try {
    const raw = JSON.parse(localStorage.getItem(key(sessionId)) ?? 'null')
    if (!raw || typeof raw !== 'object') return EMPTY
    const viewed: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw.viewed ?? {})) if (typeof v === 'string') viewed[k] = v
    return {
      comments: Array.isArray(raw.comments) ? raw.comments.filter(isComment).slice(-MAX_COMMENTS) : [],
      viewed,
      summary: typeof raw.summary === 'string' ? raw.summary : '',
    }
  } catch {
    return EMPTY
  }
}

export function useReviewDraft(sessionId: string): [ReviewDraft, (change: (draft: ReviewDraft) => ReviewDraft) => void] {
  const [draft, setDraft] = useState(() => load(sessionId))
  const update = useCallback((change: (draft: ReviewDraft) => ReviewDraft) => {
    setDraft(previous => {
      const next = change(previous)
      try {
        if (next.comments.length === 0 && next.summary === '' && Object.keys(next.viewed).length === 0) localStorage.removeItem(key(sessionId))
        else localStorage.setItem(key(sessionId), JSON.stringify(next))
      } catch { /* taslak bu açılışla sınırlı kalır */ }
      return next
    })
  }, [sessionId])
  return [draft, update]
}

/** İnceleme ekranının görünüm tercihleri; bütün oturumlarda ortak. */
export interface ReviewPrefs {
  layout: 'unified' | 'split'
  wrap: boolean
  tree: boolean
  panel: boolean
  /** Not kaydedilir kaydedilmez ajana gider. */
  instant: boolean
  /** Gönderimde Enter'a da basılır; kapalıysa metin istemde bekler. */
  submit: boolean
}

const PREFS_KEY = 'agentdeck.review.prefs.v1'
const PREFS_DEFAULT: ReviewPrefs = { layout: 'unified', wrap: false, tree: true, panel: true, instant: false, submit: true }

function loadPrefs(): ReviewPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
    const prefs = { ...PREFS_DEFAULT }
    if (raw.layout === 'split' || raw.layout === 'unified') prefs.layout = raw.layout
    for (const k of ['wrap', 'tree', 'panel', 'instant', 'submit'] as const) if (typeof raw[k] === 'boolean') prefs[k] = raw[k]
    return prefs
  } catch {
    return PREFS_DEFAULT
  }
}

export function useReviewPrefs(): [ReviewPrefs, (change: Partial<ReviewPrefs>) => void] {
  const [prefs, setPrefs] = useState(loadPrefs)
  const update = useCallback((change: Partial<ReviewPrefs>) => {
    setPrefs(previous => {
      const next = { ...previous, ...change }
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)) } catch { /* bu açılışla sınırlı */ }
      return next
    })
  }, [])
  return [prefs, update]
}

/** Dosya farkının kısa özeti; görüldü işaretinin geçerliliğini denetler. */
export function diffDigest(lines: { text: string }[]): string {
  let hash = 2166136261
  for (const line of lines) {
    for (let i = 0; i < line.text.length; i++) hash = Math.imul(hash ^ line.text.charCodeAt(i), 16777619)
    hash = Math.imul(hash ^ 10, 16777619)
  }
  return `${lines.length}:${(hash >>> 0).toString(36)}`
}
