import { startServer } from './api/server.js'
import { autoRestoreAll } from './bot/agentManager.js'
import { startProofCleanup } from './payment/proof.js'
import dotenv from 'dotenv'

dotenv.config()

// ─── Global error handler agar crash tidak silent ─────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION (proses tidak crash):', err?.message, err?.stack)
})

process.on('unhandledRejection', (reason) => {
  console.error('💥 UNHANDLED REJECTION (proses tidak crash):', reason?.message || reason)
})

console.log('🚀 Kelola.ai Agent starting...')

// ─── KeepAlive: cegah Node.js exit saat Baileys sedang reconnect ──────────────
const _keepAlive = setInterval(() => {}, 10000)


// Start REST API server
startServer()

// Auto-restore semua session WA yang sudah tersimpan sebelumnya
// (reconnect tanpa perlu scan QR ulang setelah restart)
autoRestoreAll().catch(err => {
  console.error('❌ Error during auto-restore:', err.message)
})

// Hapus foto bukti bayar QRIS pesanan selesai yang sudah > 30 hari (tiap 24 jam)
startProofCleanup()
