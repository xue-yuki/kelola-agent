// Catatan pemakaian AI per panggilan → tabel ai_requests (dibaca dashboard admin /admin/ai).
// TANPA isi pesan/prompt: hanya toko, fitur, model, token, latensi, dan status.

import { fireInsert } from '../db/fireInsert.js'

const FEATURES = new Set(['wa_chat', 'playground', 'tanya_kelola', 'insight', 'katalog'])
const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null)

/**
 * @param {{ businessId?: string|null, feature: string, model?: string|null, servedModel?: string|null,
 *           usage?: { prompt_tokens?: number, completion_tokens?: number, total_tokens?: number }|null,
 *           latencyMs?: number, status: 'ok'|'error'|'timeout', error?: string|null }} r
 */
export function aiRequestRow(r) {
  const u = r.usage || {}
  const prompt = int(u.prompt_tokens)
  const completion = int(u.completion_tokens)
  return {
    business_id: r.businessId || null,
    feature: FEATURES.has(r.feature) ? r.feature : 'wa_chat',
    model: r.model ? String(r.model).slice(0, 120) : null,
    served_model: r.servedModel ? String(r.servedModel).slice(0, 120) : null,
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: int(u.total_tokens) ?? (prompt !== null || completion !== null ? (prompt || 0) + (completion || 0) : null),
    latency_ms: int(r.latencyMs),
    status: ['ok', 'error', 'timeout'].includes(r.status) ? r.status : 'error',
    error: r.error ? String(r.error).slice(0, 300) : null,
  }
}

export function logAiRequest(r, client) {
  fireInsert('ai_requests', aiRequestRow(r), client)
}
