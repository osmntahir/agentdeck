# Oturum portları, kullanım ve konuşma araması

Durum: accepted — 2026-09-26, `feat/ports-usage-search` dalında.

**Sorun.** Paralel worktree'lerde iki ajan aynı anda `npm run dev` çalıştırınca aynı porta çarpıyordu. Hangi oturumun hangi adreste yayın yaptığını görmek için terminal çıktısını okumak gerekiyordu. Bir konuşmanın ne kadar token harcadığı ve bağlamın ne kadar dolduğu ancak CLI'ın içinden görülebiliyordu. Eski bir konuşmayı bulmak için ilk ve son isteme bakmaktan başka yol yoktu; konuşmanın ortasında geçen bir cümle aranamıyordu.

**Karar 1 — Her oturuma sabit bir port ayrılır; Run'a `PORT` olarak verilir.** Port oturum açılırken 4800–5799 aralığından seçilir: kayıtlı oturumlara ayrılmamış ve o an boş olan ilk port. `Session.port` alanında kalır, sonraki Run'lar aynı portu alır. Port alanı eklenmeden önce açılmış oturum, ilk yeni Run'ında port alır. Ortama `PORT` ve `AGENTDECK_PORT` yazılır:
- `PORT` kullanıcının `environment.json` değeriyle ezilebilir. Daemon'ın kendi ortamındaki `PORT` hiçbir zaman taşınmaz.
- `AGENTDECK_PORT` her zaman ayrılan porttur (AGENTDECK_ öneki rezervdir).

Porta uymak programın kararıdır. Next.js, Express ve benzerleri uyar. Vite gibi kendi portunu seçenler uymaz, ama doluysa sonraki porta geçtiklerinden yine çakışmazlar.

**Karar 2 — Önizleme adresi ayrılan porttan değil, dinlenen porttan gelir.** Daemon, canlı Run'ların süreç ağacında LISTEN durumundaki TCP soketlerini Linux `/proc`'tan okur:
- `/proc/net/tcp{,6}` dinleyen soketlerin inode → port eşlemesini verir.
- Bir süreç, PTY liderinin oturumundaysa (`sid`) veya liderin soyundan geliyorsa o oturuma aittir. Ajanın arka plana atıp init'e bıraktığı sunucu da oturumda kaldığı için bulunur.
- Sürecin `/proc/<pid>/fd` bağlantıları soket inode'larını verir.

Tarama `/api/state` isteğinde en çok 2,5 sn'de bir, arka planda yapılır. Durum görünümü son sonucu okur ve beklemez. Sonuç `SessionView.ports`'ta durur ve kalıcı kayda yazılmaz. Sekme başlığı, ayrıntı görünümü ve oturum kartı her port için bir `:5173 ↗` bağlantısı gösterir. Bağlantı `http://localhost:<port>` adresini açar; masaüstü kabuğunda bu adres sistem tarayıcısında açılır.

**Karar 3 — Kullanım transcript'teki usage alanlarından okunur.** Konuşma özetini okuyan artımlı okuma, aynı geçişte her yanıtın `usage` alanını da toplar:
- Bir API yanıtı, içerik bloğu başına ayrı satıra yazılır ve her satır aynı usage'ı taşır. Bu yüzden aynı mesaj kimliği bir kez sayılır.
- Yan zincir (alt ajan) toplama girer ama bağlamı değiştirmez. `<synthetic>` mesajlar sayılmaz.
- 256 KiB'yi aşan satırlarda (büyük araç girdisi) usage, JSON çözülmeden, satırın sonundaki nesneden okunur.
- Bağlam, son ana-zincir isteğinin giriş, önbellek ve çıkış toplamıdır. Pencere büyüklüğü modelden bilinir; bilinmiyorsa yalnız token sayısı gösterilir.

**Karar 4 — Tutar, standart API fiyatıyla yapılmış bir tahmindir.** Fiyat tablosu `src/shared/usage.ts` içindedir. Önbellek okuma, modelin kendi fiyatıyla yoksa girişin onda biriyle hesaplanır; önbelleğe yazma 5 dk için 1,25x, 1 sa için 2x'tir. Hızlı mod yalnız fiyatı bilinen modellerde hesaba katılır. Fiyatı bilinmeyen modelin mesajı tutara eklenmez ve tutar `+` ile "eksik" diye işaretlenir. İpucu her yerde bunun abonelikte ödenen tutar olmadığını söyler. Tutar oturum kartında, işin başlığında (işin bütün konuşmaları) ve konuşma listesinde görünür. Canlı konuşmada sekme başlığı bir bağlam halkası gösterir; %60'ta sarıya, %85'te kırmızıya döner.

**Karar 5 — Konuşma araması daemon'da, bellekteki artımlı bir dizinle yapılır.** Arama kapsamı:
- Projelerin (alt klasörleri dahil) Claude transcript'leri.
- Oturum kayıtlarındaki konuşmalar; izole kopyalardakiler de dahil.

Aynı konuşmayı bir oturum kaydı tanıyorsa sonuç o oturuma bağlanır. İç içe projelerde (ev klasöründeki Genel gibi) konuşma en özel projeye düşer. Dizin yalnız kullanıcı istemlerini ve ajanın düz metin yanıtlarını tutar; araç çağrıları, çıktıları ve düşünce blokları aranmaz. Mesaj başına 4000, konuşma başına 256 KiB metin saklanır; sınır aşılınca en eski mesajlar düşer. Dizin diske yazılmaz.

Eşleşme için bütün terimler konuşmada geçmelidir. Büyük/küçük harf ve Türkçe işaretler yok sayılır ("odeme" "Ödeme"yi bulur). Katlama karakter başına yapılır ve uzunluğu korur, böylece vurgu özgün metinde doğru yere düşer. Sonuçlar önce en çok terimi içeren mesaja, sonra yeniliğe göre sıralanır; en çok 25 sonuç döner. Bir istek en çok 700 ms dizinler; yeni konuşmalar önce okunur. Yetişmeyen konuşma sayısı `pending`'de döner ve arayüz sonucu kendiliğinden tazeler.

**Karar 6 — Arama paletin içindedir.** `Ctrl+Shift+F` (terminal odaktayken de çalışır) paleti "Konuşmalar" kapsamında açar. Genel palet üç harften sonra en iyi dört konuşma sonucunu ve "Bütün konuşma sonuçları" satırını gösterir. Sonuçta başlık, rolüyle birlikte (Sen/Ajan) vurgulu parça, proje ve yaş yer alır. Eşleşme başlıktaki istemin kendisiyse vurgu başlığa taşınır, aynı metin iki kez yazılmaz. Enter açık konuşmada terminale geçer; diğerlerinde konuşmayı sürdürür. Boş sorguda ⌫ genel palete döner.

Bilinen sınırlar:
- Port gözlemi yalnız Linux'ta çalışır. `/proc` yoksa port listesi boş kalır; ayrılan port yine verilir.
- Programın kendi oturumunu açan (setsid) ve PTY liderinin soyundan kopan süreçleri bulunamaz.
- Kullanım ve arama yalnız Claude transcript'lerini okur. Codex ve Gemini oturumlarında gösterilmez.
- Hesap düzeyindeki abonelik sınırları transcript'te yoktur; "limite yaklaşıyor" uyarısı verilmez.
