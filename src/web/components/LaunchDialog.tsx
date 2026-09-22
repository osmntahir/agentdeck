import { ProgramIcon } from './AgentMark'
import { useEffect, useRef, useState } from 'react'
import type { SessionView } from '../../shared/types'
import { hasRunningProcesses, PRESETS } from '../../shared/types'

import {
  CLI_COMMANDS,
  explicitResumeCommand,
  repeatLaunchCommand,
  type LaunchCli,
} from '../../shared/launchPolicy'
import { sessionWorkCli } from '../../shared/sessionActions'

const RESUME_COMMANDS = Object.values(CLI_COMMANDS).map(({ label, picker }) => ({ label: `${label} seçicisi`, command: picker }))

interface Props {
  session: SessionView
  busy: boolean
  error: string | null
  onCancel: () => void
  onLaunch: (command: string | null) => void
}

export function LaunchDialog({ session, busy, error, onCancel, onLaunch }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  const initial = repeatLaunchCommand(session) ?? null
  // null etkileşimli kabuk demektir; boş komut çalıştırılamaz.
  const [shell, setShell] = useState(initial === null)
  const [command, setCommand] = useState(initial ?? '')
  const [resumeCli, setResumeCli] = useState<LaunchCli>(sessionWorkCli(session) ?? 'claude')
  const [conversationId, setConversationId] = useState('')
  const resumeCommand = explicitResumeCommand(resumeCli, conversationId)
  const running = hasRunningProcesses(session)
  const ready = shell || command.trim() !== ''

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (busy || !ready) return
    onLaunch(shell ? null : command)
  }

  const fill = (value: string | null) => {
    setShell(value === null)
    if (value !== null) setCommand(value)
  }

  return (
    <dialog
      ref={dialog}
      className="session-modal"
      aria-labelledby="launch-title"
      onCancel={(e) => {
        e.preventDefault()
        onCancel()
      }}
    >
      <form className="dialog" onSubmit={submit}>
        <h2 id="launch-title">Bu çalışma kopyasında komut çalıştır</h2>
        <div className="dialog-sub" title={session.cwd}>
          {session.name} · {session.cwd}
        </div>

        <label>
          Komut
          <input
            autoFocus
            value={shell ? '' : command}
            disabled={shell}
            placeholder={shell ? 'Etkileşimli kabuk' : 'örn. claude --resume'}
            onChange={(e) => setCommand(e.target.value)}
          />
        </label>

        <div className="command-fills" role="group" aria-label="Hazır komutlar">
          {[...PRESETS, ...RESUME_COMMANDS].map((shortcut) => {
            const selected = shortcut.command === null ? shell : !shell && command === shortcut.command
            return (
              <button
                type="button"
                key={shortcut.label}
                aria-pressed={selected}
                className={selected ? 'on' : ''}
                onClick={() => fill(shortcut.command)}
              >
                <ProgramIcon command={shortcut.command} />{shortcut.label}
              </button>
            )
          })}
        </div>

        <fieldset disabled={busy} className="explicit-resume">
          <legend>Konuşma kimliğiyle sürdür</legend>
          <label htmlFor="resume-cli">Program</label>
            <select id="resume-cli" value={resumeCli} onChange={(event) => setResumeCli(event.target.value as LaunchCli)}>
              {Object.entries(CLI_COMMANDS).map(([cli, { label }]) => <option key={cli} value={cli}>{label}</option>)}
            </select>
          <label>
            Konuşma UUID’si
            <input value={conversationId} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              aria-invalid={conversationId.trim() !== '' && !resumeCommand}
              onChange={(event) => setConversationId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                if (!busy && resumeCommand) fill(resumeCommand)
              }} />
          </label>
          <button type="button" disabled={!resumeCommand} onClick={() => resumeCommand && fill(resumeCommand)}>
            Komuta aktar
          </button>
          <p className="dialog-note muted">Elinizdeki tam UUID’yi girin. Komutu yukarıda inceleyip çalıştırın.
            Konuşma bulunamazsa otomatik yeni konuşma açılmaz; erişimi CLI belirler.</p>
        </fieldset>

        <p className="dialog-note muted">
          Komut aynı klasörde yeni Run olarak aynen çalışır; oturumun başlangıç programı değişmez. Seçiciler
          CLI'ın kendi konuşma listesini açar, hangi konuşmanın süreceğini siz seçersiniz. Ajanlar arasında
          konuşma bağlamı aktarılmaz.
        </p>
        {running && <p className="dialog-note">Çalışan süreç grubu önce doğrulanmış biçimde durdurulur.</p>}

        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>
            Vazgeç
          </button>
          <button type="submit" className="primary" disabled={busy || !ready}>
            {busy ? 'Başlatılıyor…' : running ? 'Durdur ve çalıştır' : 'Çalıştır'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
