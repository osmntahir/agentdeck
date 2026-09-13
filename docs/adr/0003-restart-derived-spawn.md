# Yeniden çalıştırma ile konuşmayı sürdürme ayrı eylemlerdir

Durum: accepted — 2026-09-12 revizyonu. “İlk koşu session-id, her sonraki koşu resume” ve bayrak düşürme kararları yürürlükten kaldırıldı.

Her eylem aynı Session/worktree/baseCommit üzerinde yeni Run oluşturur. Restart en son açıkça seçilmiş launch niyetini tekrarlar; fresh türünde her başarılı yeni Run denemesi yeni konuşma kimliği alır, resume türünde hedef kimlik korunur. PTY doğması konuşma oluştu anlamına gelmez. Başarısız veya kayıp konuşmada sessiz fresh fallback yoktur; “Aynı dosyalarla yeni konuşma” her zaman bilinçli çıkış yoludur. “Bu çalışma kopyasında komut çalıştır” genel yoluyla CLI seçicisi veya başka ajan da kullanılabilir; model arası konuşma aktarımı vaat edilmez.

V0'da konuşmayı sürdürmenin varsayılan yolu **CLI'ın kendi etkileşimli seçicisidir**; üçünde de ölçülüp çalıştığı görüldü ve bu yol AgentDeck'in kimlik üretmesini gerektirmez. AgentDeck'in ürettiği kimlikle resume, bir CLI+sürüm çifti için ancak insan trust/auth kabul testi geçtikten sonra açılır; o zamana kadar kapalıdır. Kullanıcının kendi verdiği açık kimlik her zaman kabul edilir. Rollout dosyalarını cwd/en yeni dosya ile otomatik eşleştirme V0'da bilinçli olarak kullanılmaz: aynı worktree'de birden çok Run, iç CLI konuşması veya dış süreç olabilir. Kullanıcı auth/config evleri değiştirilmez.

Terminal artefaktları Run kimliğiyle tutulur; başarısız yeni çalıştırma önceki çıktıyı hemen yok etmez. [Spec](../specs/agentdeck-v0.md#3-başlatma-devam-etme-ve-ortam).

Uygulama güncellemesi (13 Eylül 2026): komut diyaloğunda “Konuşma kimliğiyle
sürdür” alanı vardır. Kullanıcı CLI ve tam UUID'yi seçer; “Komuta aktar” veya
UUID alanında Enter yalnız incelenebilir literal komutu hazırlar. Yeni Run ancak
ayrı “Çalıştır” eylemiyle başlar. Ad/yol/latest/kabuk ifadeleri UUID alanından
geçmez; serbest komut alanı değişmez. Başarılı çalıştırma `lastLaunch.command`
olarak kaydedilir; yönetilen `resume` veya otomatik kimlik üretimi değildir.

Odak çubuğu (13 Eylül): açık UUID lastLaunch konuşma adayıdır ve “konuşmayı
sürdür” birincil olur; `lastLaunch.mode = fresh` ise “yeniden çalıştır”
gizlenir çünkü restart aynı literal CLI'yı tekrarlar. Canlı işte eylemler
durdurmayı söyler. cwd yokken yeni Run düğmeleri kapanır.

Restart, kayıttaki lastLaunch niyetini tekrarlar ve UUID üretmez: fresh
yine literal CLI, picker yine seçici, command yine aynı program. `mode =
resume` V0'da üretilmez.

Tamamlama doğrulaması (13 Eylül 2026): fresh/picker niyetleri kayda ve restart'a
bağlandı. Desteklenmeyen eski CLI veya geçersiz resume kimliği başlangıç
Command'ına düşmez: restart `launch_unavailable` ile, mevcut süreç durdurulmadan
reddedilir. Arayüz bu restart'ı sunmaz; açık komut seçimi erişilebilir kalır.
Fresh tekrarında önceki konuşma adayı yeni Run'a taşınmaz. Bu uygulama kapsamı
kapandı; yönetilen UUID üretimi ve gerçek CLI trust/auth kabulü G2'de açıktır.
