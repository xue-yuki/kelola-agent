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

const logger = pino({ level: 'silent' })

let savedPhoneNumber = null
let pairingRequested = false
let isConnected = false       // track status koneksi
let currentSock = null        // referensi socket aktif

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

export async function startBot() {
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
  })

  currentSock = sock
  isConnected = false

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
        const waitMs = statusCode === 440 ? 20000 : 5000
        console.log(`🔄 Reconnecting dalam ${waitMs/1000}s... (status: ${statusCode})`)
        pairingRequested = false
        await delay(waitMs)
        startBot()
      } else {
        console.log('\n🚫 Sesi logout. Hapus folder auth_info lalu jalankan ulang.')
        process.exit(0)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Hanya proses notify (pesan baru masuk), skip jika sedang disconnect
    if (type !== 'notify') return
    
    const msg = messages[0]
    if (!msg?.message || msg.key.fromMe) return

    // Tunggu sebentar untuk pastikan koneksi stabil
    if (!isConnected) {
      console.log('⚠️ Pesan diterima saat disconnect, menunggu reconnect...')
      // Tunggu max 10s untuk reconnect
      for (let i = 0; i < 10; i++) {
        await delay(1000)
        if (isConnected) break
      }
      if (!isConnected) {
        console.log('⚠️ Koneksi tidak pulih, skip pesan.')
        return
      }
    }

    try {
      await handleMessage(currentSock, msg)
    } catch (err) {
      console.error('❌ Unhandled error in handleMessage:', err?.message || err)
    }
  })
}