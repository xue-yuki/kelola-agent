import { processMessage } from '../ai/agent.js'
import { onOrderPaid } from '../payment/qris.js'
import { sendReceipt } from '../receipt/receipt.js'
import { checkIncoming } from '../lib/rateLimiter.js'

// ─── Gabungkan pesan beruntun ────────────────────────────────────────────────
// Pelanggan sering mengirim beberapa pesan pendek beruntun ("halo", "p", "hai").
// Pesan dari chat yang sama ditampung sebentar lalu dibalas SEKALI dengan teks gabungan.
const DEBOUNCE_MS = Number(process.env.MESSAGE_DEBOUNCE_MS || 4000)
const MAX_BUFFERED = 10
const pending = new Map() // key → { sock, lastMsg, texts[], customerWa, timer }
const chains = new Map()  // key → Promise (balasan diproses berurutan per chat)

export async function handleMessage(sock, msg, businessId, lidMap) {
  const jid = msg.key.remoteJid

  // Filter: JANGAN balas grup, status/broadcast, atau Saluran WhatsApp
  if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) {
    console.log(`⏭️ [${businessId}] Mengabaikan pesan dari grup/status/saluran: ${jid}`)
    return
  }

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

  // Extract teks pesan
  const text = msg.message?.conversation
    || msg.message?.extendedTextMessage?.text
    || ''

  if (!text) return

  console.log(`📩 [${businessId}] Pesan dari ${customerWa}: ${text}`)

  // Rate limit per menit (per pelanggan & per bisnis) — sebelum menyentuh AI / database
  const rl = checkIncoming(businessId, customerWa)
  if (!rl.ok) {
    console.warn(`🚦 [${businessId}] Rate limit (${rl.scope}) untuk ${customerWa}`)
    if (rl.notify) {
      try {
        await sock.sendMessage(jid, {
          text: rl.scope === 'customer'
            ? 'Pesannya terlalu cepat nih Kak 🙏 Mohon tunggu sebentar ya, nanti kami balas satu per satu.'
            : 'Saat ini pesan yang masuk sedang banyak, Kak 🙏 Mohon tunggu sebentar lalu kirim lagi ya.'
        })
      } catch (e) { console.error('Gagal kirim notifikasi rate limit:', e?.message) }
    }
    return
  }

  // Tampung dulu; balas setelah pelanggan berhenti mengetik selama DEBOUNCE_MS
  const key = `${businessId}:${jid}`
  const entry = pending.get(key) || { texts: [] }
  entry.texts.push(text)
  entry.lastMsg = msg
  entry.sock = sock
  entry.customerWa = customerWa
  if (entry.timer) clearTimeout(entry.timer)
  pending.set(key, entry)

  // Tampilkan "sedang mengetik…" segera supaya pelanggan tahu pesannya diterima
  sock.sendPresenceUpdate('composing', jid).catch(() => {})

  const flush = () => {
    pending.delete(key)
    const combined = entry.texts.join('\n')
    if (entry.texts.length > 1) {
      console.log(`🧩 [${businessId}] Menggabungkan ${entry.texts.length} pesan dari ${customerWa}`)
    }
    const prev = chains.get(key) || Promise.resolve()
    const next = prev
      .then(() => replyToCustomer(entry.sock, jid, entry.lastMsg, combined, businessId, entry.customerWa))
      .catch((err) => console.error(`❌ [${businessId}] Gagal memproses pesan gabungan:`, err?.message || err))
      .finally(() => { if (chains.get(key) === next) chains.delete(key) })
    chains.set(key, next)
  }

  if (entry.texts.length >= MAX_BUFFERED) flush()
  else entry.timer = setTimeout(flush, DEBOUNCE_MS)
}

// Proses teks (sudah digabung) dengan AI lalu kirim balasan, struk, QRIS, dan notifikasi.
async function replyToCustomer(sock, jid, msg, text, businessId, customerWa) {
  // Nomor WA bot (nomor yang di-scan oleh bisnis ini)
  const botWa = sock.user.id.split(':')[0]

  try {
    // Typing indicator
    await sock.sendPresenceUpdate('composing', jid)

    // Proses dengan AI
    const { reply, receipt, ownerNotif, qris } = await processMessage(botWa, customerWa, text)

    // Kirim balasan utama ke pelanggan
    await sock.sendMessage(jid, { text: reply }, { quoted: msg })
    console.log(`✅ [${businessId}] Balas ke ${customerWa}: ${reply.substring(0, 50)}...`)

    // Kirim struk (gambar + caption; cadangan teks) ke pelanggan jika ada order COD
    if (receipt) {
      await new Promise(r => setTimeout(r, 1500))
      const kind = await sendReceipt(sock, jid, receipt)
      console.log(`🧾 [${businessId}] Struk (${kind === 'image' ? 'gambar' : 'teks'}) dikirim ke ${customerWa}`)
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
            const kind = await sendReceipt(sock, jid, qris.receipt)
            console.log(`🧾 [${businessId}] Struk ${kind === 'image' ? 'gambar' : 'teks'} (post-payment) dikirim ke ${customerWa}`)
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
