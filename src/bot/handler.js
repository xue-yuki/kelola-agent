import { processMessage } from '../ai/agent.js'
import { isSocketConnected } from './connection.js'


export async function handleMessage(sock, msg) {
  const jid = msg.key.remoteJid
  const customerWa = jid.replace('@s.whatsapp.net', '')
  
  // Ambil nomor WA bot (nomor yang di-scan)
  const botWa = sock.user.id.split(':')[0]

  // Extract teks pesan
  const text = msg.message?.conversation 
    || msg.message?.extendedTextMessage?.text 
    || ''

  if (!text) return

  console.log(`📩 Pesan dari ${customerWa}: ${text}`)

  try {
    // Typing indicator
    await sock.sendPresenceUpdate('composing', jid)

    // Process dengan AI
    const reply = await processMessage(botWa, customerWa, text)

    // Kirim balasan
    await sock.sendMessage(jid, { text: reply }, { quoted: msg })
    
    console.log(`✅ Balas ke ${customerWa}: ${reply.substring(0, 50)}...`)
  } catch (error) {
    const code = error?.output?.statusCode || error?.code
    console.error(`❌ Error handling message (${code}):`, error?.message || error)

    // Jangan coba kirim pesan jika koneksi sudah mati (WebSocket closed)
    const isConnectionDead = code === 428 || error?.message?.includes('Connection Closed') || error?.message?.includes('Connection Failure')
    if (!isConnectionDead) {
      try {
        await sock.sendMessage(jid, { 
          text: 'Maaf, ada gangguan teknis. Silakan coba lagi ya! 🙏' 
        })
      } catch (sendErr) {
        console.error('❌ Gagal kirim pesan error fallback:', sendErr?.message)
      }
    }
  }
}