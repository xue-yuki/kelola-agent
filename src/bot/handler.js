import { processMessage } from '../ai/agent.js'

export async function handleMessage(sock, msg, businessId, lidMap) {
  const jid = msg.key.remoteJid
  const rawId = jid.split('@')[0]

  // Resolve @lid (WhatsApp internal device ID) ke nomor telepon asli
  let customerWa = rawId
  if (jid.endsWith('@lid')) {
    const altJid = msg.key.remoteJidAlt
    if (altJid && !altJid.endsWith('@lid')) {
      customerWa = altJid.split('@')[0]
    } else {
      // Fallback: cari di lidMap session ini
      customerWa = lidMap?.get(rawId) || rawId
    }
  }

  // Nomor WA bot (nomor yang di-scan oleh bisnis ini)
  const botWa = sock.user.id.split(':')[0]

  // Extract teks pesan
  const text = msg.message?.conversation
    || msg.message?.extendedTextMessage?.text
    || ''

  if (!text) return

  console.log(`📩 [${businessId}] Pesan dari ${customerWa}: ${text}`)

  try {
    // Typing indicator
    await sock.sendPresenceUpdate('composing', jid)

    // Proses dengan AI
    const { reply, receipt, ownerNotif } = await processMessage(botWa, customerWa, text)

    // Kirim balasan utama ke pelanggan
    await sock.sendMessage(jid, { text: reply }, { quoted: msg })
    console.log(`✅ [${businessId}] Balas ke ${customerWa}: ${reply.substring(0, 50)}...`)

    // Kirim struk digital ke pelanggan jika ada order
    if (receipt) {
      await new Promise(r => setTimeout(r, 1500))
      await sock.sendMessage(jid, { text: receipt })
      console.log(`🧾 [${businessId}] Struk dikirim ke ${customerWa}`)
    }

    // Kirim notifikasi ke owner (nomor bot sendiri)
    if (ownerNotif) {
      await new Promise(r => setTimeout(r, 1000))
      const ownerJid = `${botWa}@s.whatsapp.net`
      await sock.sendMessage(ownerJid, { text: ownerNotif })
      console.log(`🔔 [${businessId}] Notifikasi owner dikirim ke ${botWa}`)
    }
  } catch (error) {
    const code = error?.output?.statusCode || error?.code
    console.error(`❌ [${businessId}] Error handling message (${code}):`, error?.message || error)

    const isConnectionDead = code === 428
      || error?.message?.includes('Connection Closed')
      || error?.message?.includes('Connection Failure')

    if (!isConnectionDead) {
      try {
        await sock.sendMessage(jid, {
          text: 'Maaf, ada gangguan teknis. Silakan coba lagi ya! 🙏'
        })
      } catch (sendErr) {
        console.error(`❌ [${businessId}] Gagal kirim pesan error fallback:`, sendErr?.message)
      }
    }
  }
}