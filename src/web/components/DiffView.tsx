import { useEffect, useRef, useState } from 'react'
import * as api from '../api'
import type { DiffResult, DiffScope, Isolation } from '../../shared/types'

const SCOPES: [DiffScope, string][] = [
  ['work', 'Bu çalışma'],
  ['uncommitted', 'Commit edilmemiş'],
]

export function DiffView({ sessionId, isolation }: { sessionId: string; isolation: Isolation }) {
  // Worktree'de varsayılan toplam görünümdür; ortak kopya commit edilmemiş farkla açılır.
  const [scope, setScope] = useState<DiffScope>(isolation === 'worktree' ? 'work' : 'uncommitted')
  const [data, setData] = useState<DiffResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // Geç gelen eski cevap yeni isteğin sonucunu ezmez.
  const generation = useRef(0)

  const load = () => {
    const current = ++generation.current
    setLoading(true)
    setError(null)
    api
      .getDiff(sessionId, scope)
      .then((next) => {
        if (current === generation.current) setData(next)
      })
      .catch((e) => {
        if (current !== generation.current) return
        setData(null)
        setError(e.message)
      })
      .finally(() => {
        if (current === generation.current) setLoading(false)
      })
  }

  useEffect(load, [sessionId, scope])

  // Git projesinde tek depo vardır ve eski görünüm korunur.
  const single = data?.repos.length === 1 && data.repos[0].path === '.'
  const changed = data?.repos.filter((repo) => repo.status !== '').length ?? 0

  return (
    <div className="diff-view">
      <div className="diff-bar">
        <div className="tabs" role="group" aria-label="Diff kapsamı">
          {SCOPES.map(([value, label]) => (
            <button
              key={value}
              className={scope === value ? 'on' : ''}
              aria-pressed={scope === value}
              onClick={() => setScope(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {data &&
          (single ? (
            <span className="branch">{data.repos[0].branch}</span>
          ) : (
            <span className="muted">
              {data.repos.length} depo · {changed} değişiklikli
            </span>
          ))}
        {data && <span className="muted">okundu {new Date(data.capturedAt).toLocaleTimeString()}</span>}
        <button onClick={load} disabled={loading}>
          {loading ? 'yükleniyor…' : 'yenile'}
        </button>
      </div>
      {isolation === 'shared' && (
        <div className="pad muted">
          Ortak çalışma kopyasındaki değişiklikler bu oturuma atfedilmez; başka süreçler de yazmış olabilir.
        </div>
      )}
      {error && <div className="pad muted">{error}</div>}
      {!data && !error && <div className="pad muted">yükleniyor…</div>}
      {data?.truncated && (
        <div className="pad muted">Alt klasör taraması sınıra ulaştı; bazı depolar listede yok.</div>
      )}
      {data?.repos.map((repo) => (
        <section key={repo.path} className="diff-repo">
          {!single && (
            <header className="diff-repo-head">
              <strong>{repo.path}</strong>
              <span className="branch">{repo.branch}</span>
            </header>
          )}
          {data.scope === 'work' && repo.baseCommit && (
            <div className="pad muted">Başlangıç commit'i: {repo.baseCommit.slice(0, 12)}</div>
          )}
          {repo.error ? (
            <div className="error">{repo.error}</div>
          ) : (
            <>
              {repo.stale && <div className="error">Okuma sırasında HEAD değişti; sonuç eski olabilir. Yenileyin.</div>}
              {repo.status && <pre className="diff-status">{repo.status}</pre>}
              {repo.statusTruncated && (
                <div className="pad muted">Durum listesi sınırda kesildi (10.000 giriş / 1 MiB).</div>
              )}
              {repo.diff ? (
                <pre className="diff-body">
                  {repo.diff.split('\n').map((line, i) => (
                    <div key={i} className={lineClass(line)}>
                      {line || ' '}
                    </div>
                  ))}
                </pre>
              ) : (
                <div className="pad muted">
                  {repo.status
                    ? 'Net patch boş; index ve çalışma ağacı değişiklikleri durum listesinde.'
                    : 'Değişiklik yok.'}
                </div>
              )}
              {repo.patchTruncated && (
                <div className="pad muted">
                  Patch sınırda kesildi (1 MiB veya 50 yeni dosya); tamamı için yerel Git araçlarını kullanın.
                </div>
              )}
            </>
          )}
        </section>
      ))}
    </div>
  )
}

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'dl meta'
  if (line.startsWith('@@')) return 'dl hunk'
  if (line.startsWith('+')) return 'dl add'
  if (line.startsWith('-')) return 'dl del'
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'dl meta'
  return 'dl'
}
