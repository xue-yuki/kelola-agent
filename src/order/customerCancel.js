// Pelanggan membatalkan / mengubah pesanan lewat chat bot.
// - Prompt bot diberi daftar pesanan pelanggan yang belum selesai (openOrdersPrompt), supaya AI bisa
//   menyebut nomor & isi pesanan saat minta konfirmasi.
// - AI menulis <CANCEL_ORDER>{"order":"4F2A9C1D","reason":"…"}</CANCEL_ORDER>, atau field "replaces"
//   di tag ORDER untuk mengubah pesanan. AI tidak memutuskan sendiri: server mencocokkan nomor dengan
//   pesanan milik pelanggan ini, lalu fungsi database cancel_order_by_customer memeriksa ulang
//   (hanya "menunggu" & belum dibayar) sambil mengunci baris pesanan.
// - Sudah diproses/dikirim/dibayar → dicatat sebagai permintaan (cancel_requested_at), penjual
//   memutuskan di dashboard. Migrasi: kelola.ai docs/database/2026-10-07_cancel_order_customer.sql.

import supabase from '../db/supabase.js'
import { rupiah } from '../receipt/receipt.js'

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_ORDER_AGE_DAYS = 7
const OPEN = ['menunggu', 'diproses', 'dikirim']
const STATUS_TEXT = {
  menunggu: 'Menunggu (belum diproses penjual)',
  diproses: 'Diproses (sedang disiapkan penjual)',
  dikirim: 'Dikirim (sedang diantar)',
}

export const shortId = (id) => String(id).slice(0, 8).toUpperCase()
const displayName = (name) => (name && !/^\+?\d{6,}$/.test(String(name).trim()) ? String(name).trim() : '')
const cleanText = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

function itemsOf(order) {
  let items = order.items
  if (typeof items === 'string') {
    try { items = JSON.parse(items) } catch { items = [] }
  }
  return Array.isArray(items) ? items.filter((it) => it && it.name) : []
}
const qtyOf = (it) => Number(it.qty ?? it.quantity) || 1
const itemLine = (order) => itemsOf(order).map((it) => `${it.name} x${qtyOf(it)}`).join(', ')
const itemList = (items) => items.map((it) => `• ${it.name} x${qtyOf(it)}`).join('\n')

/** Pesanan pelanggan ini yang belum selesai (7 hari terakhir, paling baru dulu). */
export async function getOpenOrders(businessId, customerWa, jid) {
  const who = jid ? `customer_jid.eq."${jid}",customer_wa.eq."${customerWa}"` : `customer_wa.eq."${customerWa}"`
  const { data, error } = await supabase.from('orders')
    .select('id, items, total, status, payment_method, payment_status, customer_name, created_at, cancel_requested_at')
    .eq('business_id', businessId)
    .in('status', OPEN)
    .or(who)
    .gte('created_at', new Date(Date.now() - MAX_ORDER_AGE_DAYS * DAY_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(3)
  if (error) console.error(`⚠️ [${businessId}] Gagal baca pesanan aktif pelanggan:`, error.message)
  return data || []
}

/** Bagian prompt: daftar pesanan aktif pelanggan. */
export function openOrdersPrompt(orders) {
  if (!orders?.length) return '(tidak ada)'
  return orders.map((o) => {
    const pay = o.payment_method === 'qris'
      ? (o.payment_status === 'terverifikasi' ? 'QRIS sudah dibayar' : 'QRIS')
      : 'COD'
    return `- #${shortId(o.id)} · ${STATUS_TEXT[o.status] || o.status} · ${itemLine(o)} · Total ${rupiah(o.total)} · ${pay}`
  }).join('\n')
}

/** Cocokkan nomor dari AI ("#4f2a9c1d", "4F2A9C1D") dengan pesanan aktif pelanggan. */
export function findCustomerOrder(orders, ref) {
  const key = String(ref ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  if (key.length < 6) return null
  return orders.find((o) => String(o.id).replace(/-/g, '').toLowerCase().startsWith(key)) || null
}

/** Pesanan yang boleh dibatalkan pelanggan sendiri (diperiksa ulang di database). */
export function canCustomerCancel(order) {
  return order.status === 'menunggu' && !['terverifikasi', 'menunggu_verifikasi'].includes(order.payment_status)
}

/** Stok yang "dipegang" pesanan lama, untuk validasi pesanan pengganti: product_id → qty. */
export function heldStock(order) {
  const held = new Map()
  for (const it of itemsOf(order)) {
    if (it.product_id) held.set(it.product_id, (held.get(it.product_id) || 0) + qtyOf(it))
  }
  return held
}

export async function cancelByCustomer(orderId, reason) {
  const { data, error } = await supabase.rpc('cancel_order_by_customer', { p_order_id: orderId, p_reason: reason || null })
  if (error) {
    console.error(`❌ Gagal batalkan pesanan #${shortId(orderId)} (pelanggan):`, error.message)
    return { ok: false, code: 'error' }
  }
  return data || { ok: false, code: 'error' }
}

async function requestCancel(order, note) {
  const { error } = await supabase.from('orders')
    .update({ cancel_requested_at: new Date().toISOString(), cancel_request_note: cleanText(note, 300) })
    .eq('id', order.id)
  if (error) console.error(`❌ Gagal catat permintaan batal #${shortId(order.id)}:`, error.message)
}

const whyNot = (order, code) =>
  code === 'paid' ? 'sudah dibayar'
    : order.status === 'dikirim' ? 'sedang diantar'
      : 'sudah kami proses'

/**
 * Tag <CANCEL_ORDER> dari AI.
 * @returns {Promise<{reply: string, ownerNotif: string|null}>}
 */
export async function handleCancelTag({ raw, openOrders, greeting = 'Kak' }) {
  let tag = {}
  try { tag = JSON.parse(String(raw).trim().replace(/^```json\s*/, '').replace(/```$/, '').trim()) } catch { /* tag rusak */ }

  if (!openOrders.length) {
    return { reply: `Maaf ${greeting}, tidak ada pesanan aktif yang bisa dibatalkan 🙏`, ownerNotif: null }
  }
  const order = findCustomerOrder(openOrders, tag.order) || (openOrders.length === 1 ? openOrders[0] : null)
  if (!order) {
    const list = openOrders.map((o) => `• *#${shortId(o.id)}*: ${itemLine(o)} (${rupiah(o.total)})`).join('\n')
    return { reply: `Pesanan yang mana yang mau dibatalkan, ${greeting}?\n\n${list}`, ownerNotif: null }
  }

  const id = shortId(order.id)
  const reason = cleanText(tag.reason, 150)
  const name = displayName(order.customer_name) || 'Pelanggan'
  const result = await cancelByCustomer(order.id, reason)

  if (result.ok) {
    console.log(`🚫 Pesanan #${id} dibatalkan pelanggan`)
    return {
      reply: `✅ Pesanan *#${id}* sudah dibatalkan, ${greeting}.` +
        (order.payment_method === 'qris' ? ' QRIS-nya tidak perlu dibayar ya.' : '') +
        '\nKalau mau pesan lagi, tinggal chat aja 🙏',
      ownerNotif: `❌ *PESANAN DIBATALKAN PELANGGAN*\n\n` +
        `👤 *Pelanggan:* ${name}\n` +
        `🧾 *Pesanan:* #${id} · ${rupiah(order.total)}\n` +
        `📦 *Item:*\n${itemList(itemsOf(order))}\n` +
        (reason ? `📝 *Alasan:* ${reason}\n` : '') +
        `\n_Stok sudah dikembalikan otomatis._`,
    }
  }
  if (result.code === 'already_cancelled') {
    return { reply: `Pesanan *#${id}* sudah dibatalkan sebelumnya, ${greeting} 🙏`, ownerNotif: null }
  }

  // Sudah diproses / dibayar / gagal: penjual yang memutuskan
  await requestCancel(order, reason ? `Minta batal: ${reason}` : 'Minta batal')
  return {
    reply: `Pesanan *#${id}* ${whyNot(order, result.code)}, jadi pembatalannya perlu persetujuan penjual. ` +
      `Permintaan ${greeting} sudah aku sampaikan ya 🙏`,
    ownerNotif: `⚠️ *PELANGGAN MINTA BATAL*\n\n` +
      `👤 *Pelanggan:* ${name}\n` +
      `🧾 *Pesanan:* #${id} · ${STATUS_TEXT[order.status]?.split(' (')[0] || order.status} · ${rupiah(order.total)}\n` +
      (reason ? `📝 *Alasan:* ${reason}\n` : '') +
      `\n_Buka dashboard → Pesanan untuk membatalkan atau mengabaikan._`,
  }
}

/**
 * Pesanan lama tidak bisa diganti otomatis (sudah diproses/dibayar): catat permintaan ubah.
 * @returns {Promise<{reply: string, ownerNotif: string}>}
 */
export async function requestChange({ order, newItems, greeting = 'Kak', code = 'processed' }) {
  const id = shortId(order.id)
  const wanted = (Array.isArray(newItems) ? newItems : []).filter((it) => it && it.name)
  await requestCancel(order, `Minta ubah: ${wanted.map((it) => `${it.name} x${qtyOf(it)}`).join(', ')}`)
  return {
    reply: `Pesanan *#${id}* ${whyNot(order, code)}, jadi perubahannya perlu persetujuan penjual. ` +
      `Permintaan ${greeting} sudah aku sampaikan ya 🙏`,
    ownerNotif: `✏️ *PELANGGAN MINTA UBAH PESANAN*\n\n` +
      `👤 *Pelanggan:* ${displayName(order.customer_name) || 'Pelanggan'}\n` +
      `🧾 *Pesanan:* #${id} · ${STATUS_TEXT[order.status]?.split(' (')[0] || order.status} · ${rupiah(order.total)}\n` +
      `📦 *Mau diubah jadi:*\n${itemList(wanted)}\n` +
      `\n_Hubungi pelanggan, atau batalkan pesanan di dashboard lalu minta pelanggan pesan ulang._`,
  }
}
