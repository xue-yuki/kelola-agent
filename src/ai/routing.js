// Model AI per fitur, diatur admin di Kelola Control (/admin/model) → system_settings key "ai_routing"
// berisi JSON { wa_chat, playground, tanya_kelola, insight, katalog } (nilai = nama model/combo 9Router).
// Dibaca dengan cache 60 detik. Fitur tanpa pilihan, atau DB gagal dibaca → env AI_PAAS_MODEL (perilaku lama).

import supabase from '../db/supabase.js'

const CACHE_MS = 60_000
const MODEL_RE = /^[\w.\-/:]{1,120}$/
let cache = { at: -Infinity, routing: {} } // -Infinity = belum pernah dibaca

export const defaultModel = () => process.env.AI_PAAS_MODEL || 'gemini-3.5-flash-lite'

const LOAD_TIMEOUT_MS = 3000 // DB lambat tidak boleh menahan balasan ke pelanggan

async function loadRouting(client) {
  const query = client.from('system_settings').select('value').eq('key', 'ai_routing').maybeSingle()
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout membaca ai_routing')), LOAD_TIMEOUT_MS).unref?.())
  const { data, error } = await Promise.race([query, timeout])
  if (error) throw error
  if (!data?.value) return {}
  const parsed = JSON.parse(data.value)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

/** Model untuk satu fitur (wa_chat, playground, ...). Tidak pernah melempar error. */
export async function modelFor(feature, { client = supabase, now = Date.now() } = {}) {
  if (now - cache.at >= CACHE_MS) {
    try {
      cache = { at: now, routing: await loadRouting(client) }
    } catch (err) {
      // Pakai routing terakhir yang berhasil dibaca; coba lagi 60 detik kemudian
      console.warn('⚠️ Gagal membaca ai_routing, pakai routing terakhir/env:', err?.message || err)
      cache = { at: now, routing: cache.routing }
    }
  }
  const picked = cache.routing?.[feature]
  return typeof picked === 'string' && MODEL_RE.test(picked) ? picked : defaultModel()
}

/** Untuk tes. */
export function _resetRoutingCache() {
  cache = { at: -Infinity, routing: {} }
}
