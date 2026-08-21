// ─────────────────────────────────────────────────────────────────────
// QRIS Payment Module (DEMO MODE — Opsi 3A)
//
// Alur:
//   1. generateQrisForOrder() — bikin payload QRIS dummy + PNG buffer
//   2. scheduleAutoConfirm() — timer auto-lunas setelah X detik (fake "customer bayar")
//   3. Setelah lunas → supabase update + trigger callback (kirim notif WA)
//
// Catetan: payload di QR ini BUKAN QRIS real, cuma URL internal biar
// kalau di-scan dari kamera HP bakal buka halaman konfirmasi (opsional Phase 2).
// Buat production, replace generateQrisForOrder() dengan call ke Midtrans/Xendit.
// ─────────────────────────────────────────────────────────────────────

import QRCode from 'qrcode'
import supabase from '../db/supabase.js'

// Config
const AUTO_CONFIRM_DELAY_MS = parseInt(process.env.QRIS_AUTO_CONFIRM_MS || '20000') // 20 detik
const QRIS_EXPIRY_MINUTES = 15

// Registry callback saat pembayaran lunas
// (di-set dari agentManager saat session dibuat)
const paidCallbacks = new Map() // orderId → async fn({ businessId, order })

export function onOrderPaid(orderId, callback) {
  paidCallbacks.set(orderId, callback)
}

/**
 * Generate QRIS untuk 1 order.
 * @param {object} params
 * @param {string} params.orderId - UUID order
 * @param {string} params.businessId
 * @param {string} params.businessName
 * @param {number} params.total - amount in IDR
 * @returns {Promise<{ qrisBuffer: Buffer, qrisPayload: string, expiresAt: Date }>}
 */
export async function generateQrisForOrder({ orderId, businessId, businessName, total }) {
  const expiresAt = new Date(Date.now() + QRIS_EXPIRY_MINUTES * 60 * 1000)

  // Payload dummy: kalau di-scan pake kamera HP → buka halaman internal
  // Format URL biar kalau nanti ada halaman /pay/[id], tinggal ready.
  const payload = `https://kelola.ai/pay/${orderId}?amt=${total}&biz=${encodeURIComponent(businessName)}`

  // Generate QR sebagai PNG buffer (biar bisa langsung dikirim ke WA)
  const qrisBuffer = await QRCode.toBuffer(payload, {
    errorCorrectionLevel: 'M',
    type: 'png',
    width: 512,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#FFFFFF'
    }
  })

  // Simpan ke DB
  const { error } = await supabase.from('orders').update({
    qris_url: payload,
    qris_payload: payload,
    qris_expires_at: expiresAt.toISOString()
  }).eq('id', orderId)

  if (error) console.error('❌ QRIS: gagal update order:', error)

  return { qrisBuffer, qrisPayload: payload, expiresAt }
}

/**
 * Schedule auto-confirm (demo mode). Setelah delay, order status → lunas.
 * Callback dipanggil (kalau ada) buat kirim notif WA.
 */
export function scheduleAutoConfirm({ orderId, businessId, delayMs = AUTO_CONFIRM_DELAY_MS }) {
  console.log(`⏱️ [DEMO] Order ${orderId.slice(0,8)} akan auto-lunas dalam ${delayMs/1000}s...`)

  setTimeout(async () => {
    try {
      // Cek: masih menunggu? jangan override kalau udah dibatalkan/dll
      const { data: current } = await supabase.from('orders')
        .select('id, status, total, customer_name, customer_address, items, business_id')
        .eq('id', orderId).single()

      if (!current) {
        console.log(`⏱️ [DEMO] Order ${orderId.slice(0,8)} sudah tidak ada, skip.`)
        return
      }

      if (current.status !== 'menunggu') {
        console.log(`⏱️ [DEMO] Order ${orderId.slice(0,8)} status = ${current.status}, skip auto-confirm.`)
        return
      }

      // Update: setelah bayar QRIS, status pindah ke "diproses"
      // (bukan langsung "lunas/selesai" — barang belum dikirim!)
      // paid_at tetep ke-record supaya keliatan udah dibayar
      const paidAt = new Date().toISOString()
      const { error } = await supabase.from('orders').update({
        status: 'diproses',
        paid_at: paidAt
      }).eq('id', orderId)

      if (error) {
        console.error(`❌ Auto-confirm gagal untuk ${orderId.slice(0,8)}:`, error)
        return
      }

      console.log(`✅ [DEMO] Order ${orderId.slice(0,8)} auto-lunas!`)

      // Trigger callback (kirim notif WA)
      const cb = paidCallbacks.get(orderId)
      if (cb) {
        try {
          await cb({ businessId, order: current, paidAt })
        } catch (cbErr) {
          console.error('❌ Payment callback error:', cbErr)
        } finally {
          paidCallbacks.delete(orderId)
        }
      }
    } catch (err) {
      console.error(`❌ Auto-confirm exception ${orderId}:`, err)
    }
  }, delayMs)
}
