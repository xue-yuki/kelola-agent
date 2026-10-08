// Insert "tembak lalu lupakan" untuk tabel catatan (ai_requests, bot_events).
// Tidak pernah melempar error dan tidak ditunggu, jadi balasan ke pelanggan tidak ikut lambat/gagal.
// Kalau tabel belum ada atau DB gangguan, peringatan dicetak paling sering 1x per 10 menit per tabel.

import supabase from './supabase.js'

const WARN_EVERY_MS = 10 * 60_000
const lastWarn = new Map() // table → timestamp

function warn(table, msg) {
  const now = Date.now()
  if (now - (lastWarn.get(table) || 0) < WARN_EVERY_MS) return
  lastWarn.set(table, now)
  console.warn(`⚠️ Gagal mencatat ke ${table} (diabaikan):`, msg)
}

export function fireInsert(table, row, client = supabase) {
  if (process.env.TELEMETRY_DISABLED === '1') return
  Promise.resolve()
    .then(() => client.from(table).insert(row))
    .then((res) => { if (res?.error) warn(table, res.error.message) })
    .catch((err) => warn(table, err?.message || err))
}
