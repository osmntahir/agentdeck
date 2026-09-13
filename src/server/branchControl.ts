import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitWorkspace } from '../shared/types'
const exec = promisify(execFile)
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    return (await exec('git', args, { cwd, timeout: 5000, maxBuffer: 1024 * 1024 })).stdout.trimEnd()
  } catch (error) {
    const e = error as { stderr?: string; message: string }
    throw new Error(e.stderr?.trim() || e.message)
  }
}
export async function readGitWorkspace(cwd: string, includeBranches: boolean): Promise<GitWorkspace> {
  // symbolic-ref also works before the first commit; detached HEAD is explicit.
  const branch = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null)
  const head = await git(cwd, ['rev-parse', '--verify', 'HEAD']).catch(() => null)
  const status = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
  const refs = includeBranches ? await git(cwd, ['for-each-ref', '--count=1001', '--format=%(refname:short)', 'refs/heads/']) : ''
  const branches = refs ? refs.split('\n') : []
  return { path: '.', branch, head, dirty: status.length > 0, branches: branches.slice(0, 1000), truncated: branches.length > 1000 }
}
export async function switchWorkspaceBranch(cwd: string, input: { branch: string; create: boolean; expectedHead: string | null; expectedBranch: string | null }): Promise<GitWorkspace> {
  if (!input.branch || input.branch.startsWith('-') || input.branch !== input.branch.trim() || /[\x00-\x20\x7f]/.test(input.branch)) throw new Error('Geçersiz branch adı')
  await git(cwd, ['check-ref-format', '--branch', input.branch])
  const before = await readGitWorkspace(cwd, false)
  if (before.head !== input.expectedHead || before.branch !== input.expectedBranch) throw new Error('Branch değişti; listeyi yenileyip tekrar deneyin')
  if (before.dirty) throw new Error('Kaydedilmemiş değişiklikler var. Önce commit veya stash yapın; dosyalar değiştirilmedi.')
  // No force, discard, reset or implicit remote tracking. Git also rejects another worktree's branch.
  await git(cwd, input.create ? ['switch', '--no-guess', '-c', input.branch] : ['switch', '--no-guess', input.branch])
  return readGitWorkspace(cwd, true)
}
