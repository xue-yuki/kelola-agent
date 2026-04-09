import { startBot } from './bot/connection.js'
import { startServer } from './api/server.js'

console.log('🚀 Kelola.ai Agent starting...')
startServer()
startBot()