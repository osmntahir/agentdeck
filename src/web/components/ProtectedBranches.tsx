import { useEffect, useState } from 'react'
import * as api from '../api'
import type { Project, SessionView } from '../../shared/types'

/**
 * Projedeki agentdeck/ branch'leri. Uygulama branch silmez, merge veya PR
 * açmaz; kaydı olmayan branch için görev bilgisi uydurulmaz.
 */
export function ProtectedBranches({ project, sessions }: { project: Project; sessions: SessionView[] }) {
  const [data, setData] = useState<api.BranchesResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const load = () => {
    setError(null)
    api
      .getBranches(project.id)
      .then(setData)
      .catch((e) => {
        setData(null)
        setError(e.message)
      })
  }
  useEffect(load, [project.id])

  const copy = (name: string) => {
    navigator.clipboard
      .writeText(name)
      .then(() => setCopied(name))
      .catch(() => setError('Pano erişimi reddedildi; branch adını elle seçip kopyalayın.'))
  }

  const single = data?.repos.length === 1 && data.repos[0].path === '.'

  return (
    <div className="branch-panel">
      <div className="branch-panel-head">
        <strong>Korunan branch'ler</strong>
        <span className="muted">Oturum silinse de branch kalır; uygulama branch silmez, merge veya PR açmaz.</span>
        <button onClick={load}>Yenile</button>
      </div>
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="muted">yükleniyor…</div>}
      {data?.truncated && <div className="muted">Alt klasör taraması sınıra ulaştı; bazı depolar listede yok.</div>}
      {data && data.repos.length === 0 && <div className="muted">Bu klasörde Git deposu bulunamadı.</div>}
      {data?.repos.map((repo) => (
        <section key={repo.path}>
          {!single && <div className="branch-repo">{repo.path}</div>}
          {repo.error ? (
            <div className="error">Branch'ler okunamadı: {repo.error}</div>
          ) : repo.branches.length === 0 ? (
            <div className="muted">agentdeck/ branch'i yok.</div>
          ) : (
            repo.branches.map((branch) => {
              const session = sessions.find((s) => s.id === branch.sessionId)
              return (
                <div className="branch-row" key={branch.name}>
                  <code title={branch.oid}>{branch.name}</code>
                  <code className="muted">{branch.oid.slice(0, 12)}</code>
                  <span className="muted">{session ? `oturum: ${session.name}` : 'kayıtlı oturum yok'}</span>
                  <button onClick={() => copy(branch.name)}>{copied === branch.name ? 'Kopyalandı' : 'Kopyala'}</button>
                </div>
              )
            })
          )}
          {repo.truncated && <div className="muted">1000 ref sınırında kesildi; tamamı için yerel Git kullanın.</div>}
        </section>
      ))}
    </div>
  )
}
