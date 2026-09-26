# Hazır istemler, istem kuyruğu ve tekrar tespiti

Durum: accepted — 2026-09-26, `feat/ports-usage-search` dalında. [ADR 0018](0018-works-and-conversation-tracking.md) Karar 2'deki kancayı iki olaya daha kurar.

**Sorun.** Kullanıcı aynı istemleri tekrar tekrar yazıyordu: "testleri çalıştır, kırılanları düzelt", ardından "commit et", ardından "PR aç". Ajan bir işi bitirmeden sıradakini vermek için terminal başında beklemek gerekiyordu. Başka sekmeye geçince ajan boşta kalıyordu. Hangi istemlerin tekrarlandığını AgentDeck biliyordu, çünkü konuşma transcript'lerini zaten okuyordu, ama bunu kullanmıyordu.

**Karar 1 — Ajanın turu Claude kancalarından okunur.** ADR 0018'deki kanca komutu değişmeden `UserPromptSubmit` ve `Stop` olaylarına da kurulur. Kurulum kuralları aynıdır:
- Okunamayan ayar dosyasına dokunulmaz.
- Kullanıcının diğer kancaları korunur.
- İşaret metnini taşıyan eski giriş güncellenir.

Olay türü `hook_event_name`'den okunur; adı olmayan olay eski kanca sürümünün SessionStart girdisidir. Tur yalnız bellekte tutulur ve Run'a bağlıdır:
- `UserPromptSubmit` çalışıyor demektir.
- `Stop` ve `SessionStart` bekliyor demektir.

`SessionView.agentTurn`, turu yalnız ön plandaki program Claude ise gösterir (süreç ağacından okunan ön plan ajanı). Claude'dan çıkılıp kabuğa dönüldüyse, son olay Stop olsa da tur `null`'dur.

**Karar 2 — İstem kuyruğu tur bitince sıradakini gönderir.** Kuyruk oturum kaydındadır (`Session.promptQueue`) ve daemon yeniden başlasa da kalır. Stop olayından 1,2 sn sonra ilk istem gönderilir. Bu süre, TUI'nin girdi kutusuna dönmesi ve ekrandaki soru/onay tespitinin (900 ms sessizlik) yetişmesi içindir. Gönderim anında bütün koşullar yeniden denetlenir:
- Canlı Run var ve tur bekliyor.
- Ön plandaki program Claude.
- Ekranda onay veya soru yok.
- Kuyruk duraklatılmamış (`queuePaused`).

Koşullardan biri tutmazsa hiçbir şey yazılmaz. Metin asla kabuğa veya başka bir programa gitmez. Gönderim, inceleme notlarıyla aynı yoldan yapılır: bracketed paste, ardından Enter. İstem kuyruktan önce kayıtta düşer, sonra yazılır; tur hemen "çalışıyor" sayılır ve ikinci istem üst üste gitmez. Claude o an bekliyorsa eklenen istem hemen gider. Kuyrukta en çok 50 istem durur.

**Karar 3 — Hazır istem bir veya birkaç adımdır.** `SavedPrompt { id, name, steps[], uses, lastUsedAt }` kalıcı kaydın `prompts` alanındadır. Gönderilince bütün adımları sırayla kuyruğa girer, yani çok adımlı bir hazır istem küçük bir otomasyondur. Kullanım sayısı paletteki sırayı belirler. Hazır istem 1–12 adım, adım başına en çok 8000 karakterdir.

**Karar 4 — Tekrar tespiti transcript'lerden yapılır ve yalnız öneridir.** Konuşma aramasının dizini (ADR 0023) kullanıcı istemlerini de verir. İstemler katlanıp noktalamadan arındırılır. Kelime kümesi en az %65 örtüşen istemler aynı sayılır; gösterilen metin en yeni yazılıştır. İki tür öneri çıkar:
- **Tek istem:** en az 3 kez, en az 2 farklı konuşmada yazılmış olmalı.
- **İstem dizisi:** arka arkaya yazılan 2–3 istem, en az 2 konuşmada aynı sırayla geçmiş olmalı. Daha uzun bir önerinin parçası olan dizi ayrıca önerilmez.

Kısa ("devam", "evet") ve 600 karakterden uzun istemler sayılmaz. Kayıtlı bir hazır istemle aynı olan öneri gösterilmez. Hiçbir şey kullanıcı kaydetmeden otomatikleşmez.

**Arayüz.**
- Sekme başlığındaki ve ayrıntı görünümündeki sıra düğmesi, yalnız ön planda Claude varken veya kuyruk doluyken görünür. Kuyruk doluyken istem sayısını gösterir; duraklatılmış veya yanıt bekleyen kuyrukta sarıya döner.
- Sıra penceresi şunları gösterir: durum (çalışıyor, bekliyor, yanıtını bekliyor, duraklatıldı), sıralı liste, yazma alanı ve tek tıkla sıraya eklenen hazır istemler. Enter ekler. Metin hemen temizlenir, böylece art arda yazılan istemler birbirini beklemez; istek başarısız olursa metin geri gelir.
- "Hazır istemler" penceresi kayıtlıları (gönder, düzenle, sil) ve "Sık tekrarladıkların" önerilerini gösterir. Öneriyi kaydetmek, adı ilk kelimelerden önerilen bir düzenleyici açar.
- Palet, odaktaki oturum için en sık kullanılan üç hazır istemi, arama yapılınca hepsini gösterir.

Bilinen sınırlar:
- Tur ve kuyruk yalnız Claude'da çalışır; Codex ve Gemini'nin karşılık gelen kancası yoktur.
- Kanca kurulmadan önce açılmış Claude süreçleri tur bildirmez. Kuyruk, o süreç yeniden başlayana kadar göndermez.
- Kullanıcı Esc ile turu keserse Stop gelmeyebilir. Kuyruk, sonraki istemin turu bitince devam eder.
- Claude son mesajında soru soruyorsa ekrandaki soru tespiti kuyruğu tutar. Tespit kaçırırsa sıradaki istem soruya yanıt yerine gider. Riskli adımlar için kuyruk duraklatılabilir.
