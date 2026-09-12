# agentdeck

> Bu README mevcut prototip runtime'ını anlatır. Hedef davranış [V0 spec revizyon 2](docs/specs/agentdeck-v0.md) içindedir; [açık doğrulama kapıları](docs/specs/agentdeck-v0-validation-gates.md) tamamlanmadan hedef özellikler uygulanmış sayılmaz.

Paralel AI ajan oturumlarını izole git worktree'lerde yöneten yerel çalışma tezgâhı.

Claude Code, Codex ve Gemini CLI'ı aynı anda, farklı projelerde, birbirinin
çalışma kopyasını bozmadan çalıştırmak için. Oturumlar bir daemon'da yaşar —
tarayıcıyı kapatmak ajanı öldürmez.

## Ne yapar

- **Oturum başına izolasyon** — her görev kendi `git worktree`'sinde ve kendi
  branch'inde açılır. Paralel ajanlar aynı `index.lock` için kavga etmez.
- **Kalıcı PTY** — ajan süreçleri daemon'a bağlıdır, arayüze değil. Sekmeyi
  kapat, geri gel, oturum kaldığı yerden devam eder.
- **Oturumlar arası geçiş** — her terminal mount'ta kalır, scrollback ve
  çalışma durumu korunur.
- **Diff görünümü** — oturumun worktree'sindeki değişiklikler, ajanın yeni
  yazdığı takip edilmeyen dosyalar dahil.
- **Ortak mod** — izolasyon istemediğin işler için ana çalışma kopyasında
  oturum açabilirsin.

## Mimari

```
tarayıcı (React + xterm.js)
    │  WebSocket  ── PTY baytları
    │  REST       ── proje/oturum CRUD, diff
    ▼
daemon (Node + TypeScript)
    ├── node-pty      oturum başına PTY, halka tampon (256KB scrollback)
    ├── execFile git  worktree add/remove, diff, branch
    └── ~/.agentdeck  state.json, token, worktrees/
```

Arayüz tek kullanımlık bir istemcidir; oturumların sahibi daemon'dur.

## Çalıştırma

### Masaüstü uygulaması

```bash
npm install
npm run app             # derler ve pencereyi açar
npm run install-desktop # uygulama menüsüne kısayol ekler (bir kez)
```

Kabuk daemon'u kendisi bulur: ayakta değilse başlatır, ayaktaysa ona bağlanır.
İkinci kez açmak yeni pencere açmaz, var olanı öne getirir.

**Pencereyi kapatmak daemon'u öldürmez.** Ajan oturumları çalışmaya devam
eder; uygulamayı tekrar açtığında kaldıkları yerden bulursun. Kalıcılık
modelinin tamamı buna dayanıyor.

### Tarayıcıyla

```bash
npm run dev                   # daemon :4711 + Vite :4710
npm run build && npm start    # tek süreç, :4711
```

Konsola token'lı bir URL basılır:

```
http://127.0.0.1:4710/?token=...
```

## Güvenlik

Daemon yalnızca `127.0.0.1`'e bağlanır. WebSocket'in CORS preflight'ı
olmadığı için ziyaret ettiğin herhangi bir sayfa yerel porta bağlanmayı
deneyebilir; bu yüzden hem REST hem WS bir token ister ve `Origin` başlığı
localhost ile sınırlıdır.

Token `~/.agentdeck/token` içinde (0600) tutulur. Arayüz onu URL'den bir kez
alıp `localStorage`'a yazar ve adres çubuğundan siler.

## Dizin yapısı

```
electron/main.js       masaüstü kabuğu: daemon yaşam döngüsü, pencere, menü
scripts/
  launch.mjs           sandbox tespiti + Electron başlatma
  install-desktop.mjs  .desktop kısayolu (node yolunu gömer)
src/
  shared/types.ts      daemon ve arayüzün ortak tipleri
  server/
    index.ts           HTTP + WebSocket, REST uçları
    sessions.ts        PTY yaşam döngüsü, halka tampon, süreç grubu kill
    git.ts             worktree ve diff işlemleri
    store.ts           JSON kalıcılık (atomik yazım), token
  web/
    App.tsx            düzen, oturum seçimi, sekmeler
    components/        Sidebar, TerminalPane, DiffView, NewSessionDialog
```

## Neler yok

Bilinçli olarak MVP dışında bırakılanlar:

- Ajanlar arası iletişim / paylaşılan context (MCP katmanı)
- Grid görünümü, dosya ağacı, kod editörü
- Görev adının ajana ilk prompt olarak geçmesi
- Otomatik PR açma, kanban
- Yeni masaüstü kabuğuna geçiş (mevcut Electron başlatıcı vardır)

## Bilinen sınırlar

- **Daemon ölürse PTY'ler de ölür.** Worktree, branch ve diff diskte kaldığı
  için iş kaybolmaz; kaybedilen ajanın bellek içi bağlamıdır. Oturum `exited`
  işaretlenir ve yeniden başlatılabilir. Sürecin daemon'dan bağımsız yaşaması
  isteniyorsa oturum sahipliği bir multiplexer'a (tmux) taşınmalıdır.
- PTY çıktısı WebSocket üzerinde JSON'a sarılır. Yoğun çıktıda maliyetlidir;
  binary frame'e geçiş planlı.
- Her oturum için bir xterm örneği mount'ta tutulur; çok sayıda eşzamanlı
  oturumda ağırlaşır.
- Tek instance koruması yok. İki daemon üst üste binerse `state.json`
  birbirini ezebilir. (Masaüstü kabuğunda pencere için tek instance kilidi
  var; daemon tarafında port çakışması dışında koruma yok.)
- Electron'un `chrome-sandbox` yardımcısı npm kurulumunda root'a ait olmadığı
  için pencere `--no-sandbox` ile açılır. Yüklenen tek içerik kendi localhost
  daemon'umuz, `contextIsolation` açık ve `nodeIntegration` kapalı. Kalıcı
  düzeltme `scripts/launch.mjs` başındaki yorumda.

## Gereksinimler

Node 22+, `git worktree` destekleyen Git, ve kullanmak istediğin ajan CLI'ları (`claude`, `codex`,
`gemini`) `PATH`'te. Ajan oturumları login kabuk üzerinden başlatılır, yol çözümlemesi
kullanıcının login profiline bağlıdır; özellikle interaktif olmayan `.bashrc` erken
çıkışı ve nvm yolları kurulumda doğrulanmalıdır.
