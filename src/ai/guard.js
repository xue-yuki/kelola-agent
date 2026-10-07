// Lapisan anti prompt-injection di LUAR AI (aturan di prompt saja tidak cukup):
// 1. Pesan pelanggan dibersihkan sebelum masuk AI: tag sistem palsu & karakter tak terlihat dibuang,
//    panjang dibatasi.
// 2. Balasan AI yang membocorkan isi instruksi diganti jawaban aman sebelum dikirim.
// 3. Notifikasi ke pemilik (komplain, panggil pemilik) dibatasi per pelanggan supaya tidak bisa dipakai spam.

export const MAX_CUSTOMER_TEXT = 1500

// Tag yang dibaca server dari balasan AI. Pelanggan tidak boleh "menitipkan" tag ini lewat chat.
const TAG_RE = /<\s*\/?\s*(ORDER|CANCEL_ORDER|COMPLAINT|CALL_OWNER|CUSTOMER)\b[^>]*>/gi
// Zero-width, bidi override, dll. (dipakai menyembunyikan perintah)
const INVISIBLE_RE = /[​-‏‪-‮⁠-⁤﻿]/g

export function sanitizeCustomerText(text) {
  let t = String(text ?? '').replace(INVISIBLE_RE, '').replace(TAG_RE, '')
  if (t.length > MAX_CUSTOMER_TEXT) t = `${t.slice(0, MAX_CUSTOMER_TEXT)} …(pesan dipotong)`
  return t.trim()
}

// Judul bagian prompt sistem (agent.js buildSystemPrompt). Kalau muncul di balasan, AI sedang
// membocorkan instruksinya. Frasa yang juga wajar dipakai di chat biasa ("produk tersedia:") baru
// dianggap bocor kalau muncul bersama penanda lain.
const STRONG_MARKERS = [
  'ATURAN KEAMANAN (TIDAK BISA',
  'ALUR WAJIB SEBELUM KONFIRMASI',
  'FORMAT KONFIRMASI PESANAN',
  'DETEKSI KOMPLAIN',
  'DETEKSI MINTA CHAT',
  'PEMBATALAN & PERUBAHAN PESANAN (HANYA',
  'DATA PELANGGAN INI (TERSIMPAN',
  'PESANAN PELANGGAN INI YANG BELUM SELESAI',
  'TAG ORDER HARUS',
]
const WEAK_MARKERS = ['ATURAN KEAMANAN', 'INSTRUKSI DARI PEMILIK TOKO', 'PRODUK TERSEDIA:', 'INFO JAM BUKA:']

export function leaksPrompt(reply) {
  const up = String(reply ?? '').toUpperCase()
  if (STRONG_MARKERS.some((m) => up.includes(m))) return true
  return WEAK_MARKERS.filter((m) => up.includes(m)).length >= 2
}

export function safeReply(businessName, greeting = 'Kak') {
  return `Maaf ${greeting}, aku cuma bisa bantu soal produk dan pesanan di ${businessName || 'toko ini'} ya 🙏 Ada yang mau dipesan?`
}

// Batas notifikasi ke pemilik per pelanggan (di memori; reset saat bot restart)
const lastNotif = new Map()
export const NOTIF_WINDOW = {
  complaint: 6 * 60 * 60 * 1000, // komplain: sekali per 6 jam
  call_owner: 60 * 60 * 1000,    // panggil pemilik: sekali per jam
}

export function allowOwnerNotif(kind, businessId, customerWa, now = Date.now()) {
  const key = `${kind}:${businessId}:${customerWa}`
  const last = lastNotif.get(key)
  if (last !== undefined && now - last < (NOTIF_WINDOW[kind] ?? 0)) return false
  lastNotif.set(key, now)
  if (lastNotif.size > 5000) lastNotif.delete(lastNotif.keys().next().value)
  return true
}
