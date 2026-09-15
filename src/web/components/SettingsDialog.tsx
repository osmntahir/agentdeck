import { enableDesktopNotifications, showDesktopNotification } from '../notifications'
import { useEffect, useRef, useState } from 'react'
import { usePreferences, updatePreferences, THEMES, type ThemeName } from '../preferences'
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const preferences = usePreferences()
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  return <dialog ref={ref} className="session-modal settings-modal" aria-labelledby="settings-title" onCancel={e => { e.preventDefault(); onClose() }}><div className="dialog">
    <h2 id="settings-title">Ayarlar</h2><p className="muted">Bu tarayıcı / uygulama profiline kaydedilir.</p>
    <label className="setting-row"><span><strong>Tema</strong><small>Arayüz ve terminal renkleri birlikte değişir.</small></span><select aria-label="Tema" value={preferences.theme} onChange={e => {
      try { updatePreferences({ theme: e.target.value as ThemeName }); setError(null) }
      catch { setError('Tema kaydedilemedi.') }
    }}>{Object.entries(THEMES).map(([id, theme]) => <option key={id} value={id}>{theme.label}</option>)}</select></label>
    {([
      ['notifications', 'Bildirimler', 'İş bittiğinde, hata oluştuğunda veya terminal yanıt/onay beklediğinde uygulama popup’ı ve Linux masaüstü bildirimi göster.'],
      ['previews', 'Oturum önizlemeleri', 'Oturum kartlarında terminal çıktısını göster.'],
      ['compact', 'Kompakt görünüm', 'Kartları ve gezinmeyi daha sıkı yerleştir.'],
    ] as const).map(([key, label, description]) => <label className="setting-row" key={key}><span><strong>{label}</strong><small>{description}</small></span><input type="checkbox" checked={preferences[key]} onChange={async e => {
      const value = e.target.checked
      try {
        updatePreferences({ [key]: value }); setError(null)
        if (key === 'notifications' && value) await enableDesktopNotifications()
      } catch (e) { setError((e as Error).message) }
    }} /></label>)}
    {preferences.notifications && <><p className="muted">{window.agentdeckDesktop?.notify ? 'Yerel masaüstü bildirimleri açık.' : 'Tarayıcı bildirimi için site izni gerekir.'}</p>
      <button type="button" onClick={async () => {
        try {
          await enableDesktopNotifications()
          await showDesktopNotification({ id: 'test', sessionId: '', title: 'AgentDeck', detail: 'Masaüstü bildirimleri hazır. Terminal sonlandığında burada göreceksiniz.' })
          setError(null)
        } catch (e) { setError((e as Error).message) }
      }}>Test bildirimi gönder</button>
    </>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="dialog-actions"><button className="primary" onClick={onClose}>Bitti</button></div>
  </div></dialog>
}
