import { useEffect, useRef, useState } from 'react'
import { updatePreferences, usePreferences } from '../preferences'

export function ColorDialog({ id, projectId, name, onClose }: { id: string; projectId?: string; name: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const preferences = usePreferences()
  const key = projectId ? 'terminalColors' : 'colors'
  const inherited = projectId ? preferences.colors[projectId] ?? '#9aaad4' : '#9aaad4'
  const [color, setColor] = useState(preferences[key][id] ?? inherited)
  const [error, setError] = useState('')
  useEffect(() => { dialog.current?.showModal() }, [])
  const save = (reset: boolean) => {
    const next = { ...preferences[key] }
    if (reset) delete next[id]
    else next[id] = color
    try { updatePreferences({ [key]: next }); onClose() }
    catch { setError('Renk kaydedilemedi; depolama erişimini kontrol edin.') }
  }
  return <dialog ref={dialog} className="session-modal" aria-labelledby="color-title" onCancel={e => { e.preventDefault(); onClose() }}>
    <form className="dialog" onSubmit={e => { e.preventDefault(); save(false) }}>
      <h2 id="color-title">{name} · renk</h2>
      <label>Vurgu rengi<input type="color" value={color} onChange={e => setColor(e.target.value)} /></label>
      <p className="muted">{projectId ? 'Özel renk seçilmezse proje rengi kullanılır.' : 'Özel rengi olmayan tüm proje terminallerine uygulanır.'}</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" onClick={() => save(true)}>{projectId ? 'Proje rengini kullan' : 'Varsayılana dön'}</button><button type="button" onClick={onClose}>Vazgeç</button><button className="primary">Kaydet</button></div>
    </form>
  </dialog>
}
