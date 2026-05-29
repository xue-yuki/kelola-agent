import express from 'express'
import cors from 'cors'
import qrcode from 'qrcode'
import {
  getSession,
  getAllSessions,
  createSession,
  destroySession,
} from '../bot/agentManager.js'

const app = express()
app.use(cors())
app.use(express.json())

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), sessions: getAllSessions().length })
})

// ─── List semua session aktif (untuk admin/debug) ─────────────────────────────
app.get('/api/sessions', (req, res) => {
  res.json({ sessions: getAllSessions() })
})

// ─── Status koneksi WA per bisnis ────────────────────────────────────────────
app.get('/api/status/:businessId', (req, res) => {
  const { businessId } = req.params
  const session = getSession(businessId)

  if (!session) {
    return res.json({ status: 'not_started' })
  }

  res.json({ status: session.status })
})

// ─── QR Code untuk scan ──────────────────────────────────────────────────────
app.get('/api/qr/:businessId', async (req, res) => {
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
app.post('/api/connect/:businessId', async (req, res) => {
  const { businessId } = req.params

  try {
    await createSession(businessId)
    res.json({ success: true, message: `Session untuk ${businessId} sedang dimulai.` })
  } catch (err) {
    res.status(500).json({ error: 'Gagal membuat session', message: err.message })
  }
})

// ─── Disconnect / logout session ─────────────────────────────────────────────
app.post('/api/disconnect/:businessId', async (req, res) => {
  const { businessId } = req.params
  const { clearAuth = true } = req.body // default: hapus auth (full logout)

  try {
    await destroySession(businessId, clearAuth)
    res.json({ success: true, message: `Session ${businessId} dihapus.` })
  } catch (err) {
    res.status(500).json({ error: 'Gagal disconnect', message: err.message })
  }
})

// ─── Broadcast ────────────────────────────────────────────────────────────────
let broadcastState = { running: false, sent: 0, failed: 0, total: 0, businessId: null }

app.post('/api/broadcast', async (req, res) => {
  const { businessId, recipients, template } = req.body
  // businessId: string
  // recipients: [{ number: string, name: string }]
  // template: string (boleh pakai [Nama])

  const session = getSession(businessId)
  if (!session || session.status !== 'connected') {
    return res.status(503).json({ error: 'Bot tidak terhubung ke WhatsApp. Hubungkan dulu di Pengaturan.' })
  }

  if (!recipients?.length || !template?.trim()) {
    return res.status(400).json({ error: 'businessId, recipients, dan template wajib diisi' })
  }

  if (broadcastState.running) {
    return res.status(409).json({ error: 'Broadcast sedang berjalan, tunggu hingga selesai.' })
  }

  broadcastState = { running: true, sent: 0, failed: 0, total: recipients.length, businessId }
  res.json({ success: true, total: recipients.length })

  // Proses di background
  ;(async () => {
    try {
      for (const { number, name } of recipients) {
        if (!broadcastState.running) break

        const cleanNumber = String(number).replace(/@.*$/, '').replace(/\D/g, '')
        const isValidPhone = cleanNumber.length >= 10 && cleanNumber.length <= 15 && cleanNumber.startsWith('62')

        if (!isValidPhone) {
          console.log(`⚠️ [${businessId}] Skip nomor tidak valid: ${number}`)
          broadcastState.failed++
          continue
        }

        try {
          // Ambil sock terbaru (handle reconnect)
          const currentSession = getSession(businessId)
          if (!currentSession || currentSession.status !== 'connected') {
            console.log(`⚠️ [${businessId}] Bot tidak terhubung, menunggu 5s...`)
            await new Promise(r => setTimeout(r, 5000))
            broadcastState.failed++
            continue
          }

          const text = template.replace(/\[Nama\]/gi, name || 'Kak')
          const jid = `${cleanNumber}@s.whatsapp.net`

          await Promise.race([
            currentSession.sock.sendMessage(jid, { text }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout 15s')), 15000))
          ])

          broadcastState.sent++
          console.log(`📤 [${businessId}] Broadcast → ${cleanNumber}: ${text.substring(0, 40)}...`)
        } catch (err) {
          broadcastState.failed++
          console.error(`❌ [${businessId}] Broadcast gagal ke ${cleanNumber}:`, err.message)
        }

        await new Promise(r => setTimeout(r, 2000))
      }
    } finally {
      broadcastState.running = false
      console.log(`📊 [${businessId}] Broadcast selesai: ${broadcastState.sent} berhasil, ${broadcastState.failed} gagal`)
    }
  })()
})

app.get('/api/broadcast/status', (req, res) => {
  res.json(broadcastState)
})

// ─── Start server ─────────────────────────────────────────────────────────────
export const startServer = () => {
  const port = process.env.PORT || 3001
  app.listen(port, () => {
    console.log(`🌐 Server API berjalan di port ${port}`)
  })
}
