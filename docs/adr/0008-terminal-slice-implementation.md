# Terminal temsili: uygulama sınırları

Durum: accepted — 13 Eylül 2026. Gerçek tarayıcı/CLI ürün kabulü G4'te açık.

## Kapsam

Spec §8/3 için Run başına headless xterm, ayrı worker, FIFO ve tur bütçesi,
PTY high/low-water baskısı, güvenli kontrol dizisi kesimi, sorgu ayıklama,
ekran/scrollback replay katmanları, viewport preview ve atomik checkpoint eklendi.
Headless ve serialize paketleri üretim bağımlılığıdır. Tarayıcı yalnız odakta bir
xterm tutar; diff'e geçince bırakır ve geri dönünce daemon ekranından kurar.

Kontrol lease'i Run'a bağlıdır. İlk live attach kontrol alır; başka izleyici
ancak açık “Kontrolü al” ile generation değiştirir. Eski generation veya eski
Run bağlantısından gelen input/resize kabul edilmez. Sunucu otomatik terminal
cevaplarını kullanıcı aktivitesi saymaz. DECRQSS ve ANSI/private DECRQM dahil
cevap üreten sorgular izleyici akışından çıkarılır.

## Prefix sözleşmesinin netleştirilmesi

Önceki §4 metni yarım prefix'in ayrı alanla hemen tarayıcıya verilmesini
istiyordu. Uygulama **prefix'i yalnız daemon'da bekletir**: henüz headless'a
verilmemiş prefix snapshot'a veya tarayıcıya hiç girmez. Sonraki parça diziyi
tamamlayınca prefix + devam birlikte headless'a uygulanır; sorgu ayıklandıktan
sonra bütün izleyicilere aynı tamamlanmış devam verilir. Böylece yeni attach
ile kesintisiz izleyici aynı parser sınırındadır ve yarım sorgu tarayıcıya sızmaz.
4096 bayt sınırı korunur; aşılması temsil hatasıdır. BEL yalnız OSC'yi bitirir;
DCS içindeki BEL snapshot sınırı olamaz. Kesintisiz referans karşılaştırmaları
`terminalState.test.ts` içindedir. Bu karar ADR 0004'ün ayrı prefix aktarımı
ifadesini günceller; görüntünün tek kaynağı değişmez.

## Kapanış ve kayıt

Eşzamanlı close çağrıları aynı tamamlanma sözünü bekler. Devam eden periyodik
flush bitmeden son checkpoint yazılmaz. Stop, çıkış kaydı ve terminal kapanışını
bekler; eski flush yeni Run'a yazamaz. Worker kaybı bekleyen resize/close
isteklerini sonlandırır; duraklatılan PTY serbest bırakılır, temsil hatası açıkça
bildirilir. Checkpoint yazma hatası PTY'yi öldürmez; state metadata'sı ve arayüz
son kayıt zamanı/hatasını gösterir. Fsync/güç kaybı garantisi yoktur.

Son iki Run checkpoint'i tutulur; saklama sınırı yalnız **kayda girmiş** Run yayımlandığında uygulanır. Spawn veya state commit'i başarısız olan Run'ın görüntüsü önceki Run'ların kayıtlarını budayamaz ve atılır; kayda hiç girmemiş oturum için `terminal/` dizini kalmaz. Güncel veya bilinen eski runId ile
salt okunur WS inspection mümkündür. Önceki Run seçicisi §8/4'te terminal sekmesine
bağlandı ([ADR 0011](0011-work-result-slice-implementation.md)). Kart önizlemesi ve
odak/poll §8/5'te bağlandı ([ADR 0012](0012-scan-focus-poll-implementation.md)).
CLI managed fresh/resume açılmadı.

## Kanıt ve açık kabul

Otomatik testler: terminal engine, checkpoint doğrulama, worker/host,
WebSocket/API ve tarayıcı protokol tüketicisi. Eksik parça, sıra boşluğu, yanlış
kimlik/format, son write callback'inden önce input, kontrol devri, eski Run,
worker kaybı ve kapanış/flush yarışı kapsanır.

Piksel/font, mouse/paste/IME, >1 MiB renkli replay'in gerçek tarayıcı tüketim
hızı ve 4–8 gerçek CLI kabulü G4'te açıktır. G1'in önceki sentetik ölçümleri
bu runtime için otomatik ürün kabulü sayılmaz.

Çöküşte iki Run checkpoint'inin ayakta kalması, yarım tmp'nin Run sayılmaması
ve eksik/okunamayan geçmişin ayrı mesajı [ADR 0013](0013-durability-slice-implementation.md)
ile ölçüldü.

Son doğrulama (13 Eylül): `npm test`; `npm run typecheck` ve `npm run build`.
Derlenmiş arayüzde Chromium duman testi ve headless WS entegrasyonu vardır;
bu tarayıcı render kabulü değildir.

İnceleme düzeltmeleri (13 Eylül): başarısız spawn/commit'in önceki Run checkpoint'ini budaması, durum yoklamasının açık Run'ın checkpoint durumunu düşürebilmesi, 1 MiB'yi aşan geçerli replay'in istemcide kesilmesi ve biçimsiz runId'nin "okunamadı" etiketi düzeltildi; her biri önce kırmızı görülen regresyon testiyle kapsandı. `npm test` 166/166, `npm run typecheck` başarılı.
