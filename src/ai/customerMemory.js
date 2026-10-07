// Ingatan pelanggan untuk bot: nama & alamat yang tersimpan dimasukkan ke prompt, supaya pelanggan
// langganan tidak ditanya ulang. AI menulis <CUSTOMER>{"name","address","label"}</CUSTOMER> begitu
// pelanggan menyebut nama/alamat baru, dan server langsung menyimpannya (tidak menunggu pesanan jadi).
// Alamat bisa lebih dari satu (tabel customer_addresses, maks. 5, label mis. Rumah/Kantor ditebak dari
// chat). customers.address = alamat yang terakhir dipakai (trigger di database).
// Migrasi: kelola.ai docs/database/2026-10-07_customer_addresses.sql.

import supabase from '../db/supabase.js'

export const MAX_ADDRESSES = 5

export const cleanText = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
// customers.name diisi nomor WA kalau nama belum diketahui
const realName = (name, wa) => {
  const n = String(name ?? '').trim()
  return n && n !== wa && !/^\+?\d{6,}$/.test(n) ? n : ''
}
// "Jl. Mawar 1, RT 2" dan "jl mawar 1 rt 2" dianggap alamat yang sama
export const normAddr = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const cleanLabel = (v) => {
  const l = cleanText(v, 40)
  return l ? l.charAt(0).toUpperCase() + l.slice(1) : null
}

function itemLine(items) {
  let list = items
  if (typeof list === 'string') {
    try { list = JSON.parse(list) } catch { list = [] }
  }
  return (Array.isArray(list) ? list : []).filter((it) => it && it.name)
    .map((it) => `${it.name} x${Number(it.qty ?? it.quantity) || 1}`).join(', ')
}

const DATE_FMT = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', timeZone: 'Asia/Jakarta' })

async function listAddresses(customerId) {
  if (!customerId) return []
  const { data } = await supabase.from('customer_addresses').select('id, label, address, last_used_at')
    .eq('customer_id', customerId).order('last_used_at', { ascending: false }).limit(MAX_ADDRESSES)
  return data || []
}

/** Data pelanggan tersimpan: nama, alamat (terbaru dulu), pesanan selesai terakhir. */
export async function getCustomerProfile(businessId, customerWa) {
  const [{ data: customer }, { data: lastOrders }] = await Promise.all([
    supabase.from('customers').select('id, name, address')
      .eq('business_id', businessId).eq('wa_number', customerWa).maybeSingle(),
    supabase.from('orders').select('items, created_at')
      .eq('business_id', businessId).eq('customer_wa', customerWa).eq('status', 'lunas')
      .order('created_at', { ascending: false }).limit(1),
  ])
  const addresses = await listAddresses(customer?.id)
  return {
    id: customer?.id ?? null,
    name: realName(customer?.name, customerWa),
    addresses,
    address: addresses[0]?.address || cleanText(customer?.address, 250),
    lastOrder: lastOrders?.[0] ? { items: itemLine(lastOrders[0].items), at: lastOrders[0].created_at } : null,
  }
}

const addrLine = (a) => (a.label ? `[${a.label}] ${a.address}` : a.address)

/** Bagian prompt: data pelanggan tersimpan. */
export function customerPrompt(profile) {
  const addresses = profile?.addresses?.length
    ? profile.addresses
    : (profile?.address ? [{ address: profile.address, label: null }] : [])
  if (!profile || (!profile.name && !addresses.length && !profile.lastOrder)) {
    return '(pelanggan baru, belum ada data tersimpan)'
  }
  const alamat = addresses.length === 0 ? '- Alamat: (belum diketahui)'
    : addresses.length === 1 ? `- Alamat tersimpan: ${addrLine(addresses[0])}`
      : `- Alamat tersimpan (paling baru dipakai di atas):\n${addresses.map((a, i) => `  ${i + 1}. ${addrLine(a)}`).join('\n')}`
  return [
    `- Nama: ${profile.name || '(belum diketahui)'}`,
    alamat,
    profile.lastOrder ? `- Pesanan terakhir: ${DATE_FMT.format(new Date(profile.lastOrder.at))} · ${profile.lastOrder.items}` : null,
  ].filter(Boolean).join('\n')
}

/** Alamat tersimpan yang sama dengan teks ini (untuk label pesanan). */
export function findSavedAddress(addresses, address) {
  const key = normAddr(address)
  return key ? (addresses || []).find((a) => normAddr(a.address) === key) || null : null
}

async function customerIdFor(businessId, customerWa) {
  const { data } = await supabase.from('customers').select('id')
    .eq('business_id', businessId).eq('wa_number', customerWa).maybeSingle()
  return data?.id ?? null
}

/**
 * Catat alamat yang dipakai/disebut pelanggan:
 * - alamat yang sama sudah ada → tandai terakhir dipakai (label diisi kalau sebelumnya kosong)
 * - label yang sama sudah ada ("kantor saya pindah ke …") → alamat label itu diganti
 * - selain itu → alamat baru; lebih dari 5 → yang paling lama tidak dipakai dihapus
 * @returns {Promise<{address: string, label: string|null}|null>}
 */
export async function rememberAddress({ businessId, customerWa, customerId = null, address, label = null, known = null }) {
  const text = cleanText(address, 250)
  if (text.length < 5) return null
  const id = customerId || await customerIdFor(businessId, customerWa)
  if (!id) return null
  const lab = cleanLabel(label)
  const list = known ?? await listAddresses(id)
  const now = new Date().toISOString()

  const same = findSavedAddress(list, text)
  if (same) {
    const newLabel = same.label || lab
    await supabase.from('customer_addresses').update({ last_used_at: now, label: newLabel }).eq('id', same.id)
    return { address: same.address, label: newLabel }
  }
  const sameLabel = lab ? list.find((a) => a.label && a.label.toLowerCase() === lab.toLowerCase()) : null
  if (sameLabel) {
    const { error } = await supabase.from('customer_addresses').update({ address: text, last_used_at: now }).eq('id', sameLabel.id)
    if (error) console.error(`⚠️ [${businessId}] Gagal ganti alamat ${lab} (${customerWa}):`, error.message)
    return { address: text, label: sameLabel.label }
  }
  const { error } = await supabase.from('customer_addresses')
    .insert({ business_id: businessId, customer_id: id, label: lab, address: text, last_used_at: now })
  if (error) {
    console.error(`⚠️ [${businessId}] Gagal simpan alamat ${customerWa}:`, error.message)
    return null
  }
  // Maks. 5 alamat: buang yang paling lama tidak dipakai
  const { data: all } = await supabase.from('customer_addresses').select('id')
    .eq('customer_id', id).order('last_used_at', { ascending: false })
  const extra = (all || []).slice(MAX_ADDRESSES).map((a) => a.id)
  if (extra.length) await supabase.from('customer_addresses').delete().in('id', extra)
  return { address: text, label: lab }
}

/**
 * Simpan nama/alamat dari tag <CUSTOMER> (hanya untuk nomor pelanggan ini sendiri).
 * Alamat baru ikut dimasukkan ke profile.addresses supaya pesanan di balasan yang sama dapat labelnya.
 * @returns {Promise<boolean>} true kalau ada yang disimpan
 */
export async function saveCustomerFromTag(businessId, customerWa, raw, profile) {
  let tag = {}
  try { tag = JSON.parse(String(raw).trim().replace(/^```json\s*/, '').replace(/```$/, '').trim()) } catch { return false }
  const name = cleanText(tag.name, 80)
  const address = cleanText(tag.address, 250)
  const newName = name && name !== profile?.name && !/^\+?\d{6,}$/.test(name) ? name : null

  let customerId = profile?.id ?? null
  if (!customerId && (newName || address.length >= 5)) {
    const { data, error } = await supabase.from('customers')
      .insert({ business_id: businessId, wa_number: customerWa, name: newName || customerWa, address: '' })
      .select('id').single()
    if (error) {
      console.error(`⚠️ [${businessId}] Gagal simpan data pelanggan ${customerWa}:`, error.message)
      return false
    }
    customerId = data.id
    if (profile) profile.id = customerId
  } else if (newName) {
    const { error } = await supabase.from('customers').update({ name: newName }).eq('id', customerId)
    if (error) console.error(`⚠️ [${businessId}] Gagal simpan nama ${customerWa}:`, error.message)
  }
  if (newName && profile) profile.name = newName

  let saved = null
  if (address.length >= 5) {
    saved = await rememberAddress({ businessId, customerWa, customerId, address, label: tag.label, known: profile?.addresses })
    if (saved && profile) {
      profile.addresses = [saved, ...(profile.addresses || []).filter((a) => normAddr(a.address) !== normAddr(saved.address) && !(saved.label && a.label === saved.label))]
      profile.address = saved.address
    }
  }
  return !!(newName || saved)
}
