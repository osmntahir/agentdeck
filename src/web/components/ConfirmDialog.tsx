import { useEffect, useRef, type ReactNode } from 'react'

/**
 * Geri alınamayan işlerin ortak onayı. Odak "Vazgeç"te başlar; Escape ve
 * arka plan yalnız vazgeçer, onay her zaman açık bir tıklamadır.
 */
export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel }: {
  title: string
  children: ReactNode
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
    cancel.current?.focus()
  }, [])
  return (
    <dialog ref={dialog} className="session-modal" role="alertdialog" aria-labelledby="confirm-title"
      onCancel={(event) => { event.preventDefault(); onCancel() }}>
      <div className="dialog confirm-dialog">
        <h2 id="confirm-title">{title}</h2>
        {children}
        <div className="dialog-actions">
          <button ref={cancel} type="button" onClick={onCancel}>Vazgeç</button>
          <button type="button" className="danger-action" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </dialog>
  )
}
