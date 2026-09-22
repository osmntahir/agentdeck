'use strict'

const { app, BrowserWindow, Menu, shell, dialog, ipcMain, Notification } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const PORT = Number(process.env.AGENTDECK_PORT || 4711)
const BASE = `http://127.0.0.1:${PORT}`
const SERVER = path.join(__dirname, '..', 'dist', 'server', 'index.js')
const TOKEN_FILE = path.join(process.env.AGENTDECK_DATA_DIR || path.join(os.homedir(), '.agentdeck'), 'token')

let win = null

/** Porttaki sürecin bizim daemon olup olmadığını söyler. */
async function probe() {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) })
    if (!res.ok) return 'yabanci'
    const body = await res.json()
    return body.app === 'agentdeck' ? 'bizim' : 'yabanci'
  } catch {
    return 'yok'
  }
}

/**
 * Daemon'u başlatır. İki kritik nokta:
 *
 * 1. detached + unref — pencereyi kapatmak oturumları öldürmemeli. Kalıcılık
 *    modelinin tamamı buna dayanıyor.
 * 2. node'un mutlak yolu. Masaüstü kısayolundan açılan bir uygulamanın PATH'i
 *    minimaldir ve nvm'in node'unu içermez; login kabuğu da kurtarmaz, çünkü
 *    Ubuntu'da .bashrc non-interactive kabukta erken döner. Yol kurulum
 *    anında AGENTDECK_NODE ile sabitlenir (bkz. scripts/install-desktop.mjs).
 */
function resolveNode() {
  return process.env.AGENTDECK_NODE || 'node'
}

function daemonEnv() {
  const nodeBin = resolveNode()
  const extra = [
    nodeBin.includes('/') ? path.dirname(nodeBin) : null,
    path.join(os.homedir(), '.local', 'bin'),
  ].filter(Boolean)
  // Ajan CLI'ları (claude, codex, gemini) bu dizinlerde yaşıyor.
  return { ...process.env, PATH: [...extra, process.env.PATH || ''].join(path.delimiter) }
}

function startDaemon() {
  const child = spawn(resolveNode(), [SERVER], {
    detached: true,
    stdio: 'ignore',
    cwd: path.join(__dirname, '..'),
    env: daemonEnv(),
  })
  child.unref()
}

async function waitForDaemon(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await probe()) === 'bizim') return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'agentdeck',
        submenu: [
          // Ctrl+R ve Ctrl+W kabukta geçmiş araması ve kelime silmedir; menü bunları terminalden çalmaz.
          { label: 'Yenile', accelerator: 'CmdOrCtrl+Shift+R', click: () => win?.reload() },
          {
            label: 'Geliştirici araçları',
            accelerator: 'F12',
            click: () => win?.webContents.toggleDevTools(),
          },
          { type: 'separator' },
          {
            label: 'Daemon durumu…',
            click: async () => {
              const state = await probe()
              dialog.showMessageBox(win, {
                type: 'info',
                message: state === 'bizim' ? 'Daemon çalışıyor' : 'Daemon kapalı',
                detail:
                  state === 'bizim'
                    ? `${BASE} üzerinde ayakta. Bu pencereyi kapatsan da oturumlar çalışmaya devam eder.`
                    : 'Porta erişilemiyor. Uygulamayı yeniden başlat.',
              })
            },
          },
          {
            label: 'Tarayıcıda aç',
            click: () => shell.openExternal(`${BASE}/?token=${readToken()}`),
          },
          { type: 'separator' },
          // Pencereyi kapatmak daemon'u öldürmez: kalıcılık bunun üzerine kurulu.
          { label: 'Pencereyi kapat (oturumlar sürer)', accelerator: 'CmdOrCtrl+Shift+W', role: 'quit' },
        ],
      },
      {
        label: 'Düzen',
        submenu: [
          { role: 'copy', label: 'Kopyala' },
          { role: 'paste', label: 'Yapıştır' },
          { role: 'selectAll', label: 'Tümünü seç' },
        ],
      },
      {
        label: 'Terminal',
        submenu: [
          {
            label: 'Gerçek F6 gönder',
            click: () => win?.webContents.send('agentdeck:pty-f6'),
          },
        ],
      },
    ]),
  )
}

function createWindow(token) {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    backgroundColor: '#0b0c0f',
    autoHideMenuBar: true,
    title: 'agentdeck',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== BASE) event.preventDefault()
  })
  win.loadURL(`${BASE}/?token=${encodeURIComponent(token)}`)
  win.on('focus', () => win?.flashFrame(false))
  win.on('closed', () => {
    win = null
  })

  // Dış bağlantılar sistem tarayıcısında açılsın, uygulama penceresinde değil.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

// Tek instance: ikinci kez açılırsa var olan pencereyi öne getir.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    if (!fs.existsSync(SERVER)) {
      dialog.showErrorBox('Derleme bulunamadı', `Önce "npm run build" çalıştır.\n\nBeklenen: ${SERVER}`)
      app.quit()
      return
    }

    const state = await probe()
    if (state === 'yabanci') {
      dialog.showErrorBox(
        'Port dolu',
        `${PORT} portunda agentdeck olmayan bir servis var.\n\nAGENTDECK_PORT ile başka bir port verebilirsin.`,
      )
      app.quit()
      return
    }

    if (state === 'yok') startDaemon()

    if (!(await waitForDaemon())) {
      dialog.showErrorBox('Daemon başlatılamadı', `${BASE} yanıt vermedi.\n\nElle dene: npm start`)
      app.quit()
      return
    }

    ipcMain.handle('agentdeck:select-project-folder', async (event) => {
      if (
        !win ||
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame ||
        new URL(event.senderFrame.url).origin !== BASE
      ) {
        throw new Error('Klasör seçimi yalnız uygulama penceresinden yapılabilir')
      }
      const result = await dialog.showOpenDialog(win, {
        title: 'Proje klasörünü seç',
        buttonLabel: 'Klasörü seç',
        defaultPath: app.getPath('desktop'),
        properties: ['openDirectory'],
      })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    })

    const activeNotifications = new Set()
    ipcMain.handle('agentdeck:notify', (event, notice) => {
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame ||
          new URL(event.senderFrame.url).origin !== BASE) throw new Error('Bildirim yalnız uygulama penceresinden gönderilebilir')
      if (!notice || typeof notice.title !== 'string' || typeof notice.detail !== 'string' ||
          typeof notice.sessionId !== 'string' || notice.title.length > 200 || notice.detail.length > 500 ||
          notice.sessionId.length > 100) throw new Error('Bildirim içeriği geçersiz')
      if (!Notification.isSupported()) throw new Error('Bu masaüstü ortamı bildirim desteklemiyor')
      const notification = new Notification({ title: notice.title, body: notice.detail,
        icon: path.join(__dirname, '..', 'build', 'icon.png'), silent: false, urgency: 'normal' })
      activeNotifications.add(notification)
      notification.once('close', () => activeNotifications.delete(notification))
      notification.once('failed', (_event, error) => {
        activeNotifications.delete(notification)
        console.error('[agentdeck] Masaüstü bildirimi gösterilemedi:', error)
      })
      notification.once('click', () => {
        if (!win || win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show(); win.focus()
        win.webContents.send('agentdeck:notification-click', notice.sessionId)
      })
      // Some platforms never emit close for expired notifications; bound retention.
      if (activeNotifications.size > 20) {
        const oldest = activeNotifications.values().next().value
        oldest.close(); activeNotifications.delete(oldest)
      }
      notification.show()
      // Arka plandaki pencere görev çubuğunda dikkat ister; odak gelince söner.
      if (!win.isFocused()) win.flashFrame(true)
    })

    buildMenu()
    createWindow(readToken())
  })

  app.on('window-all-closed', () => {
    // Daemon bilerek hayatta bırakılıyor; ajan oturumları devam etsin.
    app.quit()
  })

  app.on('activate', () => {
    if (!win) createWindow(readToken())
  })
}
