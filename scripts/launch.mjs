import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Electron başlatıcısı.
 *
 * Electron'un SUID sandbox yardımcısı root'a ait ve 4755 olmalı; npm ile
 * kurulduğunda öyle olmaz. Bu makinedeki gibi AppArmor unprivileged user
 * namespace'leri de kısıtlıyorsa Electron açılışta abort eder. Kontrol
 * uygulama kodu çalışmadan önce yapıldığı için bayrağın komut satırında
 * olması gerekir — bu yüzden karar burada veriliyor.
 *
 * node_modules her "npm install"da sıfırlandığından sudo ile düzeltmek
 * kalıcı değil. Sandbox'sız çalışmak burada sınırlı bir taviz: pencere
 * yalnızca kendi localhost daemon'umuzu yüklüyor, contextIsolation açık,
 * nodeIntegration kapalı.
 *
 * Kalıcı düzeltmeyi tercih edersen:
 *   sudo chown root:root node_modules/electron/dist/chrome-sandbox
 *   sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
 */
const root = path.resolve(import.meta.dirname, '..')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron')
const entry = path.join(root, 'electron', 'main.js')
const helper = path.join(root, 'node_modules', 'electron', 'dist', 'chrome-sandbox')

if (!fs.existsSync(electronBin)) {
  console.error(`Electron bulunamadı: ${electronBin}\nÖnce "npm install" çalıştır.`)
  process.exit(1)
}

const args = []
try {
  const st = fs.statSync(helper)
  const setuidRoot = st.uid === 0 && (st.mode & 0o4000) !== 0
  if (!setuidRoot) args.push('--no-sandbox')
} catch {
  args.push('--no-sandbox')
}

if (args.length) console.warn('[agentdeck] chrome-sandbox yapılandırılmamış, --no-sandbox ile açılıyor')

const child = spawn(electronBin, [...args, entry], {
  stdio: 'inherit',
  env: { ...process.env, AGENTDECK_NODE: process.env.AGENTDECK_NODE || process.execPath },
})
child.on('exit', (code) => process.exit(code ?? 0))
