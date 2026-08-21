import { processMessage } from '../ai/agent.js'
import { onOrderPaid } from '../payment/qris.js'

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

  // Filter 1: JANGAN balas pesan dari Grup atau Broadcast Status
  if (jid.endsWith('@g.us') || jid.endsWith('@broadcast')) {
    console.log(`⏭️ [${businessId}] Mengabaikan pesan dari grup/status: ${jid}`)
    return
  }

  console.log(`📩 [${businessId}] Pesan dari ${customerWa}: ${text}`)

  try {
    // Typing indicator
    await sock.sendPresenceUpdate('composing', jid)

    // Proses dengan AI
    const { reply, receipt, ownerNotif, qris } = await processMessage(botWa, customerWa, text)

    // Kirim balasan utama ke pelanggan
    await sock.sendMessage(jid, { text: reply }, { quoted: msg })
    console.log(`✅ [${businessId}] Balas ke ${customerWa}: ${reply.substring(0, 50)}...`)

    // Kirim struk digital ke pelanggan jika ada order
    if (receipt) {
      await new Promise(r => setTimeout(r, 1500))
      await sock.sendMessage(jid, { text: receipt })
      console.log(`🧾 [${businessId}] Struk dikirim ke ${customerWa}`)
    }

    // Kirim QRIS payment (kalau ada order & QRIS berhasil di-generate)
    if (qris) {
      await new Promise(r => setTimeout(r, 1200))
      const expiryStr = qris.expiresAt.toLocaleTimeString('id-ID', {
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta'
      })
      const caption = `💳 *PEMBAYARAN QRIS*\n\n` +
        `Silakan scan QRIS di atas untuk membayar\n` +
        `💰 Total: *Rp ${qris.total.toLocaleString('id-ID')}*\n` +
        `⏰ Berlaku sampai *${expiryStr} WIB*\n\n` +
        `_Setelah pembayaran diterima, kami akan otomatis konfirmasi via chat ini._ ✨`
      await sock.sendMessage(jid, {
        image: qris.buffer,
        caption
      })
      console.log(`💳 [${businessId}] QRIS dikirim ke ${customerWa} untuk order ${qris.orderId.slice(0,8)}`)

      // Register callback: pas order lunas, kirim struk + konfirmasi ke customer + notif owner
      onOrderPaid(qris.orderId, async ({ order, paidAt }) => {
        try {
          const paidTime = new Date(paidAt).toLocaleTimeString('id-ID', {
            hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta'
          })
          const shortId = qris.orderId.slice(0, 8).toUpperCase()

          // 1. Notif konfirmasi ke customer
          const customerNotif = `✅ *PEMBAYARAN DITERIMA*\n\n` +
            `Terima kasih Kak ${qris.customerName}! 🙏\n\n` +
            `📋 Order: *#${shortId}*\n` +
            `💰 Nominal: *Rp ${qris.total.toLocaleString('id-ID')}*\n` +
            `🕐 Waktu bayar: *${paidTime} WIB*\n\n` +
            `Pesanan Kakak sedang kami siapkan & akan segera dikirim! 🚀`
          await sock.sendMessage(jid, { text: customerNotif })
          console.log(`💚 [${businessId}] Konfirmasi lunas dikirim ke ${customerWa}`)

          // 2. Kirim struk digital ke customer (di-hold dari awal, sekarang baru dikirim)
          if (qris.receipt) {
            await new Promise(r => setTimeout(r, 800))
            await sock.sendMessage(jid, { text: qris.receipt })
            console.log(`🧾 [${businessId}] Struk (post-payment) dikirim ke ${customerWa}`)
          }

          // 3. Notif ke owner
          await new Promise(r => setTimeout(r, 500))
          const ownerJid = `${botWa}@s.whatsapp.net`
          const ownerPaidNotif = `💰 *PEMBAYARAN MASUK!*\n\n` +
            `📋 Order: *#${shortId}*\n` +
            `👤 Pelanggan: ${qris.customerName}\n` +
            `💵 Nominal: *Rp ${qris.total.toLocaleString('id-ID')}*\n` +
            `🕐 Waktu: ${paidTime} WIB\n\n` +
            `_Pembayaran diterima, order otomatis masuk ke DIPROSES. Segera siapkan barangnya!_ 📦`
          await sock.sendMessage(ownerJid, { text: ownerPaidNotif })
          console.log(`🔔 [${businessId}] Notif lunas ke owner ${botWa}`)
        } catch (notifErr) {
          console.error(`❌ Gagal kirim notif lunas:`, notifErr?.message)
        }
      })
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
