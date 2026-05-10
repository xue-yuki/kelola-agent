import { processMessage } from '../ai/agent.js'
import { isSocketConnected, lidToPhone } from './connection.js'


export async function handleMessage(sock, msg) {
  const jid = msg.key.remoteJid
  const rawId = jid.split('@')[0]

  // Resolve @lid (WhatsApp internal device ID) to actual phone number
  let customerWa = rawId
  if (jid.endsWith('@lid')) {
    // remoteJidAlt berisi phone JID (@s.whatsapp.net) saat remoteJid adalah @lid
    const altJid = msg.key.remoteJidAlt
    if (altJid && !altJid.endsWith('@lid')) {
      customerWa = altJid.split('@')[0]
    } else {
      // Fallback: contact map dari contacts.upsert event
      customerWa = lidToPhone.get(rawId) || rawId
    }
  }
  
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
    const { reply, receipt, ownerNotif } = await processMessage(botWa, customerWa, text)

    // Kirim balasan utama ke pelanggan
    await sock.sendMessage(jid, { text: reply }, { quoted: msg })
    console.log(`✅ Balas ke ${customerWa}: ${reply.substring(0, 50)}...`)

    // Kirim struk digital ke pelanggan jika ada order
    if (receipt) {
      await new Promise(r => setTimeout(r, 1500))
      await sock.sendMessage(jid, { text: receipt })
      console.log(`🧾 Struk dikirim ke ${customerWa}`)
    }

    // Kirim notifikasi ke owner (nomor bot sendiri)
    if (ownerNotif) {
      await new Promise(r => setTimeout(r, 1000))
      const ownerJid = `${botWa}@s.whatsapp.net`
      await sock.sendMessage(ownerJid, { text: ownerNotif })
      console.log(`🔔 Notifikasi owner dikirim ke ${botWa}`)
    }
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