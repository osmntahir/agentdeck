# Yeniden çalıştırma ile konuşmayı sürdürme ayrı eylemlerdir

Durum: accepted — 2026-09-12 revizyonu. “İlk koşu session-id, her sonraki koşu resume” ve bayrak düşürme kararları yürürlükten kaldırıldı.

Her eylem aynı Session/worktree/baseCommit üzerinde yeni Run oluşturur. Restart en son açıkça seçilmiş launch niyetini tekrarlar; fresh türünde her başarılı yeni Run denemesi yeni konuşma kimliği alır, resume türünde hedef kimlik korunur. PTY doğması konuşma oluştu anlamına gelmez. Başarısız veya kayıp konuşmada sessiz fresh fallback yoktur; “Aynı dosyalarla yeni konuşma” her zaman bilinçli çıkış yoludur. “Bu çalışma kopyasında komut çalıştır” genel yoluyla CLI seçicisi veya başka ajan da kullanılabilir; model arası konuşma aktarımı vaat edilmez.

V0'da konuşmayı sürdürmenin varsayılan yolu **CLI'ın kendi etkileşimli seçicisidir**; üçünde de ölçülüp çalıştığı görüldü ve bu yol AgentDeck'in kimlik üretmesini gerektirmez. AgentDeck'in ürettiği kimlikle resume, bir CLI+sürüm çifti için ancak insan trust/auth kabul testi geçtikten sonra açılır; o zamana kadar kapalıdır. Kullanıcının kendi verdiği açık kimlik her zaman kabul edilir. Rollout dosyalarını cwd/en yeni dosya ile otomatik eşleştirme V0'da bilinçli olarak kullanılmaz: aynı worktree'de birden çok Run, iç CLI konuşması veya dış süreç olabilir. Kullanıcı auth/config evleri değiştirilmez.

Terminal artefaktları Run kimliğiyle tutulur; başarısız yeni çalıştırma önceki çıktıyı hemen yok etmez. [Spec](../specs/agentdeck-v0.md#3-başlatma-devam-etme-ve-ortam).
