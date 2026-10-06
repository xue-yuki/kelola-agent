import fs from 'fs'
import path from 'path'
import { createBotSession } from './connection.js'

// ─── Registry semua WA sessions ───────────────────────────────────────────────
// Map<businessId, SessionData>
// SessionData: { sock, status, qr, authDir, retryCount, destroy() }
const sessions = new Map()

const AUTH_BASE_DIR = path.resolve('auth')

// Pastikan base auth dir ada
if (!fs.existsSync(AUTH_BASE_DIR)) {
  fs.mkdirSync(AUTH_BASE_DIR, { recursive: true })
}

// ─── Get session data ─────────────────────────────────────────────────────────
export function getSession(businessId) {
  return sessions.get(businessId) || null
}

// ─── Get semua session aktif ──────────────────────────────────────────────────
export function getAllSessions() {
  const result = []
  for (const [businessId, session] of sessions.entries()) {
    result.push({
      businessId,
      status: session.status,
      hasQR: !!session.qr,
    })
  }
  return result
}

// ─── Buat / start session baru untuk satu bisnis ──────────────────────────────
export async function createSession(businessId) {
  // Kalau sudah ada dan connected, skip
  if (sessions.has(businessId)) {
    const existing = sessions.get(businessId)
    if (existing.status === 'connected') {
      console.log(`ℹ️  [${businessId}] Session sudah connected, skip.`)
      return existing
    }
    // Kalau ada tapi belum connected, destroy dulu sebelum buat baru
    await destroySession(businessId, false) // false = jangan hapus auth folder
  }

  const authDir = path.join(AUTH_BASE_DIR, businessId)

  // SessionData yang akan diisi oleh createBotSession
  const sessionData = {
    sock: null,
    status: 'disconnected',
    qr: null,
    authDir,
    retryCount: 0,
    _destroyed: false,

    // Method untuk destroy session ini dari luar
    destroy: async (clearAuth = true) => {
      await destroySession(businessId, clearAuth)
    }
  }

  sessions.set(businessId, sessionData)
  console.log(`🆕 [${businessId}] Membuat session baru...`)

  // Start koneksi Baileys (non-blocking)
  createBotSession(businessId, authDir, sessionData)

  return sessionData
}

// ─── Destroy session (logout + optional hapus auth) ──────────────────────────
export async function destroySession(businessId, clearAuth = true) {
  const session = sessions.get(businessId)
  if (!session) return

  session._destroyed = true
  session.status = 'disconnected'
  session.qr = null

  // Logout dari WhatsApp jika socket masih ada
  if (session.sock) {
    try {
      await session.sock.logout()
    } catch {
      try { session.sock.end() } catch {}
    }
    session.sock = null
  }

  sessions.delete(businessId)
  console.log(`🗑️  [${businessId}] Session dihapus.`)

  // Hapus folder auth jika diminta (full logout)
  if (clearAuth) {
    const authDir = path.join(AUTH_BASE_DIR, businessId)
    try {
      await fs.promises.rm(authDir, { recursive: true, force: true })
      console.log(`🗂️  [${businessId}] Auth folder dihapus.`)
    } catch (err) {
      console.error(`❌ [${businessId}] Gagal hapus auth folder:`, err.message)
    }
  }
}

// ─── Auto-restore semua session yang punya auth tersimpan ────────────────────
// Dipanggil saat server start — reconnect tanpa scan QR ulang
export async function autoRestoreAll() {
  if (!fs.existsSync(AUTH_BASE_DIR)) return

  const entries = fs.readdirSync(AUTH_BASE_DIR, { withFileTypes: true })
  const businessIds = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)

  if (businessIds.length === 0) {
    console.log('📋 Tidak ada session tersimpan untuk di-restore.')
    return
  }

  console.log(`🔄 Auto-restore ${businessIds.length} session(s): ${businessIds.join(', ')}`)

  // Restore semua secara paralel dengan sedikit jeda antar session
  for (let i = 0; i < businessIds.length; i++) {
    const bizId = businessIds[i]
    const credsPath = path.join(AUTH_BASE_DIR, bizId, 'creds.json')

    // Hanya restore jika sudah pernah dipasangkan. creds.json bisa sudah ada walau QR
    // belum pernah dipindai — sesi seperti itu tidak di-restore (akan menunggu QR selamanya).
    let registered = false
    try {
      registered = fs.existsSync(credsPath) && JSON.parse(fs.readFileSync(credsPath, 'utf8')).registered === true
    } catch { registered = false }

    if (registered) {
      await createSession(bizId)
      // Jeda kecil antar session agar tidak flood WA server
      if (i < businessIds.length - 1) {
        await new Promise(r => setTimeout(r, 2000))
      }
    } else {
      console.log(`⚠️  [${bizId}] Auth folder ada tapi belum pernah dipasangkan (QR belum dipindai), skip restore.`)
    }
  }
}
