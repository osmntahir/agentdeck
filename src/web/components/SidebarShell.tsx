import { useEffect, useRef, useState, type ReactNode } from 'react'

/** Native dialog dar ekranda odak tuzağını ve tetikleyene dönüşü sahiplenir. */
export function SidebarShell({ children }: { children: (navigate: (action: () => void) => void) => ReactNode }) {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 700px)').matches)
  const [open, setOpen] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const query = window.matchMedia('(max-width: 700px)')
    const update = () => { setNarrow(query.matches); setOpen(false) }
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (open && narrow) dialog.current?.showModal()
    else dialog.current?.close()
  }, [open, narrow])

  const close = () => dialog.current?.close()
  const navigate = (action: () => void) => {
    if (narrow) close()
    action()
  }

  if (!narrow) return children(navigate)
  return (
    <>
      <div className="mobile-navigation">
        <button ref={trigger} type="button" aria-expanded={open} aria-controls="project-drawer" onClick={() => setOpen(true)}>
          Projeler ve oturumlar
        </button>
      </div>
      <dialog id="project-drawer" className="project-drawer" ref={dialog} aria-label="Projeler ve oturumlar"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const stops = [...event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')]
            .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0)
          const first = stops[0]
          const last = stops[stops.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }}
        onClose={() => {
          setOpen(false)
          trigger.current?.focus()
        }}
        onCancel={(event) => { event.preventDefault(); close() }}>
        <button className="drawer-close" type="button" onClick={close}>Gezinmeyi kapat</button>
        {children(navigate)}
      </dialog>
    </>
  )
}
