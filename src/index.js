import { startServer } from './api/server.js'
import { autoRestoreAll } from './bot/agentManager.js'
import dotenv from 'dotenv'

dotenv.config()

console.log('🚀 Kelola.ai Agent starting...')

// Start REST API server
startServer()

// Auto-restore semua session WA yang sudah tersimpan sebelumnya
// (reconnect tanpa perlu scan QR ulang setelah restart)
autoRestoreAll().catch(err => {
  console.error('❌ Error during auto-restore:', err.message)
})