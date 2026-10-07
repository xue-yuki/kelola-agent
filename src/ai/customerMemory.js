// Ingatan pelanggan untuk bot: nama & alamat yang tersimpan (tabel customers) dimasukkan ke prompt,
// supaya pelanggan langganan tidak ditanya ulang. AI menulis <CUSTOMER>{"name","address"}</CUSTOMER>
// begitu pelanggan menyebut nama/alamat (baru), dan server langsung menyimpannya, tidak menunggu
// pesanan jadi. Pesanan tetap memperbarui data ini juga (agent.js saveOrder).

import supabase from '../db/supabase.js'

export const cleanText = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
// customers.name diisi nomor WA kalau nama belum diketahui
const realName = (name, wa) => {
  const n = String(name ?? '').trim()
  return n && n !== wa && !/^\+?\d{6,}$/.test(n) ? n : ''
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

/** Data pelanggan tersimpan + pesanan selesai terakhir. */
export async function getCustomerProfile(businessId, customerWa) {
  const [{ data: customer }, { data: lastOrders }] = await Promise.all([
    supabase.from('customers').select('id, name, address')
      .eq('business_id', businessId).eq('wa_number', customerWa).maybeSingle(),
    supabase.from('orders').select('items, created_at')
      .eq('business_id', businessId).eq('customer_wa', customerWa).eq('status', 'lunas')
      .order('created_at', { ascending: false }).limit(1),
  ])
  return {
    id: customer?.id ?? null,
    name: realName(customer?.name, customerWa),
    address: cleanText(customer?.address, 250),
    lastOrder: lastOrders?.[0] ? { items: itemLine(lastOrders[0].items), at: lastOrders[0].created_at } : null,
  }
}

/** Bagian prompt: data pelanggan tersimpan. */
export function customerPrompt(profile) {
  if (!profile || (!profile.name && !profile.address && !profile.lastOrder)) {
    return '(pelanggan baru, belum ada data tersimpan)'
  }
  return [
    `- Nama: ${profile.name || '(belum diketahui)'}`,
    `- Alamat terakhir: ${profile.address || '(belum diketahui)'}`,
    profile.lastOrder ? `- Pesanan terakhir: ${DATE_FMT.format(new Date(profile.lastOrder.at))} · ${profile.lastOrder.items}` : null,
  ].filter(Boolean).join('\n')
}

/**
 * Simpan nama/alamat dari tag <CUSTOMER> (hanya untuk nomor pelanggan ini sendiri).
 * @returns {Promise<boolean>} true kalau ada yang disimpan
 */
export async function saveCustomerFromTag(businessId, customerWa, raw, profile) {
  let tag = {}
  try { tag = JSON.parse(String(raw).trim().replace(/^```json\s*/, '').replace(/```$/, '').trim()) } catch { return false }
  const name = cleanText(tag.name, 80)
  const address = cleanText(tag.address, 250)
  const fields = {}
  if (name && name !== profile?.name && !/^\+?\d{6,}$/.test(name)) fields.name = name
  if (address.length >= 5 && address !== profile?.address) fields.address = address
  if (!Object.keys(fields).length) return false

  const { error } = profile?.id
    ? await supabase.from('customers').update(fields).eq('id', profile.id)
    : await supabase.from('customers').insert({ business_id: businessId, wa_number: customerWa, name: fields.name || customerWa, address: fields.address || '' })
  if (error) {
    console.error(`⚠️ [${businessId}] Gagal simpan data pelanggan ${customerWa}:`, error.message)
    return false
  }
  return true
}
