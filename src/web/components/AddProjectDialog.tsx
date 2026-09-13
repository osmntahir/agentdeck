import { useEffect, useRef, useState } from 'react'

interface Props {
  onAdd: (path: string) => Promise<void>
  onCancel: () => void
}

export function AddProjectDialog({ onAdd, onCancel }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locked = busy || choosing

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  const chooseFolder = async () => {
    if (!window.agentdeckDesktop || locked) return
    setChoosing(true)
    setError(null)
    try {
      const selected = await window.agentdeckDesktop.selectProjectFolder()
      if (selected !== null) setPath(selected)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setChoosing(false)
    }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!path.trim() || locked) return
    setBusy(true)
    setError(null)
    try {
      await onAdd(path.trim())
      onCancel()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      className="session-modal"
      aria-labelledby="add-project-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!locked) onCancel()
      }}
    >
      <form className="dialog" onSubmit={submit}>
        <h2 id="add-project-title">Proje ekle</h2>
        <p className="dialog-note muted">
          Bir Git deposu veya yerel klasör ekleyin. Dosyalarınız mevcut konumunda kalır.
        </p>
        {window.agentdeckDesktop ? (
          <button className="folder-chooser" type="button" disabled={locked} onClick={chooseFolder}>
            {choosing ? 'Klasör seçiliyor…' : 'Klasör seç…'}
          </button>
        ) : (
          <p className="dialog-note muted">
            Tarayıcıda klasörün tam yolunu girin. Sistem klasör seçicisi masaüstü uygulamasında
            kullanılabilir.
          </p>
        )}
        <label>
          Klasör yolu
          <input
            autoFocus={!window.agentdeckDesktop}
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="~/Desktop/kiosk"
            spellCheck={false}
            disabled={locked}
            required
          />
        </label>
        <p className="dialog-note muted">
          Git projelerinde izole worktree açabilirsiniz. Diğer klasörlerde ajanlar ve terminal doğrudan aynı
          klasörde çalışır.
        </p>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" disabled={locked} onClick={onCancel}>
            Vazgeç
          </button>
          <button className="primary" type="submit" disabled={locked || !path.trim()}>
            {busy ? 'Ekleniyor…' : 'Projeyi ekle'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
