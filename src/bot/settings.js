// ─────────────────────────────────────────────────────────────────────
// Pengaturan bot per bisnis (halaman Bot WhatsApp di dashboard → tabel bot_settings)
//
// - Saklar nyala/mati, jam operasional + perilaku di luar jam
// - Persona: nama asisten, sapaan, gaya balasan (dipakai src/ai/agent.js)
// - Ambil alih manual: pemilik membalas sendiri dari HP → bot diam di chat itu X jam
// - Abaikan pesan basi: pesan yang tertahan > N menit tidak dibalas
// Logika jadwal sama dengan kelola.ai src/lib/botSchedule.ts — ubah keduanya bersamaan.
// ─────────────────────────────────────────────────────────────────────

import supabase from '../db/supabase.js'

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  schedule: null,               // null = 24 jam
  timezone: 'Asia/Jakarta',
  outside_hours_mode: 'auto_reply',
  outside_hours_message: null,
  assistant_name: null,
  greeting: 'Kak',
  reply_style: 'natural',
  takeover_enabled: true,
  takeover_hours: 3,
  ignore_stale_enabled: true,
  stale_minutes: 30,
})

export const DEFAULT_CLOSED_MESSAGE = 'Halo {sapaan} 🙏 {toko} sedang tutup. Kami buka lagi {buka}. Pesanmu sudah kami terima ya, nanti kami balas.'

const CACHE_MS = 60_000
const cache = new Map() // businessId → { at, settings }

// Pengaturan bot (cache 60 detik). Gagal baca DB → nilai bawaan (bot tetap jalan).
export async function getBotSettings(businessId) {
  const hit = cache.get(businessId)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.settings
  let settings = { ...DEFAULT_SETTINGS, business_name: null }
  try {
    const [{ data, error }, { data: business }] = await Promise.all([
      supabase.from('bot_settings').select('*').eq('business_id', businessId).maybeSingle(),
      supabase.from('businesses').select('business_name').eq('id', businessId).maybeSingle(),
    ])
    settings.business_name = business?.business_name ?? null
    if (error) console.error(`⚠️ [${businessId}] Gagal baca bot_settings, pakai bawaan:`, error.message)
    else if (data) {
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (data[key] !== null && data[key] !== undefined) settings[key] = data[key]
      }
      settings.schedule = data.schedule ?? null
    }
  } catch (err) {
    console.error(`⚠️ [${businessId}] Gagal baca bot_settings, pakai bawaan:`, err?.message)
  }
  cache.set(businessId, { at: Date.now(), settings })
  return settings
}

// ─── Jadwal ──────────────────────────────────────────────────────────
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DAY_NAMES = { sun: 'Minggu', mon: 'Senin', tue: 'Selasa', wed: 'Rabu', thu: 'Kamis', fri: 'Jumat', sat: 'Sabtu' }

const toMinutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''))
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
const fmtTime = (hhmm) => String(hhmm).replace(':', '.')

// Hari (0=Minggu) & menit sejak tengah malam di zona waktu toko
function localNow(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((p) => [p.type, p.value]))
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)
  return { day, minutes: Number(parts.hour) * 60 + Number(parts.minute) }
}

// Rentang buka hari tertentu: { open, close } menit; close ≤ open = lewat tengah malam
function hoursOf(schedule, day) {
  const h = schedule?.[DAYS[day]]
  if (!Array.isArray(h) || h.length !== 2) return null
  const open = toMinutes(h[0])
  const close = toMinutes(h[1])
  if (open === null || close === null) return null
  return { open, close, openText: fmtTime(h[0]) }
}

export function isOpenNow(settings, now = new Date()) {
  const schedule = settings?.schedule
  if (!schedule) return true
  const { day, minutes } = localNow(now, settings.timezone || 'Asia/Jakarta')
  const today = hoursOf(schedule, day)
  if (today) {
    if (today.close > today.open ? minutes >= today.open && minutes < today.close : minutes >= today.open) return true
  }
  // Sisa jam buka kemarin yang lewat tengah malam (mis. 18:00–02:00)
  const yesterday = hoursOf(schedule, (day + 6) % 7)
  return !!(yesterday && yesterday.close <= yesterday.open && minutes < yesterday.close)
}

// "hari ini 07.00" / "besok 07.00" / "Senin 07.00"; null kalau tidak ada jadwal buka sama sekali
export function nextOpenText(settings, now = new Date()) {
  const schedule = settings?.schedule
  if (!schedule) return null
  const { day, minutes } = localNow(now, settings.timezone || 'Asia/Jakarta')
  for (let offset = 0; offset < 8; offset++) {
    const d = (day + offset) % 7
    const h = hoursOf(schedule, d)
    if (!h || (offset === 0 && h.open <= minutes)) continue
    if (offset === 0) return `hari ini ${h.openText}`
    if (offset === 1) return `besok ${h.openText}`
    return `${DAY_NAMES[DAYS[d]]} ${h.openText}`
  }
  return null
}

// Pesan otomatis di luar jam dengan {sapaan}, {toko}, {buka} terisi
export function closedMessage(settings, businessName, now = new Date()) {
  const template = (settings.outside_hours_message || '').trim() || DEFAULT_CLOSED_MESSAGE
  return template
    .replaceAll('{sapaan}', (settings.greeting || 'Kak').toLowerCase() === 'kak' ? 'kak' : settings.greeting)
    .replaceAll('{toko}', businessName || 'Toko kami')
    .replaceAll('{buka}', nextOpenText(settings, now) || 'secepatnya')
}

// ─── Pesan yang dikirim bot sendiri (supaya tidak dikira balasan manual pemilik) ──
const SENT_TTL_MS = 10 * 60_000
const botSent = new Map() // messageId → expiresAt

export function rememberSent(id) {
  if (!id) return
  const now = Date.now()
  botSent.set(id, now + SENT_TTL_MS)
  if (botSent.size > 5000) for (const [k, exp] of botSent) if (exp < now) botSent.delete(k)
}
export function isBotSent(id) {
  const exp = botSent.get(id)
  if (!exp) return false
  if (exp < Date.now()) { botSent.delete(id); return false }
  return true
}

// ─── Ambil alih manual ───────────────────────────────────────────────
const ownerReplies = new Map() // `${businessId}:${jid}` → waktu balasan manual terakhir (ms)

export function markOwnerReply(businessId, jid, at = Date.now()) {
  const key = `${businessId}:${jid}`
  if ((ownerReplies.get(key) || 0) < at) ownerReplies.set(key, at)
}
export function isTakenOver(businessId, jid, settings, now = Date.now()) {
  if (!settings?.takeover_enabled) return false
  const at = ownerReplies.get(`${businessId}:${jid}`)
  return !!at && now - at < (settings.takeover_hours || 3) * 3_600_000
}

// ─── Pesan otomatis di luar jam: maksimal sekali per 6 jam per chat ──
const CLOSED_NOTICE_MS = 6 * 3_600_000
const closedNotices = new Map()
export function shouldSendClosedNotice(businessId, jid, now = Date.now()) {
  const key = `${businessId}:${jid}`
  const last = closedNotices.get(key)
  if (last && now - last < CLOSED_NOTICE_MS) return false
  closedNotices.set(key, now)
  return true
}

// Umur pesan (ms) dari messageTimestamp Baileys (detik; bisa Long)
export function messageAgeMs(msg, now = Date.now()) {
  const ts = Number(msg?.messageTimestamp?.toString?.() ?? msg?.messageTimestamp)
  return Number.isFinite(ts) && ts > 0 ? now - ts * 1000 : 0
}
