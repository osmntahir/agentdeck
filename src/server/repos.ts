import fs from 'node:fs'
import path from 'node:path'

/**
 * Klasör projesinin altındaki Git depolarını bulur. Keşif salt okunurdur,
 * symlink izlenmez ve bulunan deponun içine inilmez. Bütçe aşıldığında veya
 * bir dizin okunamadığında liste eksik kalır ve bu açıkça bildirilir.
 */
export interface NestedRepoScan {
  /** Köke göre göreli yollar; kök depoysa tek değer "." olur. */
  repos: string[]
  truncated: boolean
}

export interface NestedRepoLimits {
  maxDepth?: number
  maxRepos?: number
  maxEntries?: number
  deadlineMs?: number
}

/** Depo barındırması beklenmeyen, taramayı şişiren klasörler. */
const SKIPPED = new Set(['node_modules'])

function hasGitEntry(dir: string): boolean {
  try {
    fs.lstatSync(path.join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

export function findNestedRepos(root: string, limits: NestedRepoLimits = {}): NestedRepoScan {
  const maxDepth = limits.maxDepth ?? 4
  const maxRepos = limits.maxRepos ?? 30
  const maxEntries = limits.maxEntries ?? 20_000
  const deadline = Date.now() + (limits.deadlineMs ?? 2000)

  const repos: string[] = []
  let examined = 0
  let truncated = false

  const walk = (rel: string, depth: number): void => {
    const dir = path.join(root, rel)
    if (hasGitEntry(dir)) {
      if (repos.length >= maxRepos) truncated = true
      else repos.push(rel === '' ? '.' : rel)
      return
    }
    if (depth === maxDepth) return

    let children: fs.Dirent[]
    try {
      children = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      truncated = true
      return
    }
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const child of children) {
      if (truncated) return
      examined += 1
      if (examined > maxEntries || Date.now() > deadline) {
        truncated = true
        return
      }
      // Dirent lstat anlamındadır: symlink dizin sayılmaz, izlenmez.
      if (!child.isDirectory() || child.name.startsWith('.') || SKIPPED.has(child.name)) continue
      walk(rel === '' ? child.name : `${rel}/${child.name}`, depth + 1)
    }
  }

  walk('', 0)
  return { repos: repos.sort(), truncated }
}
