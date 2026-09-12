# agentdeck

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

```bash
npm install
npm run dev     # daemon :4711 + Vite :4710
```

Konsola token'lı bir URL basılır:

```
http://127.0.0.1:4710/?token=...
```

Üretim derlemesi için:

```bash
npm run build && npm start    # tek süreç, :4711
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
- Masaüstü kabuğu (Electron/Tauri)

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
  birbirini ezebilir.

## Gereksinimler

Node 22+, git 2.3+, ve kullanmak istediğin ajan CLI'ları (`claude`, `codex`,
`gemini`) `PATH`'te. Ajan oturumları login kabuk üzerinden başlatılır, bu
yüzden `~/.local/bin` ve nvm yolları bulunur.
