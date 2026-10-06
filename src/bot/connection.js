import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  generateMessageIDV2
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import { handleMessage } from './handler.js'
import { rememberSent, isBotSent, markOwnerReply, messageAgeMs } from './settings.js'

const logger = pino({ level: 'silent' })

// Sesi yang QR-nya tidak kunjung dipindai berhenti mencoba setelah batas ini
// (sebelumnya reconnect selamanya tiap 60 detik). Pemilik cukup klik "Hubungkan" lagi.
const QR_TIMEOUT_MS = Number(process.env.QR_TIMEOUT_MS || 30 * 60 * 1000)

// ─── LID → phone number mapping (per session) ────────────────────────────────
// Map<businessId, Map<lid, phoneNumber>>
const lidMaps = new Map()

export function getLidMap(businessId) {
  if (!lidMaps.has(businessId)) lidMaps.set(businessId, new Map())
  return lidMaps.get(businessId)
}

// ─── Factory: buat WA session untuk satu bisnis ──────────────────────────────
// sessionData adalah object dari agentManager yang akan di-mutate langsung
export async function createBotSession(businessId, authDir, sessionData, isRetry = false) {
  // Kalau session sudah di-destroy (misal user logout manual), stop reconnect
  if (sessionData._destroyed) return

  const { version } = await fetchLatestBaileysVersion()
  const { state, saveCreds } = await useMultiFileAuthState(authDir)

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger,
    printQRInTerminal: false,
    connectTimeoutMs: 30000,
    keepAliveIntervalMs: 15000,
    retryRequestDelayMs: 2000,
  })

  // Semua kiriman bot (balasan, struk, QRIS, broadcast, notifikasi) diberi messageId sendiri dan
  // dicatat, supaya tidak dikira balasan manual pemilik (fitur ambil alih, src/bot/settings.js).
  const rawSendMessage = sock.sendMessage.bind(sock)
  sock.sendMessage = (jid, content, options = {}) => {
    const messageId = options.messageId || generateMessageIDV2(sock.user?.id)
    rememberSent(messageId)
    return rawSendMessage(jid, content, { ...options, messageId })
  }

  // Update socket di sessionData
  sessionData.sock = sock
  sessionData.status = 'connecting'
  sessionData.qr = null

  sock.ev.on('creds.update', saveCreds)

  // ─── Build LID → phone number map ───────────────────────────────────────
  const lidMap = getLidMap(businessId)
  function indexContacts(contacts) {
    for (const c of contacts) {
      const lidJid   = c.lid || (c.id?.endsWith('@lid') ? c.id : null)
      const phoneJid = c.phoneNumber || (!c.id?.endsWith('@lid') ? c.id : null)
      if (lidJid && phoneJid) {
        lidMap.set(lidJid.split('@')[0], phoneJid.split('@')[0])
      }
    }
  }
  sock.ev.on('contacts.upsert', indexContacts)
  sock.ev.on('contacts.update', indexContacts)

  // ─── Connection state handler ────────────────────────────────────────────
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (sessionData._destroyed) return

    if (qr) {
      sessionData.qr = qr
      sessionData.status = 'connecting'
      if (!sessionData.qrSince) sessionData.qrSince = Date.now()
      console.log(`📱 [${businessId}] QR code siap untuk di-scan.`)
    }

    if (connection === 'connecting') {
      sessionData.status = 'connecting'
      sessionData.qr = null
      console.log(`🔌 [${businessId}] Menghubungkan ke WhatsApp...`)

    } else if (connection === 'open') {
      sessionData.status = 'connected'
      sessionData.qr = null
      sessionData.qrSince = null
      sessionData.retryCount = 0
      console.log(`✅ [${businessId}] Terhubung ke WhatsApp!`)

    } else if (connection === 'close') {
      sessionData.status = 'disconnected'
      sessionData.qr = null

      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      console.log(`🔴 [${businessId}] Koneksi terputus (status: ${statusCode})`)

      // Belum pernah dipasangkan dan QR sudah menunggu terlalu lama → berhenti mencoba
      const qrExpired = !state.creds.me?.id
        && sessionData.qrSince
        && Date.now() - sessionData.qrSince > QR_TIMEOUT_MS
      if (qrExpired) {
        console.log(`⏹️ [${businessId}] QR tidak dipindai selama ${Math.round(QR_TIMEOUT_MS / 60000)} menit, berhenti mencoba. Klik "Hubungkan" di dashboard untuk mulai lagi.`)
        sessionData.sock = null
        sessionData.qrSince = null
        return
      }

      if (shouldReconnect && !sessionData._destroyed) {
        sessionData.retryCount = (sessionData.retryCount || 0) + 1

        // Exponential backoff: max 60 detik
        const baseWait = statusCode === 440 ? 3000 : 5000
        const waitMs = Math.min(baseWait * Math.pow(1.5, sessionData.retryCount - 1), 60000)

        console.log(`🔄 [${businessId}] Reconnect #${sessionData.retryCount} dalam ${Math.round(waitMs / 1000)}s...`)
        await new Promise(r => setTimeout(r, waitMs))

        if (!sessionData._destroyed) {
          await createBotSession(businessId, authDir, sessionData, true)
        }
      } else {
        console.log(`🚫 [${businessId}] Sesi logout. Bersihkan auth...`)
        // Bersihkan session tanpa hapus folder (biar bisa scan QR lagi)
        sessionData.sock = null
        sessionData.status = 'disconnected'
      }
    }
  })

  // ─── Ambil alih manual: catat chat yang dibalas pemilik sendiri ──────────
  // Pesan kiriman bot muncul lagi sebagai event 'append' (diabaikan di bawah) dan ID-nya tercatat;
  // balasan dari HP/WA Web pemilik datang sebagai 'notify' + fromMe.
  const noteOwnerReply = (msg) => {
    const jid = msg.key.remoteJid || ''
    if (!jid || /@(g\.us|broadcast|newsletter)$/.test(jid) || jid === 'status@broadcast') return
    if (isBotSent(msg.key.id)) return
    const rawId = jid.split('@')[0]
    const ownNumber = (sock.user?.id || '').split(':')[0].split('@')[0]
    if (rawId === ownNumber) return // chat ke diri sendiri (notifikasi pemilik)
    const ageMs = messageAgeMs(msg)
    if (ageMs > 48 * 3_600_000) return
    // Kunci = nomor HP pelanggan (jid bisa @lid atau @s.whatsapp.net), sama dengan handler.js
    let phone = rawId
    if (jid.endsWith('@lid')) {
      const alt = msg.key.remoteJidAlt
      phone = alt && !alt.endsWith('@lid') ? alt.split('@')[0] : (lidMap.get(rawId) || rawId)
    }
    const at = Date.now() - Math.max(0, ageMs)
    markOwnerReply(businessId, phone, at)
    if (phone !== rawId) markOwnerReply(businessId, rawId, at)
    console.log(`🙋 [${businessId}] Pemilik membalas manual ke ${phone} — bot diam sementara di chat ini`)
  }

  // ─── Incoming message handler ────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    if (sessionData._destroyed) return

    if (sessionData.status !== 'connected' || !sessionData.sock) {
      console.log(`⚠️ [${businessId}] Pesan diterima saat koneksi tidak stabil, skip.`)
      return
    }

    const activeSock = sessionData.sock

    // Satu event bisa berisi beberapa pesan (mis. pesan tertahan saat offline) — proses semuanya;
    // handler akan menggabungkan pesan beruntun dari chat yang sama.
    for (const msg of messages) {
      if (!msg?.message) continue
      if (msg.key.fromMe) {
        // Dikirim dari nomor toko tapi bukan oleh bot = pemilik membalas sendiri (HP / WA Web)
        noteOwnerReply(msg)
        continue
      }
      try {
        await handleMessage(activeSock, msg, businessId, lidMap)
      } catch (err) {
        console.error(`❌ [${businessId}] Unhandled error in handleMessage:`, err?.message || err)
      }
    }
  })
}