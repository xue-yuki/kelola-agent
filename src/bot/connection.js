import { 
  makeWASocket,
  useMultiFileAuthState, 
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import { handleMessage } from './handler.js'
import readline from 'readline'
import fs from 'fs'
import path from 'path'

const logger = pino({ level: 'silent' })

const LOCK_FILE = path.resolve('bot.lock')

let savedPhoneNumber = null
let pairingRequested = false
let isConnected = false
let currentSock = null
let isReconnecting = false  // cegah reconnect ganda

// ─── Single Instance Lock ─────────────────────────────────────────────────────
function acquireLock() {
  try {
    // Cek apakah lock sudah ada (dari proses lain)
    if (fs.existsSync(LOCK_FILE)) {
      const pid = fs.readFileSync(LOCK_FILE, 'utf8').trim()
      // Cek apakah PID tersebut masih aktif
      try {
        process.kill(Number(pid), 0) // sinyal 0 = hanya cek, tidak kill
        console.error(`❌ Bot sudah berjalan (PID: ${pid}). Hentikan proses itu dulu.`)
        process.exit(1)
      } catch {
        // PID tidak aktif, lock lama — hapus dan lanjut
        fs.unlinkSync(LOCK_FILE)
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid))
  } catch (err) {
    console.error('❌ Gagal buat lock file:', err.message)
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE)
  } catch {}
}

// Bersihkan lock saat proses berhenti
process.on('exit', releaseLock)
process.on('SIGINT', () => { releaseLock(); process.exit(0) })
process.on('SIGTERM', () => { releaseLock(); process.exit(0) })

// ─── Helpers ──────────────────────────────────────────────────────────────────
function askQuestion(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(query, ans => { rl.close(); resolve(ans) }))
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function getActiveSock() {
  return currentSock
}

export function isSocketConnected() {
  return isConnected
}

// ─── Bot Core ─────────────────────────────────────────────────────────────────
export async function startBot(isRetry = false) {
  // Hanya acquire lock saat pertama kali start
  if (!isRetry) acquireLock()

  // Pastikan tidak ada reconnect ganda berjalan
  if (isRetry && isReconnecting) return
  if (isRetry) isReconnecting = true

  // Tutup socket lama sebelum buat yang baru
  if (currentSock) {
    try { currentSock.end() } catch {}
    currentSock = null
  }

  const { version, isLatest } = await fetchLatestBaileysVersion()
  console.log(`📦 WA Web version: ${version.join('.')} (latest: ${isLatest})`)

  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  if (!state.creds.registered && !savedPhoneNumber) {
    const raw = await askQuestion(
      '\n📱 Masukkan nomor WhatsApp kamu (format: 628xxxxxxxxxx tanpa +): '
    )
    savedPhoneNumber = raw.replace(/[^0-9]/g, '')
    pairingRequested = false
  }

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger,
    printQRInTerminal: false,
    // Tambahan: stabilkan koneksi
    connectTimeoutMs: 30000,
    keepAliveIntervalMs: 15000,
    retryRequestDelayMs: 2000,
  })

  currentSock = sock
  isConnected = false
  isReconnecting = false

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && savedPhoneNumber && !pairingRequested && !state.creds.registered) {
      pairingRequested = true
      try {
        const code = await sock.requestPairingCode(savedPhoneNumber)
        console.log(`\n🔑 Pairing Code: ${code}`)
        console.log('   → WhatsApp > Setelan > Perangkat Tertaut > Tautkan Perangkat\n')
      } catch (err) {
        console.error('❌ Gagal pairing code:', err.message)
        pairingRequested = false
      }
    }

    if (connection === 'connecting') {
      isConnected = false
      console.log('🔌 Menghubungkan ke WhatsApp...')
    } else if (connection === 'open') {
      isConnected = true
      currentSock = sock
      console.log('\n✅ Kelola.ai Bot terhubung ke WhatsApp!')
    } else if (connection === 'close') {
      isConnected = false
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      if (shouldReconnect) {
        // Status 440 = ada session lain — tunggu lebih lama agar yang lain timeout
        const waitMs = statusCode === 440 ? 20000 : 5000
        console.log(`🔄 Reconnecting dalam ${waitMs/1000}s... (status: ${statusCode})`)
        pairingRequested = false
        await delay(waitMs)
        startBot(true)  // isRetry = true
      } else {
        console.log('\n🚫 Sesi logout. Hapus folder auth_info lalu jalankan ulang.')
        releaseLock()
        process.exit(0)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    
    const msg = messages[0]
    if (!msg?.message || msg.key.fromMe) return

    // Abaikan pesan jika koneksi sedang tidak stabil
    if (!isConnected || !currentSock) {
      console.log('⚠️ Pesan diterima saat koneksi tidak stabil, skip.')
      return
    }

    // Snapshot sock saat ini agar tidak berubah di tengah proses async
    const activeSock = currentSock

    try {
      await handleMessage(activeSock, msg)
    } catch (err) {
      console.error('❌ Unhandled error in handleMessage:', err?.message || err)
    }
  })
}