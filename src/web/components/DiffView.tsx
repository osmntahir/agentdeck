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

  const lines = data.diff.split('\n')

  return (
    <div className="diff-view">
      <div className="diff-bar">
        <span className="branch">{data.branch}</span>
        <button onClick={load}>yenile</button>
      </div>
      {data.status && <pre className="diff-status">{data.status}</pre>}
      {data.diff ? (
        <pre className="diff-body">
          {lines.map((line, i) => (
            <div key={i} className={lineClass(line)}>
              {line || ' '}
            </div>
          ))}
        </pre>
      ) : (
        <div className="pad muted">Değişiklik yok.</div>
      )}
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
