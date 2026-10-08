// Kejadian sesi WhatsApp & error bot → tabel bot_events (riwayat di /admin/whatsapp dan /admin/sistem).
// Jenis: bot_started | connected | disconnected | logged_out | qr_timeout | error | guard_blocked

import { fireInsert } from '../db/fireInsert.js'

export function logBotEvent(businessId, type, detail = null, client) {
  fireInsert('bot_events', {
    business_id: businessId || null,
    type: String(type).slice(0, 40),
    detail: detail === null || detail === undefined ? null : String(detail).slice(0, 300),
  }, client)
}
