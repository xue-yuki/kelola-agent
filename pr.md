# 📋 Product Roadmap — kelola-agent

> Daftar PR dan improvement berikutnya setelah multi-agent refactor & security hardening selesai.
> Diurutkan berdasarkan prioritas dan dampak.

---

## 🔴 Priority 1 — Critical (Segera)

### PR-01: Named Cloudflare Tunnel (Permanent URL)
**Problem:** URL tunnel berubah setiap kali server reboot.
**Solution:** Setup Named Cloudflare Tunnel setelah domain dibeli.
**Steps:**
- `cloudflared tunnel login`
- `cloudflared tunnel create kelola-agent`
- Update `ecosystem.config.cjs` pakai `tunnel run` bukan `--url`
- Update `NEXT_PUBLIC_AGENT_URL` di `kelola.ai`

---

### PR-02: Rate Limiting
**Problem:** API bisa di-spam request berkali-kali (DoS ringan).
**Solution:** Tambah `express-rate-limit` di `server.js`.
```
- /api/connect/:id → max 5 request/menit per IP
- /api/broadcast   → max 3 request/menit per businessId
- /api/qr/:id      → max 30 request/menit per IP
```
**Package:** `npm install express-rate-limit`

---

### PR-03: Message Queue per Customer
**Problem:** Kalau 1 customer kirim 5 pesan sekaligus, AI akan proses 5 pesan secara paralel → race condition, reply kacau.
**Solution:** Queue per `customerWa` — proses satu per satu, antrian yang lain tunggu.
```js
// Map<businessId:customerWa, Promise>
const processingQueue = new Map()
```

---

### PR-04: Graceful Shutdown
**Problem:** Saat `pm2 restart`, ada pesan yang sedang diproses AI → terpotong di tengah jalan.
**Solution:** Handle `SIGTERM` — tunggu semua AI request selesai sebelum shutdown.
```js
process.on('SIGTERM', async () => {
  await waitForActiveRequests()
  process.exit(0)
})
```

---

## 🟡 Priority 2 — Important (Bulan Ini)

### PR-05: Dukungan Pesan Media (Gambar/Dokumen)
**Problem:** Agent sekarang hanya bisa balas teks. Kalau customer kirim foto produk rusak untuk komplain, agent tidak bisa membaca.
**Solution:** Extract caption dari pesan gambar, proses sebagai teks.
```js
const text = msg.message?.conversation
  || msg.message?.extendedTextMessage?.text
  || msg.message?.imageMessage?.caption  // ← tambahkan ini
  || msg.message?.documentMessage?.caption
  || ''
```

---

### PR-06: Business Hours (Jam Operasional)
**Problem:** AI balas pesan 24 jam, padahal owner mungkin hanya buka toko jam 08.00–22.00.
**Solution:** Tambahkan field `business_hours` di tabel `businesses`. Di luar jam operasional, balas dengan pesan otomatis.
```
"Halo! Toko kami sedang tutup. Jam operasional kami 08.00–22.00 WIB. 
Pesan Kakak akan kami balas saat toko buka kembali 🙏"
```

---

### PR-07: Human Handover Mode
**Problem:** Ada kasus yang AI tidak bisa handle (komplain berat, negosiasi harga, dll).
**Solution:** Tambahkan command `/takeover` dari HP owner → AI berhenti balas untuk customer itu selama X menit.
```js
// Simpan di Supabase atau memory Map
const humanHandoverMap = new Map() // Map<businessId:customerWa, expiryTime>
```

---

### PR-08: Session Health Monitor
**Problem:** Kadang WA session "zombie" — PM2 bilang online tapi socket sebenarnya mati diam-diam.
**Solution:** Ping test setiap 5 menit per session. Kalau tidak respond, auto-reconnect.
```js
setInterval(async () => {
  for (const [bizId, session] of sessions) {
    if (session.status === 'connected' && !session.sock?.user) {
      console.log(`💀 [${bizId}] Zombie session detected, reconnecting...`)
      await createSession(bizId)
    }
  }
}, 5 * 60 * 1000)
```

---

## 🟢 Priority 3 — Nice to Have (Bulan Depan)

### PR-09: Structured Logging dengan Pino
**Problem:** Log sekarang hanya `console.log` — susah difilter dan di-search.
**Solution:** Ganti ke `pino` dengan level logging dan format JSON.
```js
import pino from 'pino'
const log = pino({ level: process.env.LOG_LEVEL || 'info' })
log.info({ businessId, customerWa }, 'Message received')
```

---

### PR-10: Multi-Model AI Support
**Problem:** Semua bisnis pakai model yang sama (`gemini-2.0-flash`).
**Solution:** Tambah field `ai_model` di tabel `businesses`. Tiap bisnis bisa pilih model sendiri (Gemini Flash, GPT-4o, Claude, dll).
```js
const model = business.ai_model || 'google/gemini-2.0-flash-001'
```

---

### PR-11: Webhook Notifikasi ke Owner
**Problem:** Notifikasi order/komplain sekarang hanya via WA ke nomor owner. Kalau owner pakai HP lain, tidak ada notifikasi.
**Solution:** Tambah endpoint webhook — saat ada order/komplain baru, POST ke URL yang didaftarkan owner (bisa Telegram, Discord, dll).
```js
// Di businesses table: webhook_url
await fetch(business.webhook_url, {
  method: 'POST',
  body: JSON.stringify({ type: 'order', data: order })
})
```

---

### PR-12: Backup & Restore Auth Sessions
**Problem:** Kalau server pindah atau storage rusak, semua auth session hilang → semua bisnis harus scan QR ulang.
**Solution:** Backup folder `auth/` ke Supabase Storage secara berkala (setiap jam).
```
auth/<businessId>/creds.json → supabase storage: wa-auth/<businessId>/creds.json
```

---

### PR-13: Coolify Deployment
**Problem:** Sekarang deploy masih manual via SSH + git pull.
**Solution:** Setup Coolify di VPS (setelah upgrade ke cloud VPS) untuk CI/CD otomatis.
```
Git push → Coolify auto-build → Deploy tanpa downtime
```

---

### PR-14: Anti-Spam Protection
**Problem:** Kalau satu nomor kirim 100 pesan dalam 1 menit, server bisa overload + token usage meledak.
**Solution:** Rate limit per customerWa — max 10 pesan/menit. Kalau lebih, diabaikan atau balas pesan throttle.

---

### PR-15: Dashboard Admin Agent
**Problem:** Tidak ada cara untuk melihat semua session aktif, disconnect paksa, atau monitor kesehatan agent dari UI.
**Solution:** Tambah halaman admin di `kelola.ai` yang hanya bisa diakses `ADMIN_EMAILS`:
```
/admin/agent
├── List semua session aktif
├── Status per bisnis
├── Force reconnect
├── View live logs
└── Memory & CPU usage
```

---

## 📊 Summary Prioritas

| PR | Nama | Prioritas | Estimasi |
|----|------|-----------|----------|
| PR-01 | Named Cloudflare Tunnel | 🔴 Critical | 30 menit (setelah beli domain) |
| PR-02 | Rate Limiting | 🔴 Critical | 1 jam |
| PR-03 | Message Queue per Customer | 🔴 Critical | 2 jam |
| PR-04 | Graceful Shutdown | 🔴 Critical | 1 jam |
| PR-05 | Dukungan Pesan Media | 🟡 Important | 2 jam |
| PR-06 | Business Hours | 🟡 Important | 3 jam |
| PR-07 | Human Handover Mode | 🟡 Important | 4 jam |
| PR-08 | Session Health Monitor | 🟡 Important | 2 jam |
| PR-09 | Structured Logging | 🟢 Nice to Have | 1 jam |
| PR-10 | Multi-Model AI Support | 🟢 Nice to Have | 2 jam |
| PR-11 | Webhook Notifikasi | 🟢 Nice to Have | 3 jam |
| PR-12 | Backup Auth Sessions | 🟢 Nice to Have | 3 jam |
| PR-13 | Coolify Deployment | 🟢 Nice to Have | 2 jam |
| PR-14 | Anti-Spam Protection | 🟢 Nice to Have | 2 jam |
| PR-15 | Dashboard Admin Agent | 🟢 Nice to Have | 1 hari |

---

> Last updated: 2026-05-29
