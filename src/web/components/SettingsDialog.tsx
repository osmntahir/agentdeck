import { useEffect, useRef, useState } from 'react'
import { usePreferences, updatePreferences } from '../preferences'
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const preferences = usePreferences()
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  return <dialog ref={ref} className="session-modal settings-modal" aria-labelledby="settings-title" onCancel={e => { e.preventDefault(); onClose() }}><div className="dialog">
    <h2 id="settings-title">Ayarlar</h2><p className="muted">Bu tarayıcı / uygulama profiline kaydedilir.</p>
    {([
      ['restore', 'Yarım kalan oturumları geri aç', 'Daemon kapanınca yarım kalan ajan aynı klasörde açılır. Kimlik varsa konuşma, yoksa seçici; genel komutlar ve bilerek durdurulan işler tekrarlanmaz.'],
      ['notifications', 'Terminal çıkış bildirimleri', 'Süreç sonlandığında uygulama içinde ve izin varsa masaüstünde bildir. Sessizlik tamamlanma sayılmaz.'],
      ['previews', 'Oturum önizlemeleri', 'Oturum kartlarında terminal çıktısını göster.'],
      ['compact', 'Kompakt görünüm', 'Kartları ve gezinmeyi daha sıkı yerleştir.'],
    ] as const).map(([key, label, description]) => <label className="setting-row" key={key}><span><strong>{label}</strong><small>{description}</small></span><input type="checkbox" checked={preferences[key]} onChange={async e => {
      const value = e.target.checked
      try {
        updatePreferences({ [key]: value }); setError(null)
        if (key === 'notifications' && value && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission()
      } catch { setError('Ayar kaydedilemedi; tarayıcının depolama iznini kontrol edin.') }
    }} /></label>)}
    {preferences.notifications && <p className="muted">Masaüstü izni: {'Notification' in window ? Notification.permission === 'granted' ? 'açık' : 'kapalı; uygulama içi bildirimler açık' : 'bu ortamda desteklenmiyor'}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="dialog-actions"><button className="primary" onClick={onClose}>Bitti</button></div>
  </div></dialog>
}
