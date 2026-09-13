# Command niyeti korur; CLI yetenekleri dar ve açık kalır

Durum: accepted — 2026-09-12 revizyonu. Genel komuta exec öneki veya otomatik kimlik bayrağı ekleme tarifi yürürlükten kaldırıldı.

Session Command string|null tutar; preset kimliği taşımaz. Genel string Bash programı olarak aynen çalışır. Küçük LaunchPolicy modülü yalnız izin listesindeki tam çağrılara ek konuşma eylemleri sunar; genel kabuk programını parçalı dönüştürmez. V0 izin listesi yalnız argümansız, env/wrapper/yönlendirme içermeyen literal claude, gemini veya codex çağrısıdır. Bayraklı komutlar, mutlak yol veya alias dahil diğerleri geçerli serbest komut olarak aynen çalışır; destekleri CLI özellikleriyle zaman içinde açıkça genişletilebilir.

Başlangıç Command değişmez; kullanıcının aynı çalışma kopyasında seçtiği yeni Run programı ayrı lastLaunch kaydıdır. Restart lastLaunch'ı tekrarlar, yeni konuşma veya resume ayrı açık eylemdir. Büyük bir ajan adaptör çatısı yoktur; komut uygunluğu ve spawn üretimi tek test edilebilir sınırdadır. Ayrıntılar [spec](../specs/agentdeck-v0.md#3-başlatma-devam-etme-ve-ortam).

Uygulama güncellemesi (13 Eylül 2026): `shared/launchPolicy.ts` literal CLI
uygunluğunu ve kullanıcının açık UUID'sinden komut üretimini tek sınırda tutar.
Komut diyaloğu seçici kısayollarını aynı tanımdan okur. Genel komut aynen
çalışmaya devam eder; bu modül sürüm doğrulaması veya yönetilen kimlik desteği
iddia etmez. Yönetilen eylemlerin destek matrisi G2 kabulünden sonra açılacaktır.

Odak çubuğu (13 Eylül): `sessionWorkActions` spec §3 sırasını üretir. Tanınan
CLI konuşma eylemlerini **son başarılı Run** belirler (başlangıç Command'ı
değil). “Konuşmayı sürdür” seçici komutudur ve `lastLaunch.mode = picker`
yazılır; “aynı dosyalarla yeni konuşma” literal komuttur ve `mode = fresh`
(`conversationId: null`) yazılır. Aynı sonucu veren düğme yinelenmez.
`mode = resume` (yönetilen kimlik) G2 geçmeden 400 `mode_unsupported` kalır;
kullanıcının açık UUID'si komut diyaloğundan `mode = command` olarak gider.
Sürüm sondası yoktur; tanınan CLI'da “yönetilen konuşma devamı doğrulanmadı”
bilgisi görünür.

V0 uygulama kapsamı doğrulandı (13 Eylül 2026): literal komut, açık UUID,
fresh/picker kaydı ve son başarılı Run'a göre eylem sunumu tamamlandı.
[268 test ve Chromium kanıtı](../specs/agentdeck-v0-validation-gates.md)
uygulama kapanışını destekler. Sürüm sondası/destek matrisi ve yönetilen UUID
üretimi G2'ye bağlı ayrı kapsam olarak açık kalır.
