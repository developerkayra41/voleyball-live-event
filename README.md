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
