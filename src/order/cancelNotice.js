// Kabari pelanggan WA bahwa pesanannya dibatalkan penjual.
// Dashboard → rpc cancel_order (status + kembalikan stok, migrasi "cancel_order") → agent-proxy →
// POST /api/order-cancel/:businessId → notifyOrderCancelled di sini.
// Hanya pesanan yang BARU dibatalkan (≤ 15 menit) yang dikabari, supaya endpoint ini tidak bisa
// dipakai mengirim ulang pesan untuk pesanan lama.

import supabase from '../db/supabase.js'
import { rupiah } from '../receipt/receipt.js'
import { getBotSettings } from '../bot/settings.js'

const RECENT_MS = 15 * 60 * 1000

const shortId = (id) => String(id).slice(0, 8).toUpperCase()
const displayName = (name) => (name && !/^\+?\d{6,}$/.test(String(name).trim()) ? String(name).trim() : '')

export function cancelMessage(order, { greeting = 'Kak', businessName = '' } = {}) {
  let items = order.items
  if (typeof items === 'string') {
    try { items = JSON.parse(items) } catch { items = [] }
  }
  const lines = (Array.isArray(items) ? items : [])
    .filter((it) => it && it.name)
    .map((it) => `• ${it.name} x${Number(it.qty ?? it.quantity) || 1}`)

  const name = displayName(order.customer_name)
  const sapa = [greeting, name].filter(Boolean).join(' ')
  const paidQris = order.payment_method === 'qris' && order.payment_status === 'terverifikasi'

  return [
    `Maaf ${sapa} 🙏`,
    `Pesanan *#${shortId(order.id)}*${businessName ? ` di ${businessName}` : ''} kami batalkan.`,
    '',
    ...lines,
    `Total: ${rupiah(order.total)}`,
    ...(order.cancel_reason ? ['', `Alasan: ${order.cancel_reason}`] : []),
    ...(paidQris ? ['', 'Untuk pengembalian dana QRIS yang sudah dibayar, kami bantu lewat chat ini ya.'] : []),
    '',
    'Mohon maaf atas ketidaknyamanannya.',
  ].join('\n')
}

export async function notifyOrderCancelled({ businessId, orderId, session }) {
  const { data: order, error } = await supabase.from('orders')
    .select('id, items, total, customer_name, customer_wa, customer_jid, payment_method, payment_status, status, cancel_reason, cancelled_at')
    .eq('id', orderId).eq('business_id', businessId).maybeSingle()
  if (error) return { status: 500, body: { error: 'Gagal membaca pesanan' } }
  if (!order) return { status: 404, body: { error: 'Pesanan tidak ditemukan' } }
  if (order.status !== 'dibatalkan' || !order.cancelled_at) {
    return { status: 409, body: { error: 'Pesanan belum dibatalkan' } }
  }
  if (Date.now() - new Date(order.cancelled_at).getTime() > RECENT_MS) {
    return { status: 409, body: { error: 'Pembatalan sudah lama, kabari pelanggan lewat chat biasa' } }
  }

  const jid = order.customer_jid || (order.customer_wa ? `${order.customer_wa}@s.whatsapp.net` : null)
  if (!jid) return { status: 400, body: { error: 'Pesanan ini tidak punya nomor WhatsApp pelanggan' } }

  const sock = session?.status === 'connected' ? session.sock : null
  let sent = false
  if (sock) {
    try {
      const settings = await getBotSettings(businessId)
      await sock.sendMessage(jid, {
        text: cancelMessage(order, { greeting: (settings.greeting || 'Kak').trim(), businessName: settings.business_name || '' }),
      })
      sent = true
    } catch (err) {
      console.error(`❌ [${businessId}] Gagal kabari pembatalan #${shortId(order.id)}:`, err?.message)
    }
  }
  console.log(`🚫 [${businessId}] Pesanan #${shortId(order.id)} dibatalkan penjual (pesan ${sent ? 'terkirim' : 'TIDAK terkirim'})`)
  return { status: 200, body: { ok: true, sent } }
}
