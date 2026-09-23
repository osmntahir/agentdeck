import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// Masaüstü ortamının PATH'i minimaldir ve nvm'in node'unu içermez. Bu script,
// kendisini çalıştıran node'un mutlak yolunu .desktop dosyasına gömer;
// uygulama böylece kısayoldan açıldığında da daemon'u başlatabilir.
const root = path.resolve(import.meta.dirname, '..')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron')
const launcher = path.join(root, 'scripts', 'launch.mjs')
const icon = path.join(root, 'build', 'icon.png')

if (!fs.existsSync(electronBin)) {
  console.error(`Electron bulunamadı: ${electronBin}\nÖnce "npm install" çalıştır.`)
  process.exit(1)
}
if (!fs.existsSync(path.join(root, 'dist', 'server', 'index.js'))) {
  console.error('Derleme yok. Önce "npm run build" çalıştır.')
  process.exit(1)
}

const appsDir = path.join(os.homedir(), '.local', 'share', 'applications')
fs.mkdirSync(appsDir, { recursive: true })
const target = path.join(appsDir, 'agentdeck.desktop')

fs.writeFileSync(
  target,
  `[Desktop Entry]
Type=Application
Name=agentdeck
Comment=Paralel AI ajan oturumları
Exec=env AGENTDECK_NODE=${process.execPath} ${process.execPath} ${launcher}
Icon=${icon}
Terminal=false
Categories=Development;
StartupWMClass=agentdeck
`,
)
fs.chmodSync(target, 0o755)

console.log(`Kısayol yazıldı : ${target}`)
console.log(`node yolu gömülü: ${process.execPath}`)
console.log('Uygulama menüsünde "agentdeck" olarak görünecek.')

// --desktop: aynı kısayol masaüstüne de konur.
if (process.argv.includes('--desktop')) {
  let desktopDir = path.join(os.homedir(), 'Desktop')
  try {
    desktopDir = execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' }).trim() || desktopDir
  } catch {
    // xdg-user-dir yoksa ~/Desktop kullanılır.
  }
  fs.mkdirSync(desktopDir, { recursive: true })
  const desktopTarget = path.join(desktopDir, 'agentdeck.desktop')
  fs.copyFileSync(target, desktopTarget)
  fs.chmodSync(desktopTarget, 0o755)
  // GNOME masaüstü, güvenilir işaretlenmemiş kısayolu çift tıkla açmaz.
  try {
    execFileSync('gio', ['set', desktopTarget, 'metadata::trusted', 'true'], { stdio: 'ignore' })
  } catch {
    // gio yoksa masaüstü ortamı ilk açılışta izin ister.
  }
  console.log(`Masaüstü simgesi : ${desktopTarget}`)
}
