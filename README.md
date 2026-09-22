# agentdeck

> Bu README mevcut runtime’ı anlatır. §8/1, §8/3 terminal dilimi, §8/4 çalışma sonucu dilimi, §8/5 tarama/odak/poll entegrasyonu ve §8/6 dayanıklılık uygulandı; sınırlar [ADR 0007](docs/adr/0007-slice-1-implementation-boundaries.md), [ADR 0008](docs/adr/0008-terminal-slice-implementation.md), [ADR 0011](docs/adr/0011-work-result-slice-implementation.md), [ADR 0012](docs/adr/0012-scan-focus-poll-implementation.md) ve [ADR 0013](docs/adr/0013-durability-slice-implementation.md) içinde. Gerçek CLI/tarayıcı ürün kabulü ve yönetilen konuşma devamı henüz tamamlanmadı.

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
- **Dosya koruma** — silme yalnız taze bir onayla yapılır; onay ignored dosyalar
  (.env, bağımlılıklar) dahil geri getirilemeyecek içeriğin hash'ine bağlıdır ve
  5 sn / 10.000 dosya / 128 MiB bütçesini aşan klasör için onay üretilmez. Branch
  hiçbir koşulda silinmez, `git worktree remove` başarısızsa zorla silme yoluna
  düşülmez. Oturumu olan proje tek onayla sırayla silinir; ilk hatada durulur ve
  proje kalır. Kayıtsız çalışma kopyaları yalnız listelenir, temizlenmez.
- **Yerel klasör projeleri** — Git deposu olmayan klasörler de eklenebilir; Git başlatılmaz, dosyalar taşınmaz. Ortak oturum doğrudan klasörde çalışır. Klasörün altındaki Git depoları (en çok 4 seviye, 30 depo) ayrı ayrı ele alınır: izole oturum her depo için aynı branch adıyla ayrı worktree açar, depo dışındaki dosyaları kopyalamaz.
- **Klasör seçici** — masaüstünde “Proje ekle → Klasör seç…” sistem penceresini açar. Tarayıcıda tam klasör yolu yazılır.
- **Oturum panosu** — projeye göre gruplanmış gerçek terminal önizlemeleri, program/proje/oturum araması, yaşam döngüsü, yaş ve çalışma dizini hatası. Görünen taramanın ilk 24 oturumu için önizleme alınır; oturum veya grid açıkken bu iş istenmez. Karttan tek terminale geçilir. Oklarla aday değişir, Enter açar; poll sırayı ve odağı değiştirmez.
- **Dar ekran** — 700 px ve altında proje/oturum listesi çekmecede açılır; Escape odağı açan düğmeye döndürür.
- **Komut paleti** — `Ctrl+Shift+P` (terminal dışında `Ctrl+K`) oturumlar, yeni oturum ve komutlar arasında arar. Onay bekleyen oturum en üstte gelir; "yeni oturum" satırı pencere açmadan ajanı proje klasöründe başlatır, grid açıksa grid'e ekler.
- **Klavye** — `Alt+1…9` kenar çubuğundaki oturuma atlar (Alt basılıyken numaralar görünür), `Ctrl+PgUp/PgDn` önceki/sonraki oturuma geçer, `Ctrl+Shift+N` yeni oturum açar, grid'de `Ctrl+Shift+Enter` paneli büyütür. Bu kısayollar terminal odaktayken de çalışır ve PTY'ye gönderilmez ([ADR 0015](docs/adr/0015-keyboard-first-workspace.md)). Taramada `/` aramaya gider. F6 terminalden uygulama çubuğuna çıkar; masaüstü menüsü gerçek F6'yı PTY'ye gönderir. Escape PTY'de kalır, kromda taramaya döner. Masaüstünde yenileme `Ctrl+Shift+R`, pencereyi kapatma `Ctrl+Shift+W`'dir; `Ctrl+R`/`Ctrl+W` terminalde kalır.
- **Dikkat durumu** — onay veya yanıt bekleyen terminal kenar çubuğunda, kartta, grid sekmesinde ve başlıkta turuncu işaretlenir; pano başlığındaki sayaç bunları filtreler. Canlı Run "Çalışıyor" ve "Sessiz" olarak ayrılır.
- **Terminal grid** — birden çok oturumun terminali yan yana açılır. Sekmeyi
  sürükleyip bir panelin kenarına bırakarak bölünür, aradaki çizgiyle
  boyutlandırılır. Oturumlar kenar çubuğundan veya karttan sürüklenerek ya da
  “Grid'e ekle” ile eklenir; en çok 8 panel. Grid gezinme çubuğunda oklar ve
  Home/End panel adayını seçer; Enter/Space terminale geçer. “Seçilen panelin
  yerleşimi” ile klavyeden bölme, sekmeleştirme, boyutlandırma ve panel kapatma
  yapılır. Grup başlığındaki simgeyle veya `Ctrl+Shift+Enter` ile panel tüm
  alanı kaplar ve geri döner. Ayrı gridler tek satırlık çubukta seçilir; ad çift
  tıklamayla değişir. Yerleşim bu cihazda hatırlanır.
  Gizli sekmede terminal açık tutulmaz ([ADR 0010](docs/adr/0010-terminal-grid.md)).
- **Oturumlar arası geçiş** — tek oturum görünümünde yalnız odaktaki terminal açılır; ekran daemon'daki
  headless modelden kurulur. Scrollback açık “Terminal geçmişini yükle” eylemiyle gelir.
- **Kalıcı terminal görüntüsü** — son iki Run checkpoint'i tutulur; canlı olmayan
  güncel Run salt okunur açılır. Eksik ve bozuk geçmiş ayrı bildirilir. Daemon
  çöküşünde her iki görüntü de kalır; yarım yazım Run sayılmaz.
- **Disk ve kapanış** — kayıt yazılamazsa canlı PTY ölmez, yeni kalıcı iş 503
  döner. SIGTERM süreçleri durdurur ve çıkışı kaydeder; yalnız soket kopuşu
  oturumu yetim bırakmaz. Kayıp create/launch cevabı aynı daemon'da ikinci Run
  açmaz.
- **Tek kontrol sahibi** — diğer istemciler salt okunur izler; “Kontrolü al”
  ile kullanıcı girdi ve boyutlandırma sahipliğini devralır. Sahibi olmayan
  kontrolü açık terminal kendiliğinden alır; sahipten alınması yine açık eylemdir.
- **Diff görünümü** — “Bu çalışma” başlangıç commit'inden bu yana toplam farkı
  (ajanın commit'leri dahil), “Commit edilmemiş” HEAD'e göre farkı gösterir;
  takip edilmeyen dosyalar ikisinde de vardır. Okuma 5 sn / 1 MiB patch / 50 yeni
  dosya ile sınırlıdır ve kesilme söylenir; Git hatası temiz diff sayılmaz.
  Klasör projelerinde her alt depo ayrı bölüm olarak gösterilir.
- **Aynı çalışma kopyasında komut** — “komut çalıştır…” aynı klasörde yeni Run
  açar; CLI seçicileri (`claude --resume`, `codex resume`, `gemini --resume`)
  hazır komut olarak gelir. Elinizdeki konuşma UUID’si ayrı alandan incelenebilir
  komuta aktarılır; Enter bu alanda yalnız komutu hazırlar, süreç başlatmaz. Başlangıç programı değişmez; “yeniden çalıştır” son
  komutu tekrarlar. Önceki Run'ın terminal görüntüsü salt okunur açılır.
- **Arşiv** — iş bitince oturum arşivlenir: dosyalar, branch ve görüntüler kalır,
  oturum aktif taramadan çıkar ve Arşiv filtresiyle bulunur. Çalışan süreç ancak
  açık “durdur ve arşivle” ile durdurulur.
- **Korunan branch'ler** — proje başlığındaki “Branch'ler” silinen oturumların da
  `agentdeck/` branch'lerini tip commit'iyle listeler ve adı kopyalatır.
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
İsteğe bağlı `~/.config/agentdeck/environment.json` her Run öncesi okunur
(yoksa boş; kullanıcı sahibi, `chmod 600`, 64 KiB, düz string değerler). Bozuk
veya açık dosyada Run başlamaz; çalışan sürece enjekte edilmez.

## Dizin yapısı

```
electron/main.js       masaüstü kabuğu: daemon yaşam döngüsü, pencere, menü
scripts/
  launch.mjs           sandbox tespiti + Electron başlatma
  install-desktop.mjs  .desktop kısayolu (node yolunu gömer)
src/
  shared/types.ts           daemon ve arayüzün ortak tipleri
  shared/launchPolicy.ts    literal CLI uygunluğu ve açık UUID komutu
  shared/gridLayoutGuard.ts kayıtlı grid yerleşiminin kaynak sınırı
  shared/statePoll.ts       görünür istemcinin GET state döngüsü
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
    env.ts             Run ortamı izin listesi ve environment.json
    orphans.ts         salt okunur yetim çalışma kopyası keşfi
    repos.ts           klasör projesindeki alt Git depolarının sınırlı keşfi
    git.ts             worktree, HEAD OID, status, diff ve branch okuması
    fingerprint.ts     silme onayının içerik fingerprint'i ve bütçesi
  web/
    App.tsx            düzen, poll, oturum seçimi, sekmeler
    components/        Sidebar, SidebarShell, TerminalPane, TerminalGrid,
                       DiffView, NewSessionDialog, LaunchDialog,
                       GridLayoutDialog, ProtectedBranches
tests/                 node:test paketi (store, stop, kilit, dedup, API)
docs/                  spec, ADR'ler, doğrulama kapıları, ölçüm script'leri
```

## Neler yok

Bilinçli olarak MVP dışında bırakılanlar:

- Ajanlar arası iletişim / paylaşılan context (MCP katmanı)
- Dosya ağacı, kod editörü
- Görev adının ajana ilk prompt olarak geçmesi
- Otomatik PR açma, kanban
- Yeni masaüstü kabuğuna geçiş (mevcut Electron başlatıcı vardır)
- Uygulamadan branch silme (V0 dışıdır; branch her zaman korunur)

## Bilinen sınırlar

- **Daemon ölürse PTY'ler de ölür.** Worktree, branch, diff ve terminal
  görüntüsü diskte kalır. Daemon açılışında son checkpoint ve canlı çıktıdaki
  doğrulanmış “Resume…” footer'ı taranır. Claude, Codex, Gemini, Grok,
  OpenCode ve Antigravity açık bir konuşma kimliği verdiyse arşivsiz oturum
  aynı çalışma kopyasında doğrudan o konuşmayla yeniden açılır; `live`
  Run'lar için kimlik yoksa CLI seçicisi kullanılabilir. Genel komutlar ve
  kimliği olmayan bitmiş oturumlar otomatik çalışmaz. Başlatılamayan bir hedef
  bir kez denenir ve tekrar döngüsüne girmez. Sürecin daemon'dan bağımsız
  yaşaması isteniyorsa oturum sahipliği bir multiplexer'a (tmux) taşınmalıdır.
- **Terminal ürün kabulü açık.** Ekran/scrollback replay ve checkpoint uygulanmıştır;
  gerçek tarayıcı render, mouse/paste/IME ve yoğun çıktı kabulü yapılmadı.
  Oturum panosu önizleme API’sine bağlıdır. Proje ekleme, kabuk başlatma, terminal girdisi, diff, arama ve durdurma akışı gerçek Chromium üzerinde doğrulandı; arşiv, diff kapsamları, komut çalıştırma, önceki Run, branch paneli ve kademeli proje silme derlenmiş arayüzle Electron/Chromium duman testinden geçti. Ajan CLI’larının ürün kabulü ayrı kalır.
- **Geçmiş sınırlıdır.** En fazla son iki yazılmış Run görüntüsü tutulur; tam
  konuşma arşivi değildir.
- **Yönetilen konuşma devamı yok.** Konuşma CLI'ın kendi seçicisi komut olarak
  çalıştırılarak sürdürülür; AgentDeck konuşma kimliği üretmez. Yönetilen
  `fresh`/`resume`/`picker` [G2](docs/specs/agentdeck-v0-validation-gates.md)
  insan kabul testi geçmeden açılmaz; `launch` bunları reddeder.
- **Büyük klasör uygulamadan silinemez.** Bütçeyi aşan çalışma kopyası (ör. büyük
  `node_modules`) için onay üretilmez; dosyalar yerel araçla temizlenip tekrar
  denenir. Proje silmede bütçe bütün oturumlara paylaştırılır.
- Ortak oturumlarda yalnız dizin kimliği doğrulanır; proje dosyaları silinmez. Klasör
  oturumunda ajanın depo dışına yazdığı dosyalar silinmediği için onaya girmez. Dış
  programların onay ile kaldırma arasındaki yazımına dosya sistemi garantisi yoktur.
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
