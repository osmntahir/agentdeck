import { useEffect, useMemo, useState } from 'react'
import * as api from '../api'
import type { DiffResult, DiffScope, Isolation } from '../../shared/types'
import { diffFiles } from '../../shared/diffFiles'
import { Icon } from './Icon'

const CHANGE_LABELS = { added: 'yeni', deleted: 'silindi', renamed: 'taşındı' } as const

export function DiffView({ sessionId, isolation }: { sessionId: string; isolation: Isolation }) {
  const [scope, setScope] = useState<DiffScope>(isolation === 'worktree' ? 'work' : 'uncommitted')
  const [data, setData] = useState<DiffResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [query, setQuery] = useState('')
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [wrap, setWrap] = useState(false)
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null); setData(null)
    api.getDiff(sessionId, scope).then(next => { if (!cancelled) setData(next) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [sessionId, scope, reload])
  const repos = useMemo(() => data?.repos.map(repo => ({ ...repo, files: diffFiles(repo.diff) })) ?? [], [data])
  const ids = repos.flatMap(repo => repo.files.map((file, index) => `${repo.path}:${index}:${file.path}`))
  const toggle = (id: string) => setClosed(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  return <div className={`diff-view file-review${wrap ? ' wrap-lines' : ''}`}>
    <div className="diff-bar">
      <div className="tabs" aria-label="Diff kapsamı" role="group">
        {isolation === 'worktree' && <button className={scope === 'work' ? 'on' : ''} onClick={() => setScope('work')}>Bu çalışma</button>}
        <button className={scope === 'uncommitted' ? 'on' : ''} onClick={() => setScope('uncommitted')}>Commit edilmemiş</button>
      </div>
      <span className="muted">{ids.length} dosya</span>
      <button title="Değişiklikleri yenile" aria-label="Değişiklikleri yenile" onClick={() => setReload(n => n + 1)} disabled={loading}><Icon name="refresh" /></button>
      <input aria-label="Değişen dosya ara" placeholder="Dosya filtrele…" value={query} onChange={e => setQuery(e.target.value)} />
      <button onClick={() => setClosed(new Set())}>Tümünü aç</button>
      <button onClick={() => setClosed(new Set(ids))}>Tümünü kapat</button>
      <button aria-pressed={wrap} onClick={() => setWrap(!wrap)}>Satırları sar</button>
    </div>
    <div className="review-scroll">
      {isolation === 'shared' && <p className="review-note">Proje klasöründeki ortak değişiklikler. Aynı klasördeki diğer terminaller de bu dosyaları kullanır.</p>}
      {loading && <p className="pad muted" role="status">Değişiklikler okunuyor…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {data?.truncated && <p className="error">Depo taraması eksik; tüm depolar gösterilemiyor.</p>}
      {repos.map(repo => <section key={repo.path} className="diff-repo">
        <header className="diff-repo-head"><Icon name="branch" /><strong>{repo.branch}</strong>{repo.path !== '.' && <span>{repo.path}</span>}{repo.baseCommit && scope === 'work' && <code title="Başlangıç commit'i">{repo.baseCommit.slice(0, 8)}</code>}</header>
        {repo.error && <p className="error">{repo.error}</p>}
        {repo.stale && <p className="error">Okuma sırasında HEAD değişti; yenileyin.</p>}
        {repo.status && <details className="git-status-details"><summary>Index ve çalışma ağacı durumu</summary><pre>{repo.status}</pre></details>}
        {repo.files.map((file, index) => {
          const id = `${repo.path}:${index}:${file.path}`
          if (!file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())) return null
          return <section className="diff-file" key={id}>
            <button className="diff-file-heading" aria-expanded={!closed.has(id)} onClick={() => toggle(id)}>
              <span aria-hidden="true">{closed.has(id) ? '▸' : '▾'}</span><span className="diff-file-path">{file.path}</span>
              {file.change !== 'modified' && <span className={`badge diff-change ${file.change}`}>{CHANGE_LABELS[file.change]}</span>}
              {file.binary ? <span className="muted">İkili dosya</span> : <span className="diff-stats"><b>+{file.added}</b><i>−{file.removed}</i></span>}
            </button>
            {/* Git başlık satırları başlıktaki rozet ve sayılarla özetlenir; "\ No newline" korunur. */}
            {!closed.has(id) && <div className="diff-code" role="region" aria-label={`${file.path} farkı`} tabIndex={0}>{file.lines.filter(line => line.kind !== 'meta' || line.text.startsWith('\\')).map((line, i) => <div className={`diff-line ${line.kind}`} key={i}><span className="line-number" aria-hidden="true">{line.old}</span><span className="line-number" aria-hidden="true">{line.next}</span><code>{line.text}</code></div>)}</div>}
          </section>
        })}
        {!repo.error && !repo.diff && <p className="pad muted">{repo.status ? 'Net fark boş. Index ve çalışma ağacı durumunu yukarıdan inceleyebilirsiniz.' : 'Değişiklik yok.'}</p>}
        {(repo.patchTruncated || repo.statusTruncated) && <p className="error">Sonuç boyut sınırında kesildi; tüm değişiklikler gösterilemiyor. Tamamını yerel Git ile inceleyin.</p>}
      </section>)}
      {ids.length > 0 && !repos.some(repo => repo.files.some(file => file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) && <p className="pad muted">Bu filtreyle eşleşen dosya yok.</p>}
    </div>
  </div>
}
