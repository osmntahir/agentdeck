import { enableDesktopNotifications, showDesktopNotification } from '../notifications'
import { useEffect, useRef, useState } from 'react'
import { usePreferences, updatePreferences, THEMES, type ThemeName } from '../preferences'
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const preferences = usePreferences()
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  return <dialog ref={ref} className="session-modal settings-modal" aria-labelledby="settings-title" onCancel={e => { e.preventDefault(); onClose() }}><div className="dialog">
    <header className="dialog-head"><h2 id="settings-title">Ayarlar</h2><p className="dialog-sub">Bu tarayıcı / uygulama profiline kaydedilir.</p></header>
    <fieldset className="theme-picker">
      <legend><strong>Tema</strong><small>Arayüz ve terminal renkleri birlikte değişir.</small></legend>
      <div className="theme-swatches">
        {Object.entries(THEMES).map(([id, theme]) => <label key={id} className="theme-swatch" style={{ '--swatch': theme.swatch, '--swatch-bg': theme.terminal.background } as React.CSSProperties}>
          <input type="radio" name="theme" value={id} checked={preferences.theme === id} onChange={() => {
            try { updatePreferences({ theme: id as ThemeName }); setError(null) }
            catch { setError('Tema kaydedilemedi.') }
          }} />
          <span className="theme-preview" aria-hidden="true"><i /><i /><i /></span>
          <span>{theme.label}</span>
        </label>)}
      </div>
    </fieldset>
    {([
      ['notifications', 'Bildirimler', 'Bakmadığın bir ajan onay beklediğinde, uzun bir çalışmadan sonra çıktıyı durdurduğunda veya bittiğinde haber ver. Uygulama öndeyken köşede kısa kart, arka plandayken masaüstü bildirimi çıkar.'],
      ['previews', 'Oturum önizlemeleri', 'Oturum kartlarında terminal çıktısını göster.'],
      ['compact', 'Kompakt görünüm', 'Kartları ve gezinmeyi daha sıkı yerleştir.'],
    ] as const).map(([key, label, description]) => <label className="setting-row" key={key}><span><strong>{label}</strong><small>{description}</small></span><input type="checkbox" role="switch" className="switch" checked={preferences[key]} onChange={async e => {
      const value = e.target.checked
      try {
        updatePreferences({ [key]: value }); setError(null)
        if (key === 'notifications' && value) await enableDesktopNotifications()
      } catch (e) { setError((e as Error).message) }
    }} /></label>)}
    {preferences.notifications && <><p className="muted">{window.agentdeckDesktop?.notify ? 'Yerel masaüstü bildirimleri açık.' : 'Tarayıcı bildirimi için site izni gerekir.'}</p>
      <button type="button" className="ghost-button" onClick={async () => {
        try {
          await enableDesktopNotifications()
          await showDesktopNotification({ id: 'test', sessionId: '', title: 'AgentDeck', detail: 'Masaüstü bildirimleri hazır. Uygulama arka plandayken ajanlar sizi buradan çağırır.' })
          setError(null)
        } catch (e) { setError((e as Error).message) }
      }}>Test bildirimi gönder</button>
    </>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="settings-keys">
      <strong>Klavye</strong>
      <dl>
        <dt><kbd>Ctrl+K</kbd> / <kbd>Ctrl+Shift+P</kbd></dt><dd>Komut paleti: oturuma geç, ajan başlat</dd>
        <dt><kbd>Alt+1…9</kbd></dt><dd>Kenar çubuğundaki oturuma atla</dd>
        <dt><kbd>Ctrl+PgUp</kbd> / <kbd>Ctrl+PgDn</kbd></dt><dd>Önceki / sonraki oturum</dd>
        <dt><kbd>Ctrl+Shift+N</kbd></dt><dd>Yeni oturum</dd>
        <dt><kbd>Ctrl+Shift+Enter</kbd></dt><dd>Grid panelini büyüt / geri al</dd>
        <dt><kbd>Ctrl+Shift+B</kbd></dt><dd>Kenar çubuğunu daralt / genişlet</dd>
        <dt><kbd>Ctrl</kbd> + sürükle</dt><dd>Oturumu grid’e aynı programın yeni kopyası olarak bırak</dd>
        <dt><kbd>Esc</kbd> · <kbd>F6</kbd></dt><dd>Taramaya dön · terminalden çık</dd>
      </dl>
    </div>
    <div className="dialog-actions"><button className="primary" onClick={onClose}>Bitti</button></div>
  </div></dialog>
}
