import { useEffect, useRef, useState } from 'react'
import type { GitWorkspaces, SessionView } from '../../shared/types'
import * as api from '../api'
import { Icon } from './Icon'

export function BranchPicker({ session, healthy }: { session: SessionView; healthy: boolean }) {
  const [data, setData] = useState<GitWorkspaces | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [repoPath, setRepoPath] = useState('.')
  const [target, setTarget] = useState('')
  const [create, setCreate] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const popover = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (open) popover.current?.showModal() }, [open])
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    let cancelled = false; let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try { if (healthy && document.visibilityState !== 'hidden') {
        const next = await api.getGitWorkspaces(session.id, open)
        if (!cancelled) { setData(next); setError(null) }
      } } catch (e) { if (!cancelled) { setData(null); setError((e as Error).message) } }
      finally { if (!cancelled) timer = setTimeout(load, 5000) }
    }
    void load()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [session.id, session.runId, healthy, open, revision])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus()
    }
    document.addEventListener('keydown', escape)
    window.addEventListener('pointerdown', outside)
    return () => { document.removeEventListener('keydown', escape); window.removeEventListener('pointerdown', outside) }
  }, [open])
  const repo = data?.repos.find(item => item.path === repoPath) ?? data?.repos[0]
  return <div className="branch-control" ref={root} onKeyDown={e => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); trigger.current?.focus() } }}>
    <button ref={trigger} className="branch-trigger" title="Git branch ve çalışma alanı" aria-label="Branch yönetimi" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="branch" /><span>{repo ? repo.branch ?? `HEAD ${repo.head?.slice(0, 7) ?? 'yok'}` : error ? 'Git okunamadı' : data ? 'Git yok' : 'Git…'}</span>{repo?.dirty && <span className="dirty-dot" title="Kaydedilmemiş değişiklikler">●</span>}</button>
    {open && <dialog ref={popover} className="branch-popover" aria-label="Git çalışma alanı" onCancel={e => { e.preventDefault(); setOpen(false); trigger.current?.focus() }}>
      <header><strong>Git çalışma alanı</strong><span className="branch-popover-actions"><button title="Git durumunu yenile" aria-label="Git durumunu yenile" onClick={() => setRevision(n => n + 1)}><Icon name="refresh" /></button><button aria-label="Branch yönetimini kapat" onClick={() => setOpen(false)}>×</button></span></header>
      <code className="workspace-path branch-popover-path" title={session.cwd}>{session.cwd}</code>
      {data && data.repos.length > 1 && <label>Depo<select value={repo?.path} onChange={e => { setRepoPath(e.target.value); setTarget('') }}>{data.repos.map(item => <option key={item.path}>{item.path}</option>)}</select></label>}
      {repo && <><p className="review-note">{repo.dirty ? 'Değişiklikler var · önce commit veya stash yapın.' : 'Çalışma ağacı temiz.'} {session.isolation === 'shared' && 'Branch değişikliği bu klasördeki tüm terminalleri etkiler.'}</p>
        <label className="radio"><input type="checkbox" checked={create} onChange={e => { setCreate(e.target.checked); setTarget('') }} />Yeni branch oluştur</label>
        <label>{create ? 'Yeni branch adı' : 'Branch seç'}{create ? <input aria-label="Yeni branch adı" value={target} onChange={e => setTarget(e.target.value)} placeholder="feature/iş-adı" /> : <select aria-label="Branch seç" value={target} onChange={e => setTarget(e.target.value)}><option value="">Branch seç…</option>{repo.branches.map(branch => <option key={branch} value={branch}>{branch}{branch === repo.branch ? ' (şu an)' : ''}</option>)}</select>}</label>
        <button className="primary" disabled={!healthy || busy || repo.dirty || !target || target === repo.branch} onClick={async () => {
          setBusy(true); setError(null)
          try { await api.switchBranch(session.id, { repo: repo.path, branch: target, create, expectedHead: repo.head, expectedBranch: repo.branch, expectedRunId: session.runId }); setTarget(''); setRevision(n => n + 1) }
          catch (e) { setError((e as Error).message) }
          finally { setBusy(false) }
        }}>{busy ? 'Değiştiriliyor…' : create ? 'Oluştur ve geç' : 'Branch’e geç'}</button>
        {repo.truncated && <p className="error">İlk 1000 branch gösteriliyor.</p>}
      </>}
      {data?.truncated && <p className="error">Depo listesi eksik.</p>}
      {data?.repos.length === 0 && <p className="muted">Bu çalışma alanında Git deposu yok.</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </dialog>}
  </div>
}
