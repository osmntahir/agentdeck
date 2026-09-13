import { useEffect, useState } from 'react'
import * as api from '../api'
import type { DiffResult } from '../../shared/types'

export function DiffView({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<DiffResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    api.getDiff(sessionId).then(setData).catch((e) => setError(e.message))
  }

  useEffect(load, [sessionId])

  if (error) return <div className="pad muted">{error}</div>
  if (!data) return <div className="pad muted">yükleniyor…</div>

  // Git projesinde tek depo vardır ve eski görünüm korunur.
  const single = data.repos.length === 1 && data.repos[0].path === '.'
  const changed = data.repos.filter((repo) => repo.status !== '').length

  return (
    <div className="diff-view">
      <div className="diff-bar">
        {single ? (
          <span className="branch">{data.repos[0].branch}</span>
        ) : (
          <span className="muted">
            {data.repos.length} depo · {changed} değişiklikli
          </span>
        )}
        <button onClick={load}>yenile</button>
      </div>
      {data.truncated && (
        <div className="pad muted">Alt klasör taraması sınıra ulaştı; bazı depolar listede yok.</div>
      )}
      {data.repos.map((repo) => (
        <section key={repo.path} className="diff-repo">
          {!single && (
            <header className="diff-repo-head">
              <strong>{repo.path}</strong>
              <span className="branch">{repo.branch}</span>
            </header>
          )}
          {repo.status && <pre className="diff-status">{repo.status}</pre>}
          {repo.diff ? (
            <pre className="diff-body">
              {repo.diff.split('\n').map((line, i) => (
                <div key={i} className={lineClass(line)}>
                  {line || ' '}
                </div>
              ))}
            </pre>
          ) : (
            <div className="pad muted">Değişiklik yok.</div>
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
