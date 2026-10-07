import express from 'express'
import cors from 'cors'
import qrcode from 'qrcode'
import dotenv from 'dotenv'
import rateLimit from 'express-rate-limit'
import {
  getSession,
  getAllSessions,
  createSession,
  destroySession,
} from '../bot/agentManager.js'
import { decidePayment } from '../payment/proof.js'
import { playgroundReply } from '../ai/playground.js'

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())

// ─── Rate Limiters ───────────────────────────────────────────────────────────
// Helper buat limiter biar tidak repetitif
function makeLimiter(max, windowMs = 60_000, message = 'Terlalu banyak request, coba lagi dalam 1 menit.') {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,   // kirim header RateLimit-* ke client
    legacyHeaders: false,
    message: { error: message },
    skip: (req) => {
      // Skip rate limit kalau request datang dengan secret key yang benar
      // (artinya dari server Next.js kita sendiri, bukan dari luar)
      return req.headers['x-agent-secret'] === AGENT_SECRET_KEY
    }
  })
}

// Tiap endpoint punya limit berbeda sesuai sensitivitasnya
const limitConnect   = makeLimiter(5,  60_000, 'Terlalu banyak percobaan koneksi. Coba lagi dalam 1 menit.')   // 5x/menit
const limitDisconnect= makeLimiter(5,  60_000, 'Terlalu banyak percobaan disconnect. Coba lagi dalam 1 menit.') // 5x/menit
const limitBroadcast = makeLimiter(3,  60_000, 'Terlalu banyak broadcast. Coba lagi dalam 1 menit.')            // 3x/menit
const limitQR        = makeLimiter(30, 60_000, 'Terlalu banyak request QR. Coba lagi dalam 1 menit.')           // 30x/menit
const limitStatus    = makeLimiter(60, 60_000, 'Terlalu banyak request status. Coba lagi dalam 1 menit.')       // 60x/menit
const limitGlobal    = makeLimiter(100, 60_000, 'Terlalu banyak request. Coba lagi dalam 1 menit.')             // 100x/menit fallback
const limitPayment   = makeLimiter(30, 60_000, 'Terlalu banyak konfirmasi pembayaran. Coba lagi dalam 1 menit.') // 30x/menit

// ─── Secret Key Middleware ────────────────────────────────────────────────────
// Semua endpoint kecuali /api/health wajib menyertakan header:
// x-agent-secret: <nilai AGENT_SECRET_KEY di .env>
const AGENT_SECRET_KEY = process.env.AGENT_SECRET_KEY

function requireSecret(req, res, next) {
  // Kalau secret key belum dikonfigurasi, warn tapi tetap izinkan
  // (backward compat saat development)
  if (!AGENT_SECRET_KEY) {
    console.warn('⚠️  AGENT_SECRET_KEY belum diset di .env! API tidak diamankan.')
    return next()
  }

  const provided = req.headers['x-agent-secret']
  if (!provided || provided !== AGENT_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing secret key' })
  }

  next()
}

// ─── Health Check (publik, untuk monitoring) ──────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), sessions: getAllSessions().length })
})

// ─── Terapkan middleware secret + global rate limit ke semua route ──────────
app.use(limitGlobal)
app.use(requireSecret)

// ─── List semua session aktif (untuk admin/debug) ─────────────────────────────
app.get('/api/sessions', (req, res) => {
  res.json({ sessions: getAllSessions() })
})

// ─── Status koneksi WA per bisnis ────────────────────────────────────────────
app.get('/api/status/:businessId', limitStatus, (req, res) => {
  const { businessId } = req.params
  const session = getSession(businessId)

  if (!session) {
    return res.json({ status: 'not_started' })
  }

  res.json({ status: session.status })
})

// ─── QR Code untuk scan ──────────────────────────────────────────────────────
app.get('/api/qr/:businessId', limitQR, async (req, res) => {
  const { businessId } = req.params
  const session = getSession(businessId)

  if (!session) {
    return res.json({ qr: null, status: 'not_started' })
  }

  if (!session.qr) {
    return res.json({ qr: null, status: session.status })
  }

  try {
    const qrBase64 = await qrcode.toDataURL(session.qr)
    res.json({ qr: qrBase64, status: session.status })
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' })
  }
})

// ─── Mulai / buat session baru ────────────────────────────────────────────────
app.post('/api/connect/:businessId', limitConnect, async (req, res) => {
  const { businessId } = req.params

  try {
    await createSession(businessId)
    res.json({ success: true, message: `Session untuk ${businessId} sedang dimulai.` })
  } catch (err) {
    res.status(500).json({ error: 'Gagal membuat session', message: err.message })
  }
})

// ─── Disconnect / logout session ─────────────────────────────────────────────
app.post('/api/disconnect/:businessId', limitDisconnect, async (req, res) => {
  const { businessId } = req.params
  const { clearAuth = true } = req.body

  try {
    await destroySession(businessId, clearAuth)
    res.json({ success: true, message: `Session ${businessId} dihapus.` })
  } catch (err) {
    res.status(500).json({ error: 'Gagal disconnect', message: err.message })
  }
})

// ─── Broadcast State per Bisnis (Map, bukan global!) ─────────────────────────
// Map<businessId, { running, sent, failed, total }>
const broadcastStates = new Map()

function getBroadcastState(businessId) {
  if (!broadcastStates.has(businessId)) {
    broadcastStates.set(businessId, { running: false, sent: 0, failed: 0, total: 0 })
  }
  return broadcastStates.get(businessId)
}

// Dashboard memanggil lewat agent-proxy → /api/broadcast/:businessId (businessId sudah diverifikasi
// sebagai milik pengguna). businessId dari URL diutamakan; dari body hanya untuk pemanggilan lama.
app.post(['/api/broadcast/:businessId', '/api/broadcast'], limitBroadcast, async (req, res) => {
  const businessId = req.params.businessId || req.body?.businessId
  const { recipients, template } = req.body || {}

  // Validasi input
  if (!businessId || typeof businessId !== 'string') {
    return res.status(400).json({ error: 'businessId wajib diisi' })
  }
  if (!recipients?.length || !template?.trim()) {
    return res.status(400).json({ error: 'recipients dan template wajib diisi' })
  }
  // Batasi jumlah penerima per sekali broadcast
  if (recipients.length > 1000) {
    return res.status(400).json({ error: 'Maksimal 1000 penerima per broadcast' })
  }

  const session = getSession(businessId)
  if (!session || session.status !== 'connected') {
    return res.status(503).json({ error: 'Bot tidak terhubung ke WhatsApp. Hubungkan dulu di halaman Bot WhatsApp.' })
  }

  // Cek state broadcast untuk bisnis INI saja
  const state = getBroadcastState(businessId)
  if (state.running) {
    return res.status(409).json({ error: 'Broadcast sedang berjalan untuk bisnis ini, tunggu hingga selesai.' })
  }

  // Update state bisnis ini
  Object.assign(state, { running: true, sent: 0, failed: 0, total: recipients.length })
  res.json({ success: true, total: recipients.length })

  // Proses di background
  ;(async () => {
    try {
      for (const { number, name } of recipients) {
        if (!state.running) break

        // Sanitasi nomor
        const cleanNumber = String(number).replace(/@.*$/, '').replace(/\D/g, '')
        const isValidPhone = cleanNumber.length >= 10 && cleanNumber.length <= 15 && cleanNumber.startsWith('62')

        if (!isValidPhone) {
          console.log(`⚠️ [${businessId}] Skip nomor tidak valid: ${number}`)
          state.failed++
          continue
        }

        try {
          const currentSession = getSession(businessId)
          if (!currentSession || currentSession.status !== 'connected') {
            console.log(`⚠️ [${businessId}] Bot tidak terhubung, menunggu 5s...`)
            await new Promise(r => setTimeout(r, 5000))
            state.failed++
            continue
          }

          // Sanitasi template — batasi panjang & strip karakter berbahaya
          const safeTemplate = String(template).substring(0, 4096)
          const text = safeTemplate.replace(/\[Nama\]/gi, String(name || 'Kak').substring(0, 100))
          const jid = `${cleanNumber}@s.whatsapp.net`

          await Promise.race([
            currentSession.sock.sendMessage(jid, { text }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout 15s')), 15000))
          ])

          state.sent++
          console.log(`📤 [${businessId}] Broadcast → ${cleanNumber}: ${text.substring(0, 40)}...`)
        } catch (err) {
          state.failed++
          console.error(`❌ [${businessId}] Broadcast gagal ke ${cleanNumber}:`, err.message)
        }

        await new Promise(r => setTimeout(r, 2000))
      }
    } finally {
      state.running = false
      console.log(`📊 [${businessId}] Broadcast selesai: ${state.sent} berhasil, ${state.failed} gagal`)
    }
  })()
})

// ─── Status broadcast per bisnis ──────────────────────────────────────────────
app.get('/api/broadcast/status/:businessId', (req, res) => {
  const { businessId } = req.params
  res.json(getBroadcastState(businessId))
})

// Backward compat — status broadcast tanpa businessId (deprecated)
app.get('/api/broadcast/status', (req, res) => {
  res.json({ deprecated: true, message: 'Gunakan /api/broadcast/status/:businessId' })
})

// ─── Keputusan penjual atas pembayaran QRIS ──────────────────────────────────
// Dashboard → agent-proxy (sudah cek login & kepemilikan bisnis) → /api/payment/:businessId
// Body: { orderId, action: 'confirm' | 'reject' }. Lihat src/payment/proof.js.
app.post('/api/payment/:businessId', limitPayment, async (req, res) => {
  const { businessId } = req.params
  const { orderId, action } = req.body || {}
  if (typeof orderId !== 'string' || !['confirm', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'orderId dan action (confirm/reject) wajib diisi' })
  }
  try {
    const { status, body } = await decidePayment({ businessId, orderId, action, session: getSession(businessId) })
    res.status(status).json(body)
  } catch (err) {
    console.error(`❌ [${businessId}] /api/payment gagal:`, err?.message || err)
    res.status(500).json({ error: 'Gagal memproses pembayaran' })
  }
})

// ─── Uji coba chat (pratinjau di halaman Bot WhatsApp) ───────────────────────
// Dashboard → agent-proxy (cek login & kepemilikan) → /api/playground/:businessId
// Body: { messages, settings, instructions, closedTest }. Lihat src/ai/playground.js.
app.post('/api/playground/:businessId', async (req, res) => {
  const { businessId } = req.params
  const { messages, settings, instructions, closedTest } = req.body || {}
  try {
    const { status, body } = await playgroundReply({ businessId, messages, settings, instructions, closedTest: !!closedTest })
    res.status(status).json(body)
  } catch (err) {
    console.error(`❌ [${businessId}] /api/playground gagal:`, err?.message || err)
    res.status(500).json({ error: 'Uji coba gagal. Coba lagi.' })
  }
})

// ─── Start server ─────────────────────────────────────────────────────────────
export const startServer = () => {
  const port = process.env.PORT || 3001
  app.listen(port, () => {
    console.log(`🌐 Server API berjalan di port ${port}`)
    if (!AGENT_SECRET_KEY) {
      console.warn('⚠️  PERINGATAN: AGENT_SECRET_KEY belum diset! Set di .env untuk keamanan.')
    } else {
      console.log('🔒 API diamankan dengan AGENT_SECRET_KEY')
    }
  })
}
