import { useState } from 'react'
import type { TreeNode } from '../../shared/diffLayout'
import type { DiffFile } from '../../shared/diffFiles'
import { CHANGE_LETTER } from './DiffFileView'
import { Icon } from './Icon'

export interface TreeRepo {
  path: string
  label: string
  tree: TreeNode[]
  files: { file: DiffFile; id: string }[]
}

/** Değişen dosyaların klasör ağacı; tıklanan dosyaya kayar, görülenler sönük durur. */
export function DiffFileTree({ repos, current, viewed, notes, onOpen }: {
  repos: TreeRepo[]
  current: string | null
  viewed: Set<string>
  notes: Map<string, number>
  onOpen: (fileId: string) => void
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const toggle = (key: string) => setClosed(previous => {
    const next = new Set(previous)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const render = (repo: TreeRepo, nodes: TreeNode[], depth: number) => nodes.map(node => {
    if (node.file !== undefined) {
      const { file, id } = repo.files[node.file]
      return <button key={id} className={`tree-file${current === id ? ' current' : ''}${viewed.has(id) ? ' viewed' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }} title={file.path} onClick={() => onOpen(id)} aria-current={current === id || undefined}>
        <span className={`change-letter ${file.change}`}>{CHANGE_LETTER[file.change]}</span>
        <span className="tree-name">{node.name}</span>
        {(notes.get(id) ?? 0) > 0 && <span className="tree-notes" title="Not sayısı"><Icon name="chat" size={10} />{notes.get(id)}</span>}
        {viewed.has(id) && <Icon name="check" size={12} />}
      </button>
    }
    const key = `${repo.path}\u0000${node.path}`
    const open = !closed.has(key)
    return <div key={key} role="group">
      <button className="tree-dir" style={{ paddingLeft: 10 + depth * 14 }} aria-expanded={open} onClick={() => toggle(key)} title={node.path}>
        <Icon name="chevron" size={11} /><Icon name="folder" size={12} /><span className="tree-name">{node.name}</span>
      </button>
      {open && render(repo, node.children, depth + 1)}
    </div>
  })
  return <nav className="diff-tree" aria-label="Değişen dosyalar">
    {repos.map(repo => <div key={repo.path}>
      {repos.length > 1 && <div className="tree-repo"><Icon name="branch" size={12} />{repo.label}</div>}
      {render(repo, repo.tree, 0)}
    </div>)}
  </nav>
}
