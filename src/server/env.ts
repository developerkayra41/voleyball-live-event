// Proje kökündeki .env dosyasını (varsa) ortam değişkenlerine yükler.
// Diğer modüller process.env'i import anında okuduğu için index.ts'de EN ÜSTTE import edilmeli.
// Render'da .env yoktur; orada değişkenler panelden gelir, bu yüzden dosya yoksa sessizce geçilir.
try {
  process.loadEnvFile(".env");
} catch {
  /* .env yok: sorun değil */
}
