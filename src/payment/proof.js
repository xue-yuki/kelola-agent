// ─────────────────────────────────────────────────────────────────────
// Bukti bayar QRIS dari pelanggan + keputusan penjual
//
// 1. Pelanggan kirim foto bukti bayar → handlePaymentProof(): foto disimpan di Storage
//    (bucket privat "payment-proofs"), pesanan jadi "menunggu_verifikasi", penjual dikabari.
// 2. Penjual cek uang masuk di aplikasi QRIS-nya lalu Konfirmasi / Tolak di dashboard
//    → decidePayment() (POST /api/payment/:businessId).
// Tidak ada konfirmasi otomatis: bukti bayar bisa dipalsukan (termasuk dengan AI) dan
// tanda AI hilang setelah lewat WhatsApp — yang menentukan selalu penjual.
// Foto pesanan lunas/dibatalkan dihapus 30 hari kemudian → cleanupOldProofs().
// ─────────────────────────────────────────────────────────────────────

import { downloadMediaMessage, extractMessageContent } from '@whiskeysockets/baileys'
import pino from 'pino'
import supabase from '../db/supabase.js'
import { receiptFromOrder, sendReceipt, rupiah } from '../receipt/receipt.js'

const BUCKET = 'payment-proofs'
const OPEN_STATUSES = ['menunggu_bayar', 'ditolak', 'menunggu_verifikasi']
const MAX_ORDER_AGE_DAYS = 7
const MAX_BYTES = 5 * 1024 * 1024
const KEEP_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const logger = pino({ level: 'silent' })

const shortId = (id) => String(id).slice(0, 8).toUpperCase()
const displayName = (name) => (name && !/^\+?\d{6,}$/.test(String(name).trim()) ? String(name).trim() : '')
const EXT = { 'image/png': 'png', 'image/webp': 'webp' }

// Gambar di pesan WhatsApp: foto biasa atau dokumen bergambar. null kalau bukan gambar.
export function getImageInfo(msg) {
  const content = extractMessageContent(msg.message)
  const media = content?.imageMessage
    || (/^image\//.test(content?.documentMessage?.mimetype || '') ? content.documentMessage : null)
  if (!media) return null
  return {
    mimetype: media.mimetype || 'image/jpeg',
    caption: media.caption || '',
    size: Number(media.fileLength?.toString?.() ?? media.fileLength) || 0,
  }
}

// Pesanan QRIS terbuka terbaru milik chat ini (≤ 7 hari, belum dibatalkan)
export async function findOpenQrisOrder(businessId, jid, customerWa) {
  const since = new Date(Date.now() - MAX_ORDER_AGE_DAYS * DAY_MS).toISOString()
  const { data, error } = await supabase.from('orders')
    .select('id, total, customer_name, payment_status, payment_proof_path')
    .eq('business_id', businessId)
    .eq('payment_method', 'qris')
    .in('payment_status', OPEN_STATUSES)
    .neq('status', 'dibatalkan')
    .or(`customer_jid.eq."${jid}",customer_wa.eq."${customerWa}"`)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) console.error('❌ Bukti bayar: gagal cari pesanan QRIS:', error.message)
  return data?.[0] || null
}

/**
 * Foto dari pelanggan yang punya pesanan QRIS terbuka = bukti bayar.
 * @returns {Promise<boolean>} true kalau pesan sudah ditangani di sini
 */
export async function handlePaymentProof(sock, msg, { businessId, jid, customerWa, botWa }) {
  const info = getImageInfo(msg)
  if (!info) return false
  const order = await findOpenQrisOrder(businessId, jid, customerWa)
  if (!order) return false

  const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg })
  const tooBig = 'Fotonya terlalu besar kak (maks 5 MB) 🙏 Kirim screenshot bukti bayarnya saja ya.'
  if (info.size > MAX_BYTES) {
    await reply(tooBig)
    return true
  }

  let path = null
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
    if (buffer.length > MAX_BYTES) {
      await reply(tooBig)
      return true
    }

    path = `${businessId}/${order.id}/${Date.now()}.${EXT[info.mimetype] || 'jpg'}`
    const { error: upErr } = await supabase.storage.from(BUCKET)
      .upload(path, buffer, { contentType: info.mimetype, upsert: false })
    if (upErr) throw new Error(`upload: ${upErr.message}`)

    const { error: updErr } = await supabase.from('orders').update({
      payment_status: 'menunggu_verifikasi',
      payment_proof_path: path,
      payment_proof_at: new Date().toISOString(),
    }).eq('id', order.id)
    if (updErr) {
      await supabase.storage.from(BUCKET).remove([path])
      throw new Error(`update order: ${updErr.message}`)
    }

    // Bukti sebelumnya untuk pesanan yang sama (dikirim ulang) tidak dipakai lagi
    if (order.payment_proof_path && order.payment_proof_path !== path) {
      supabase.storage.from(BUCKET).remove([order.payment_proof_path]).catch(() => {})
    }
  } catch (err) {
    console.error(`❌ [${businessId}] Bukti bayar #${shortId(order.id)} gagal disimpan:`, err?.message || err)
    await reply('Maaf kak, fotonya belum berhasil kami terima 🙏 Coba kirim ulang screenshot bukti bayarnya ya.')
    return true
  }

  console.log(`🧾 [${businessId}] Bukti bayar #${shortId(order.id)} dari ${customerWa} disimpan`)
  await reply('Terima kasih kak, bukti pembayarannya sudah kami terima 🙏\nPenjual cek dulu ya, nanti kami kabari di chat ini.')

  // Kabari pemilik (nomor bot sendiri, seperti notifikasi pesanan lain)
  try {
    const name = displayName(order.customer_name) || customerWa
    const again = order.payment_status === 'menunggu_verifikasi' ? ' (dikirim ulang)' : ''
    await sock.sendMessage(`${botWa}@s.whatsapp.net`, {
      text: `🧾 *BUKTI BAYAR MASUK*${again}\n\n` +
        `📋 Order *#${shortId(order.id)}* · ${name}\n` +
        `💰 *${rupiah(order.total)}* (QRIS)\n\n` +
        `_Cek uang masuk di aplikasi QRIS-mu, lalu konfirmasi di dashboard → Pesanan._`,
    })
  } catch (err) {
    console.error(`❌ [${businessId}] Gagal kirim notif bukti bayar ke pemilik:`, err?.message)
  }
  return true
}

/**
 * Keputusan penjual atas pembayaran QRIS (dari dashboard lewat agent-proxy).
 * Database tetap diperbarui walau WhatsApp sedang tidak terhubung (sent: false).
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function decidePayment({ businessId, orderId, action, session }) {
  const { data: order, error } = await supabase.from('orders')
    .select('id, business_id, created_at, items, total, customer_name, customer_address, customer_wa, customer_jid, payment_method, payment_status, status')
    .eq('id', orderId).eq('business_id', businessId).maybeSingle()
  if (error) return { status: 500, body: { error: 'Gagal membaca pesanan' } }
  if (!order) return { status: 404, body: { error: 'Pesanan tidak ditemukan' } }
  if (order.payment_method !== 'qris' || !order.payment_status) {
    return { status: 400, body: { error: 'Pesanan ini bukan pembayaran QRIS' } }
  }
  if (order.status === 'dibatalkan') return { status: 409, body: { error: 'Pesanan sudah dibatalkan' } }

  const allowed = action === 'confirm'
    ? ['menunggu_bayar', 'menunggu_verifikasi', 'ditolak']
    : ['menunggu_verifikasi']
  if (!allowed.includes(order.payment_status)) {
    return { status: 409, body: { error: 'Status pembayaran sudah berubah. Muat ulang halaman.' } }
  }

  const paidAt = new Date().toISOString()
  const update = action === 'confirm'
    ? { payment_status: 'terverifikasi', paid_at: paidAt }
    : { payment_status: 'ditolak' }
  // Syarat status lama ikut di filter supaya dua klik bersamaan tidak memproses dua kali
  const { data: updated, error: updErr } = await supabase.from('orders')
    .update(update).eq('id', order.id).eq('payment_status', order.payment_status)
    .select('id')
  if (updErr) return { status: 500, body: { error: 'Gagal menyimpan keputusan' } }
  if (!updated?.length) return { status: 409, body: { error: 'Status pembayaran sudah berubah. Muat ulang halaman.' } }

  // Kabari pelanggan lewat WhatsApp bisnis
  const jid = order.customer_jid || (order.customer_wa ? `${order.customer_wa}@s.whatsapp.net` : null)
  const sock = session?.status === 'connected' ? session.sock : null
  let sent = false
  if (sock && jid) {
    try {
      const id = shortId(order.id)
      if (action === 'confirm') {
        const name = displayName(order.customer_name)
        await sock.sendMessage(jid, {
          text: `✅ *PEMBAYARAN DIKONFIRMASI*\n\nTerima kasih${name ? ` Kak ${name}` : ''}! 🙏\nPesanan *#${id}* segera kami siapkan 🚀`,
        })
        const { data: business } = await supabase.from('businesses')
          .select('business_name, address, wa_number').eq('id', businessId).single()
        await new Promise((r) => setTimeout(r, 800))
        await sendReceipt(sock, jid, receiptFromOrder(order, business || { business_name: 'Toko' }))
      } else {
        await sock.sendMessage(jid, {
          text: `Maaf kak, pembayaran untuk pesanan *#${id}* belum kami terima 🙏\n` +
            'Coba cek lagi riwayat transaksinya, lalu kirim ulang bukti bayar di chat ini ya.',
        })
      }
      sent = true
    } catch (err) {
      console.error(`❌ [${businessId}] Gagal kabari pelanggan (#${shortId(order.id)}):`, err?.message)
    }
  }
  console.log(`💳 [${businessId}] Pembayaran #${shortId(order.id)} ${action === 'confirm' ? 'dikonfirmasi' : 'ditolak'} penjual (pesan ${sent ? 'terkirim' : 'TIDAK terkirim'})`)
  return { status: 200, body: { ok: true, paymentStatus: update.payment_status, sent } }
}

// Hapus foto bukti pesanan lunas/dibatalkan yang lebih dari 30 hari.
// payment_proof_at tetap diisi sebagai tanda "pernah ada bukti" (dashboard: "dihapus otomatis").
export async function cleanupOldProofs() {
  const before = new Date(Date.now() - KEEP_DAYS * DAY_MS).toISOString()
  const { data, error } = await supabase.from('orders')
    .select('id, payment_proof_path')
    .not('payment_proof_path', 'is', null)
    .in('status', ['lunas', 'dibatalkan'])
    .lt('payment_proof_at', before)
    .limit(500)
  if (error) {
    console.error('❌ Cleanup bukti bayar: gagal baca pesanan:', error.message)
    return 0
  }
  if (!data?.length) return 0

  const { error: rmErr } = await supabase.storage.from(BUCKET).remove(data.map((o) => o.payment_proof_path))
  if (rmErr) {
    console.error('❌ Cleanup bukti bayar: gagal hapus file:', rmErr.message)
    return 0
  }
  await supabase.from('orders').update({ payment_proof_path: null }).in('id', data.map((o) => o.id))
  console.log(`🧹 ${data.length} foto bukti bayar lama (>${KEEP_DAYS} hari) dihapus`)
  return data.length
}

// Jalan 1 menit setelah start (tunggu sesi pulih), lalu tiap 24 jam
export function startProofCleanup() {
  const run = () => cleanupOldProofs().catch((err) => console.error('❌ Cleanup bukti bayar:', err?.message))
  setTimeout(run, 60_000).unref?.()
  setInterval(run, DAY_MS).unref?.()
}
