# agentdeck

> Bu README mevcut runtime’ı anlatır. §8/1 ve §8/3 terminal dilimi uygulandı; sınırlar [ADR 0007](docs/adr/0007-slice-1-implementation-boundaries.md) ve [ADR 0008](docs/adr/0008-terminal-slice-implementation.md) içinde. Gerçek CLI/tarayıcı ürün kabulü, yönetilen konuşma devamı ve arşiv henüz tamamlanmadı.

Paralel AI ajan oturumlarını izole git worktree'lerde yöneten yerel çalışma tezgâhı.

Claude Code, Codex ve Gemini CLI'ı aynı anda, farklı projelerde, birbirinin
çalışma kopyasını bozmadan çalıştırmak için. Oturumlar bir daemon'da yaşar —
tarayıcıyı kapatmak ajanı öldürmez.

## Ne yapar

- **Oturum başına izolasyon** — her görev kendi `git worktree`'sinde ve kendi
  branch'inde açılır. Paralel ajanlar aynı `index.lock` için kavga etmez.
- **Kalıcı PTY** — ajan süreçleri daemon'a bağlıdır, arayüze değil. Sekmeyi
  kapat, geri gel, oturum kaldığı yerden devam eder.
- **Doğrulanmış durdurma** — süreç grubunun gerçekten bittiği kanıtlanır;
  lider çıkıp çocuk kalırsa bu izlenir. Süre dolması başarı sayılmaz ve
  doğrulanmamış durdurmadan sonra yeni Run başlamaz, silme yapılmaz.
- **Dosya koruma** — silme yalnız taze bir onayla yapılır, branch hiçbir
  koşulda silinmez, `git worktree remove` başarısızsa zorla silme yoluna
  düşülmez. Kayıtsız çalışma kopyaları yalnız listelenir, temizlenmez.
- **Yerel klasör projeleri** — Git deposu olmayan klasörler de eklenebilir; Git başlatılmaz, dosyalar taşınmaz. Ortak oturum doğrudan klasörde çalışır. Klasörün altındaki Git depoları (en çok 4 seviye, 30 depo) ayrı ayrı ele alınır: izole oturum her depo için aynı branch adıyla ayrı worktree açar, depo dışındaki dosyaları kopyalamaz.
- **Klasör seçici** — masaüstünde “Proje ekle → Klasör seç…” sistem penceresini açar. Tarayıcıda tam klasör yolu yazılır.
- **Oturum panosu** — projeye göre gruplanmış gerçek terminal önizlemeleri, program/proje/oturum araması ve yaşam döngüsü filtreleri. Görünen sonuçların ilk 24 oturumu için önizleme alınır; karttan tek terminale geçilir.
- **Oturumlar arası geçiş** — yalnız odaktaki terminal açılır; ekran daemon'daki
  headless modelden kurulur. Scrollback açık “Terminal geçmişini yükle” eylemiyle gelir.
- **Kalıcı terminal görüntüsü** — son iki Run checkpoint'i tutulur; canlı olmayan
  güncel Run salt okunur açılır. Eksik ve bozuk geçmiş ayrı bildirilir.
- **Tek kontrol sahibi** — diğer istemciler salt okunur izler; “Kontrolü al”
  ile kullanıcı girdi ve boyutlandırma sahipliğini devralır.
- **Diff görünümü** — oturumun worktree'sindeki değişiklikler, ajanın yeni
  yazdığı takip edilmeyen dosyalar dahil. Klasör projelerinde her alt depo ayrı
  bölüm olarak gösterilir.
- **Ortak mod** — izolasyon istemediğin işler için ana çalışma kopyasında
  oturum açabilirsin.

## Mimari

```
tarayıcı (React + xterm.js)
    │  WebSocket  ── parçalı snapshot + sıralı UTF-8 devamı
    │  REST       ── proje/oturum CRUD, diff
    ▼
daemon (Node + TypeScript)
    ├── node-pty      Run başına PTY, high/low-water pause/resume
    ├── worker        headless xterm, snapshot/preview, Run FIFO
    ├── execFile git  worktree add/remove, diff, status
    ├── tek yazar     canonical veri dizinine bağlı abstract socket kilidi
    └── ~/.agentdeck  state.json, token, worktrees/, terminal/ checkpoint'leri
```

Arayüz tek kullanımlık bir istemcidir; oturumların sahibi daemon'dur. Kalıcı
kayıt tek doğrudur: `lifecycle` canlılık tahminiyle ezilmez, `live` yalnız yeni
PTY doğduktan sonra yazılır ve gözlenen çıkış kalıcıdır.

Veri dizini `AGENTDECK_DATA_DIR`, port `AGENTDECK_PORT` (yoksa `PORT`, yoksa
4711) ile değiştirilir.

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
npm test                      # node:test paketi (sunucu davranış testleri)
npm run typecheck             # web + sunucu + testler
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

Token `~/.agentdeck/token` içinde (0600) tutulur; `state.json` da 0600 yazılır.
Arayüz token'ı URL'den bir kez alıp `localStorage`'a yazar ve adres çubuğundan
siler.

Run ortamı bir izin listesidir: daemon'ın kabuğundaki her değişken PTY'ye
kopyalanmaz. `NODE_OPTIONS`, `BASH_ENV`/`ENV`, `BASH_FUNC_*` ve parent ajan
işaretçileri taşınmaz; `TERM` ve `AGENTDECK_*` uygulama tarafından atanır.
Kullanıcının kendi `environment.json` dosyası henüz okunmuyor (spec §3, §8/2).

## Dizin yapısı

```
electron/main.js       masaüstü kabuğu: daemon yaşam döngüsü, pencere, menü
scripts/
  launch.mjs           sandbox tespiti + Electron başlatma
  install-desktop.mjs  .desktop kısayolu (node yolunu gömer)
src/
  shared/types.ts      daemon ve arayüzün ortak tipleri
  server/
    index.ts           giriş noktası: env, kapanış sinyalleri
    daemon.ts          HTTP + WebSocket, REST uçları, kilitler, silme onayı
    sessions.ts        Run yaşam döngüsü, PTY akışı, kalan süreç grubu
    terminalHost.ts    worker sahipliği, bariyer, baskı ve flush
    terminalWorker.ts  Run FIFO ve sınırlı tur bütçesi
    terminalState.ts   güvenli kesim, headless ekran, sorgu ayıklama
    checkpoints.ts     Run kimlikli atomik görüntü kaydı
    stop.ts            doğrulanmış durdurma (timeout başarı değildir)
    store.ts           şema 2 kalıcılık: doğrulanmış migrate, copy-on-write
    lock.ts            tek yazar kilidi (abstract socket)
    locks.ts           Session mutasyon kilidi, Git dizini serileştirme
    dedup.ts           requestId defteri (10 dk / 1024 kayıt)
    env.ts             Run ortamı izin listesi
    orphans.ts         salt okunur yetim çalışma kopyası keşfi
    repos.ts           klasör projesindeki alt Git depolarının sınırlı keşfi
    git.ts             worktree, HEAD OID, status ve diff işlemleri
  web/
    App.tsx            düzen, oturum seçimi, sekmeler
    components/        Sidebar, TerminalPane, DiffView, NewSessionDialog
tests/                 node:test paketi (store, stop, kilit, dedup, API)
docs/                  spec, ADR'ler, doğrulama kapıları, ölçüm script'leri
```

## Neler yok

Bilinçli olarak MVP dışında bırakılanlar:

- Ajanlar arası iletişim / paylaşılan context (MCP katmanı)
- Aynı anda birden fazla etkileşimli terminal, dosya ağacı, kod editörü
- Görev adının ajana ilk prompt olarak geçmesi
- Otomatik PR açma, kanban
- Yeni masaüstü kabuğuna geçiş (mevcut Electron başlatıcı vardır)
- Uygulamadan branch silme (V0 dışıdır; branch her zaman korunur)

## Bilinen sınırlar

- **Daemon ölürse PTY'ler de ölür.** Worktree, branch ve diff diskte kaldığı
  için iş kaybolmaz; kaybedilen ajanın bellek içi bağlamıdır. Kayıt `orphaned`
  olur — ölüm saati ve çıkış kodu bilinmediği için uydurulmaz — ve yeniden
  çalıştırılabilir. Sürecin daemon'dan bağımsız yaşaması isteniyorsa oturum
  sahipliği bir multiplexer'a (tmux) taşınmalıdır.
- **Terminal ürün kabulü açık.** Ekran/scrollback replay ve checkpoint uygulanmıştır;
  gerçek tarayıcı render, mouse/paste/IME ve yoğun çıktı kabulü yapılmadı.
  Oturum panosu önizleme API’sine bağlıdır. Proje ekleme, kabuk başlatma, terminal girdisi, diff, arama ve durdurma akışı gerçek Chromium üzerinde doğrulandı; ajan CLI’larının ürün kabulü ayrı kalır.
- **Geçmiş sınırlıdır.** En fazla son iki yazılmış Run görüntüsü tutulur; tam
  konuşma arşivi değildir. Önceki Run seçicisi henüz arayüzde yoktur.
- **Konuşmayı sürdürme yolu yok.** Yeniden çalıştırma başlangıç komutunu
  aynen tekrarlar; yönetilen kimlikle `fresh`/`resume` ve CLI seçicisi
  [G2](docs/specs/agentdeck-v0-validation-gates.md) insan kabul testi geçmeden
  açılmaz.
- **Proje silme kademeli değildir.** Oturum kaydı olan proje reddedilir;
  oturumlar tek tek silinir. Arşivleme henüz yok.
- Silme onayı dizin kimliği ve Git durumuna bağlıdır; ignored dosyaları da
  kapsayan içerik fingerprint'i ve bütçeleri §8/4'te gelir. Ortak oturumlarda yalnız dizin kimliği doğrulanır; proje dosyaları silinmez.
- Klasör projesinde alt depo taraması eksik kalırsa veya bir depoda commit yoksa
  izole oturum hiç worktree açmadan reddedilir. Silmede bir worktree
  kaldırılamazsa kaldırılanlar kayıttan düşer, kalanlar ve dosyaları korunur.
- Electron'un `chrome-sandbox` yardımcısı npm kurulumunda root'a ait olmadığı
  için pencere `--no-sandbox` ile açılır. Yüklenen tek içerik kendi localhost
  daemon'umuz, `contextIsolation` açık ve `nodeIntegration` kapalı. Kalıcı
  düzeltme `scripts/launch.mjs` başındaki yorumda.

## Gereksinimler

Node 22+, `git worktree` destekleyen Git, ve kullanmak istediğin ajan CLI'ları (`claude`, `codex`,
`gemini`) `PATH`'te. Ajan oturumları login kabuk üzerinden başlatılır, yol çözümlemesi
kullanıcının login profiline bağlıdır; özellikle interaktif olmayan `.bashrc` erken
çıkışı ve nvm yolları kurulumda doğrulanmalıdır.
