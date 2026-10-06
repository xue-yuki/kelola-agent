// ─────────────────────────────────────────────────────────────────────
// Uji coba chat (pratinjau WhatsApp di halaman Asisten AI)
//
// Memakai prompt yang sama dengan bot asli (buildSystemPrompt) dengan pengaturan yang sedang
// diatur di dashboard, walau belum disimpan. Tidak menyimpan percakapan atau pesanan dan tidak
// mengirim apa pun ke WhatsApp. Tiap balasan AI memotong 1 kuota chat bulanan (keputusan pemilik).
// ─────────────────────────────────────────────────────────────────────

import supabase from '../db/supabase.js'
import { buildSystemPrompt, callAI } from './agent.js'
import { getBotSettings, nextOpenText, closedMessage } from '../bot/settings.js'

const MAX_MESSAGES = 20
const MAX_MESSAGE_LEN = 1000
const MAX_INSTRUCTIONS_LEN = 4000
const LIMIT = 30                 // pesan uji per toko per 10 menit
const WINDOW_MS = 10 * 60_000
const hits = new Map()           // businessId → [timestamp]

function rateLimited(businessId, now = Date.now()) {
  const recent = (hits.get(businessId) || []).filter((t) => now - t < WINDOW_MS)
  if (recent.length >= LIMIT) {
    hits.set(businessId, recent)
    return true
  }
  recent.push(now)
  hits.set(businessId, recent)
  return false
}

// Pengaturan dari dashboard (belum disimpan) di atas pengaturan tersimpan; nilai aneh diabaikan
export function applyOverride(base, o = {}) {
  const s = { ...base }
  if (typeof o.assistant_name === 'string') s.assistant_name = o.assistant_name.trim().slice(0, 40) || null
  if (typeof o.greeting === 'string' && o.greeting.trim()) s.greeting = o.greeting.trim().slice(0, 20)
  if (['singkat', 'natural', 'formal'].includes(o.reply_style)) s.reply_style = o.reply_style
  if (['auto_reply', 'ai_serve', 'silent'].includes(o.outside_hours_mode)) s.outside_hours_mode = o.outside_hours_mode
  if (typeof o.outside_hours_message === 'string') s.outside_hours_message = o.outside_hours_message.slice(0, 500) || null
  if (o.schedule === null || (o.schedule && typeof o.schedule === 'object' && !Array.isArray(o.schedule))) s.schedule = o.schedule
  if (['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'].includes(o.timezone)) s.timezone = o.timezone
  return s
}

/**
 * Balasan uji coba.
 * @param {{ businessId: string, messages: {role:'user'|'assistant', content:string}[],
 *           settings?: object, instructions?: string, closedTest?: boolean }} params
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function playgroundReply({ businessId, messages, settings: override, instructions, closedTest = false }) {
  const history = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_LEN) }))
  if (!history.length || history.at(-1).role !== 'user') {
    return { status: 400, body: { error: 'Tulis pesan uji dulu.' } }
  }

  const [{ data: business }, { data: products }] = await Promise.all([
    supabase.from('businesses').select('*').eq('id', businessId).maybeSingle(),
    supabase.from('products').select('name, price, stock').eq('business_id', businessId).gt('stock', 0),
  ])
  if (!business) return { status: 404, body: { error: 'Bisnis tidak ditemukan' } }

  const settings = applyOverride(await getBotSettings(businessId), override)
  const biz = {
    ...business,
    ai_instructions: typeof instructions === 'string'
      ? (instructions.slice(0, MAX_INSTRUCTIONS_LEN).trim() || null)
      : business.ai_instructions,
  }

  // Uji saat toko tutup: mode "diam" & "balas otomatis" tidak memanggil AI (tidak memotong kuota)
  let closedUntilText = null
  if (closedTest) {
    if (settings.outside_hours_mode === 'silent') {
      return { status: 200, body: { reply: null, notes: ['Di luar jam, bot diam dan tidak membalas.'] } }
    }
    if (settings.outside_hours_mode === 'auto_reply') {
      return {
        status: 200,
        body: { reply: closedMessage(settings, biz.business_name), notes: ['Pesan otomatis ini dikirim sekali per pelanggan selama toko tutup.'] },
      }
    }
    closedUntilText = nextOpenText(settings) || 'secepatnya'
  }

  if (rateLimited(businessId)) {
    return { status: 429, body: { error: 'Terlalu banyak pesan uji. Coba lagi beberapa menit lagi.' } }
  }

  // Kuota chat bulanan: pesan uji ikut dihitung. Gagal cek (DB error) → lanjut, seperti bot asli.
  let quota = null
  try {
    const { data: usage, error } = await supabase.rpc('consume_wa_chat', { p_business_id: businessId })
    const row = Array.isArray(usage) ? usage[0] : usage
    if (!error && row) {
      if (!row.allowed) return { status: 403, body: { error: 'Kuota chat AI bulan ini sudah habis.' } }
      quota = { used: row.used, quota: row.quota }
    }
  } catch (err) {
    console.error(`⚠️ [${businessId}] Uji coba: gagal cek kuota, lanjut:`, err?.message)
  }

  const ai = await callAI(buildSystemPrompt(biz, products || [], settings, { closedUntilText }), history)
  if (!ai.ok) return { status: 502, body: { error: 'AI sedang tidak bisa dihubungi. Coba lagi sebentar.' } }

  const notes = []
  if (/<ORDER>/.test(ai.reply)) notes.push('📦 Di chat asli, pesanan dibuat di sini lalu QRIS atau struk dikirim. Mode uji tidak membuat pesanan.')
  if (/<COMPLAINT>/.test(ai.reply)) notes.push('🚨 Di chat asli, komplain dicatat dan pemilik dikabari.')
  if (ai.reply.includes('<CALL_OWNER>')) notes.push('📞 Di chat asli, pemilik dikabari untuk membalas langsung.')
  const reply = ai.reply
    .replace(/<ORDER>.*?<\/ORDER>/s, '')
    .replace(/<COMPLAINT>.*?<\/COMPLAINT>/s, '')
    .replace(/<CALL_OWNER>/g, '')
    .trim()

  console.log(`🧪 [${businessId}] Uji coba chat${closedTest ? ' (toko tutup)' : ''}: ${reply.substring(0, 50)}...`)
  return { status: 200, body: { reply, notes, quota } }
}
