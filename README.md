# 🏐 Voleybol Kadro

WhatsApp anketi yerine: saat gelince "KATIL"a basan ilk 12 kişi sahaya çıkar, sıralama sunucu saatine göre milisaniyesiyle tutulur.

```bash
npm install
npm run dev          # http://localhost:3000
npm run build && npm start   # production
```

- Veriler bellekte, yeniden başlatmaya karşı `data.json` dosyasına yedeklenir.
- `PORT`, `DATA_FILE` ortam değişkenleri ayarlanabilir.
- Event linki: `/?e=<id>` (WhatsApp grubuna atılabilir).

## Yedekleme (deploy öncesi / sonrası)

Render ücretsiz planda her deploy'da veriler silinir. `ADMIN_KEY` ortam değişkeni (en az 8 karakter) tanımlıysa:

1. Deploy'dan önce `/admin.html` → anahtarı gir → **Yedeği indir**
2. Push et, deploy bitsin
3. `/admin.html` → aynı dosyayı seç → **Yedeği yükle**

Kısayol: `/api/export?key=ANAHTAR` adresi yedeği doğrudan indirir, `/admin.html?key=ANAHTAR` anahtarı otomatik doldurur. Anahtar `x-admin-key` başlığıyla da gönderilebilir.

**Admin modu:** Ana sayfaya `/?admin=ANAHTAR` ile girersen anahtar o cihazda saklanır, URL'den silinir ve her oylamayı (başkalarınınkini de) silebilir, "Tüm oylamaları sil" ile hepsini temizleyebilirsin. Üstteki şeritten "Admin modundan çık" ile kapatılır.

`ADMIN_KEY` tanımlı değilse `/api/export` ve `/api/import` kapalıdır. Yedek dosyasında herkesin kimlik anahtarı bulunur; paylaşma.
