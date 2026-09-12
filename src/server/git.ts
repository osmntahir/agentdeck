import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pexec = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

/** Verilen yolun git deposu kökünü döner, depo değilse null. */
export async function repoRoot(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return null
  }
}

export async function currentBranch(cwd: string): Promise<string> {
  try {
    return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  } catch {
    return '(bilinmiyor)'
  }
}

export async function addWorktree(repo: string, worktreePath: string, branch: string): Promise<void> {
  await git(repo, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'])
}

export async function removeWorktree(repo: string, worktreePath: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', worktreePath])
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await git(repo, ['branch', '-D', branch])
}

/** Kaç yeni dosyayı diff'leyeceğimizin üst sınırı. */
const MAX_UNTRACKED = 50

/** `git diff --no-index` fark bulunca 1 ile çıkar; stdout yine geçerlidir. */
async function gitTolerant(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args)
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? ''
  }
}

export async function diff(cwd: string): Promise<{ diff: string; status: string }> {
  const [tracked, status, untracked] = await Promise.all([
    git(cwd, ['--no-pager', 'diff', 'HEAD']).catch(() => ''),
    git(cwd, ['status', '--short']).catch(() => ''),
    git(cwd, ['ls-files', '--others', '--exclude-standard']).catch(() => ''),
  ])

  // `git diff HEAD` takip edilmeyen dosyaların içeriğini göstermez. Ajanın en
  // sık yaptığı şey yeni dosya yazmak olduğundan onları ayrıca diff'liyoruz.
  const fresh = untracked.split('\n').filter(Boolean).slice(0, MAX_UNTRACKED)
  const extra = await Promise.all(
    fresh.map((file) => gitTolerant(cwd, ['--no-pager', 'diff', '--no-index', '--', '/dev/null', file])),
  )

  return { diff: tracked + extra.join(''), status }
}
