// Run explicitly with Electron on a desktop; sends one real OS notification.
const { app, Notification } = require('electron')
app.whenReady().then(() => {
  if (!Notification.isSupported()) {
    console.error('Desktop notifications are not supported')
    app.exit(1)
    return
  }
  const notification = new Notification({
    title: 'AgentDeck · Test bildirimi',
    body: 'Masaüstü pop-up bildirimi çalışıyor. Terminal sonlandığında burada göreceksiniz.',
    silent: false,
  })
  const timeout = setTimeout(() => { console.error('Notification show timed out'); app.exit(1) }, 10000)
  notification.once('show', () => {
    clearTimeout(timeout)
    console.log('PASS: Electron emitted notification show')
    setTimeout(() => app.quit(), 3000)
  })
  notification.once('failed', (_event, error) => { console.error(error); app.exit(1) })
  notification.show()
})
