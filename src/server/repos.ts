import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'

/**
 * Klasör projesinin altındaki Git depolarını bulur. Keşif salt okunurdur,
 * symlink izlenmez ve bulunan deponun içine inilmez. Bütçe aşıldığında veya
 * bir dizin okunamadığında liste eksik kalır ve bu açıkça bildirilir. Okuma
 * async'tir; tarama daemon'ın PTY ve WS işlerini bloklamaz.
 */
export interface SubRepoScan {
  /** Köke göre göreli yollar; kök depoysa tek değer "." olur. */
  repos: string[]
  truncated: boolean
}

export interface SubRepoLimits {
  maxRepos?: number
  maxEntries?: number
}

const MAX_DEPTH = 4
const DEADLINE_MS = 2000

/** Depo barındırması beklenmeyen, taramayı şişiren klasörler. */
const SKIPPED = new Set(['node_modules'])

async function hasGitEntry(dir: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

export async function findSubRepos(root: string, limits: SubRepoLimits = {}): Promise<SubRepoScan> {
  const maxRepos = limits.maxRepos ?? 30
  const maxEntries = limits.maxEntries ?? 20_000
  const deadline = Date.now() + DEADLINE_MS

  const repos: string[] = []
  let examined = 0
  let truncated = false

  const walk = async (rel: string, depth: number): Promise<void> => {
    const dir = path.join(root, rel)
    if (await hasGitEntry(dir)) {
      if (repos.length >= maxRepos) truncated = true
      else repos.push(rel === '' ? '.' : rel)
      return
    }
    if (depth === MAX_DEPTH) return

    let children: Dirent[]
    try {
      children = await fs.readdir(dir, { withFileTypes: true })
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
      await walk(rel === '' ? child.name : `${rel}/${child.name}`, depth + 1)
    }
  }

  await walk('', 0)
  return { repos: repos.sort(), truncated }
}
