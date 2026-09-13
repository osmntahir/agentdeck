# Terminal temsili: uygulama sınırları

Durum: uygulandı; gerçek tarayıcı/CLI ürün kabulü açık — 13 Eylül 2026.

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
salt okunur WS inspection mümkündür. **Önceki Run seçicisi henüz arayüzde yoktur**;
aynı dosyalarda launch eylemleriyle §8/4'te bağlanacaktır. Grid kartları henüz
preview API'sine bağlanmamıştır (§8/5). CLI managed fresh/resume açılmadı.

## Kanıt ve açık kabul

Otomatik testler: terminal engine, checkpoint doğrulama, worker/host,
WebSocket/API ve tarayıcı protokol tüketicisi. Eksik parça, sıra boşluğu, yanlış
kimlik/format, son write callback'inden önce input, kontrol devri, eski Run,
worker kaybı ve kapanış/flush yarışı kapsanır.

Bu turda bağlı tarayıcı bulunamadığı için gerçek tarayıcı smoke testi yapılmadı.
Piksel/font, mouse/paste/IME, >1 MiB renkli replay'in gerçek tarayıcı tüketim
hızı, 4–8 gerçek CLI ve 32 PTY ürün yük kabulü açıktır. G1'in önceki sentetik
ölçümleri bu yeni runtime için otomatik ürün kabulü sayılmaz. G3/G4 kutuları
bu nedenle topluca kapatılmaz.

Son doğrulama (13 Eylül): `npm test` 158/158; `npm run typecheck` ve `npm run build` başarılı. Derlenmiş worker + gerçek WS + ortak istemci tüketicisi üzerinden input, scrollback ve stop smoke testi geçti. Bu headless entegrasyon kanıtıdır, tarayıcı render kabulü değildir.

İnceleme düzeltmeleri (13 Eylül): başarısız spawn/commit'in önceki Run checkpoint'ini budaması, durum yoklamasının açık Run'ın checkpoint durumunu düşürebilmesi, 1 MiB'yi aşan geçerli replay'in istemcide kesilmesi ve biçimsiz runId'nin "okunamadı" etiketi düzeltildi; her biri önce kırmızı görülen regresyon testiyle kapsandı. `npm test` 166/166, `npm run typecheck` başarılı.
