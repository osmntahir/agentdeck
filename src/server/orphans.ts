import fs from 'node:fs'
import path from 'node:path'

/**
 * Yönetilen kökte hiçbir Session kaydının göstermediği çalışma kopyalarını
 * bulur. Keşif **salt okunurdur**: hiçbir dosya silinmez, sahiplenilmez ve
 * symlink izlenmez. Bütçe aşıldığında liste eksik kalır ve bu açıkça
 * bildirilir — eksik tarama "temiz" anlamına gelmez.
 */
export interface OrphanEntry {
  path: string
  kind: 'directory' | 'symlink-skipped'
  /** Worktree'nin `.git` dosyasındaki gitdir işaretçisi; okunamazsa null. */
  gitLink: string | null
}

export interface OrphanScan {
  entries: OrphanEntry[]
  /** Bütçe aşıldı: liste eksik. */
  truncated: boolean
  /** Okunamayan dizinler; keşif bu kollarda eksik kaldı. */
  unreadable: string[]
  scannedAt: number
}

export interface ScanLimits {
  maxEntries?: number
  deadlineMs?: number
  now?: () => number
}

const GIT_LINK_MAX_BYTES = 4096

/** `.git` dosyasını sınırlı okur; dizin veya okunamaz durumda null döner. */
function readGitLink(dir: string): string | null {
  const file = path.join(dir, '.git')
  let fd: number | null = null
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) return null
    fd = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(Math.min(stat.size, GIT_LINK_MAX_BYTES))
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
    const match = /^gitdir:\s*(.+)$/m.exec(buffer.subarray(0, read).toString('utf8'))
    return match ? match[1].trim() : null
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // kapatma hatası keşfi etkilemez
      }
    }
  }
}

export function scanOrphanWorktrees(
  worktreeRoot: string,
  knownCwds: Set<string>,
  limits: ScanLimits = {},
): OrphanScan {
  const maxEntries = limits.maxEntries ?? 10_000
  const deadlineMs = limits.deadlineMs ?? 5000
  const now = limits.now ?? Date.now
  const startedAt = now()

  const entries: OrphanEntry[] = []
  const unreadable: string[] = []
  let examined = 0
  let truncated = false

  const overBudget = (): boolean => examined >= maxEntries || now() - startedAt >= deadlineMs

  let projects: fs.Dirent[]
  try {
    projects = fs.readdirSync(worktreeRoot, { withFileTypes: true })
  } catch (err) {
    // Kök yoksa yönetilen alan boştur; okunamıyorsa keşif eksiktir.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries, truncated: false, unreadable, scannedAt: startedAt }
    }
    return { entries, truncated: true, unreadable: [worktreeRoot], scannedAt: startedAt }
  }

  for (const projectEntry of projects) {
    examined += 1
    if (overBudget()) {
      truncated = true
      break
    }
    // Symlink izlenmez: yönetilen kökün dışına çıkmayız.
    if (projectEntry.isSymbolicLink()) {
      const linkPath = path.join(worktreeRoot, projectEntry.name)
      if (!knownCwds.has(linkPath)) entries.push({ path: linkPath, kind: 'symlink-skipped', gitLink: null })
      continue
    }
    if (!projectEntry.isDirectory()) continue

    const projectDir = path.join(worktreeRoot, projectEntry.name)
    let children: fs.Dirent[]
    try {
      children = fs.readdirSync(projectDir, { withFileTypes: true })
    } catch {
      unreadable.push(projectDir)
      continue
    }

    for (const child of children) {
      examined += 1
      if (overBudget()) {
        truncated = true
        break
      }
      const childPath = path.join(projectDir, child.name)
      if (knownCwds.has(childPath)) continue

      if (child.isSymbolicLink()) {
        entries.push({ path: childPath, kind: 'symlink-skipped', gitLink: null })
        continue
      }
      if (!child.isDirectory()) continue
      entries.push({ path: childPath, kind: 'directory', gitLink: readGitLink(childPath) })
    }
    if (truncated) break
  }

  return { entries, truncated, unreadable, scannedAt: startedAt }
}
