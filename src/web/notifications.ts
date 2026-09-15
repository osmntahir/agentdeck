export interface DesktopNotice { title: string; detail: string; sessionId: string; id: string }

export async function enableDesktopNotifications(): Promise<void> {
  if (window.agentdeckDesktop?.notify) return
  if (!('Notification' in window)) throw new Error('Bu tarayıcı masaüstü bildirimi desteklemiyor.')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Masaüstü bildirimi izni kapalı. Tarayıcının site ayarlarından bildirimlere izin verin.')
}

export async function showDesktopNotification(notice: DesktopNotice): Promise<void> {
  if (window.agentdeckDesktop?.notify) return window.agentdeckDesktop.notify(notice)
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const notification = new Notification(notice.title, { body: notice.detail, tag: notice.id, silent: false })
  notification.onclick = () => {
    window.focus()
    window.dispatchEvent(new CustomEvent('agentdeck:notification-click', { detail: notice.sessionId }))
    notification.close()
  }
}
