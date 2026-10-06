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
import sharp from 'sharp'
import supabase from '../db/supabase.js'

// Config
const AUTO_CONFIRM_DELAY_MS = parseInt(process.env.QRIS_AUTO_CONFIRM_MS || '20000') // 20 detik
const QRIS_EXPIRY_MINUTES = 15

// ─── EMVCo QRIS payload builder (mock — cuma buat demo visual) ─────────
// Format QRIS asli: TLV (Tag-Length-Value) ala EMVCo, CRC16 di akhir.
// Kalo di-scan app e-wallet real, akan RECOGNIZE sebagai QRIS tapi ERROR
// (Merchant ID palsu). Cukup buat demo — customer LIHAT ini QRIS, ga bayar beneran.

function tlv(tag, value) {
  const len = value.length.toString().padStart(2, '0')
  return `${tag}${len}${value}`
}

// CRC16-CCITT-FALSE (poly 0x1021, init 0xFFFF) — algoritma resmi QRIS
function crc16(str) {
  let crc = 0xFFFF
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1
      crc &= 0xFFFF
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

function buildQrisPayload({ merchantName, merchantCity, amount, referenceId }) {
  const cleanName = (merchantName || 'MERCHANT').toUpperCase().slice(0, 25)
  const cleanCity = (merchantCity || 'PURWOKERTO').toUpperCase().slice(0, 15)

  // Merchant Account Info (Tag 26) - ID.CO.QRIS.WWW format (dynamic)
  const merchantInfo =
    tlv('00', 'ID.CO.QRIS.WWW') +
    tlv('01', '936000141' + Math.floor(Math.random() * 1e10).toString().padStart(10, '0')) +
    tlv('02', 'ID' + Math.floor(Math.random() * 1e13).toString().padStart(13, '0'))

  let payload =
    tlv('00', '01') +                          // Payload Format Indicator
    tlv('01', '12') +                          // Point of Initiation (12 = dynamic)
    tlv('26', merchantInfo) +                  // Merchant Account Info
    tlv('52', '5411') +                        // MCC (5411 = grocery)
    tlv('53', '360') +                         // Currency (360 = IDR)
    tlv('54', amount.toString()) +             // Transaction Amount
    tlv('58', 'ID') +                          // Country
    tlv('59', cleanName) +                     // Merchant Name
    tlv('60', cleanCity) +                     // Merchant City
    tlv('62', tlv('05', referenceId.slice(0, 25))) // Additional Data (Bill Number)

  payload += '6304' // CRC16 tag + length placeholder
  const crc = crc16(payload)
  return payload + crc
}


// Registry callback saat pembayaran lunas
// (di-set dari agentManager saat session dibuat)
const paidCallbacks = new Map() // orderId → { callback: async fn({ businessId, order, paidAt }), timer }

// Callback dibuang otomatis setelah QRIS kedaluwarsa (+5 menit), supaya pesanan yang tidak
// dibayar tidak menumpuk di memori (callback ikut memegang gambar QRIS & data struk).
const PAID_CALLBACK_TTL_MS = (QRIS_EXPIRY_MINUTES + 5) * 60 * 1000

export function onOrderPaid(orderId, callback) {
  const prev = paidCallbacks.get(orderId)
  if (prev) clearTimeout(prev.timer)
  const timer = setTimeout(() => paidCallbacks.delete(orderId), PAID_CALLBACK_TTL_MS)
  timer.unref?.()
  paidCallbacks.set(orderId, { callback, timer })
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
  const referenceId = orderId.replace(/-/g, '').slice(0, 20)

  // Fake EMVCo QRIS payload (visual demo — kalau di-scan e-wallet akan error merchant)
  const payload = buildQrisPayload({
    merchantName: businessName,
    merchantCity: 'PURWOKERTO',
    amount: total,
    referenceId
  })

  // Generate raw QR sebagai PNG buffer
  const qrRaw = await QRCode.toBuffer(payload, {
    errorCorrectionLevel: 'H',   // High biar tetep readable walau di-composite
    type: 'png',
    width: 520,
    margin: 1,
    color: { dark: '#000000', light: '#FFFFFF' }
  })

  // Compose jadi kartu QRIS-style: header merah putih + QR di tengah + footer info
  const qrisBuffer = await composeQrisCard({
    qr: qrRaw,
    merchantName: (businessName || 'MERCHANT').toUpperCase(),
    amount: total,
    referenceId
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
      const entry = paidCallbacks.get(orderId)
      if (entry) {
        clearTimeout(entry.timer)
        paidCallbacks.delete(orderId)
        try {
          await entry.callback({ businessId, order: current, paidAt })
        } catch (cbErr) {
          console.error('❌ Payment callback error:', cbErr)
        }
      }
    } catch (err) {
      console.error(`❌ Auto-confirm exception ${orderId}:`, err)
    }
  }, delayMs)
}

// ─── Compose kartu QRIS-style (SVG overlay via sharp) ────────────────
// Layout: header merah "QRIS" + garis putih tipis + QR (520px) + footer info.
// Ini yang bikin visual keliatan legit — bukan cuma QR code polos.
async function composeQrisCard({ qr, merchantName, amount, referenceId }) {
  const W = 600
  const HEADER_H = 130
  const QR_SIZE = 520
  const QR_PAD_X = (W - QR_SIZE) / 2
  const QR_PAD_Y = HEADER_H + 20
  const FOOTER_H = 160
  const H = HEADER_H + 20 + QR_SIZE + FOOTER_H

  const safeName = merchantName.slice(0, 30).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const amountStr = 'Rp ' + amount.toLocaleString('id-ID')
  const refShort = referenceId.slice(0, 12).toUpperCase()

  // Build SVG overlay: header + footer + labels
  const svg = `
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      .brand { font: 700 42px 'Arial', sans-serif; fill: #FFFFFF; letter-spacing: 4px; }
      .brand-sub { font: 600 12px 'Arial', sans-serif; fill: #FFFFFF; letter-spacing: 2px; }
      .merchant { font: 700 20px 'Arial', sans-serif; fill: #111111; }
      .nmid { font: 500 11px 'Courier New', monospace; fill: #666666; }
      .amount-label { font: 500 11px 'Arial', sans-serif; fill: #666666; letter-spacing: 1px; }
      .amount { font: 800 28px 'Arial', sans-serif; fill: #E4002B; }
      .footer-txt { font: 500 10px 'Arial', sans-serif; fill: #888888; }
      .gpn { font: 700 11px 'Arial', sans-serif; fill: #E4002B; letter-spacing: 1px; }
    </style>
  </defs>

  <!-- White background -->
  <rect width="${W}" height="${H}" fill="#FFFFFF"/>

  <!-- Header merah QRIS -->
  <rect x="0" y="0" width="${W}" height="${HEADER_H}" fill="#E4002B"/>
  <text x="${W / 2}" y="70" text-anchor="middle" class="brand">QRIS</text>
  <text x="${W / 2}" y="98" text-anchor="middle" class="brand-sub">SATU QRIS UNTUK SEMUA</text>

  <!-- White strip after header -->
  <rect x="0" y="${HEADER_H}" width="${W}" height="20" fill="#FFFFFF"/>

  <!-- QR box border -->
  <rect x="${QR_PAD_X - 4}" y="${QR_PAD_Y - 4}" width="${QR_SIZE + 8}" height="${QR_SIZE + 8}" fill="none" stroke="#E4002B" stroke-width="2"/>

  <!-- Footer content -->
  <rect x="0" y="${QR_PAD_Y + QR_SIZE + 8}" width="${W}" height="${FOOTER_H - 8}" fill="#FFFFFF"/>
  <text x="${W / 2}" y="${QR_PAD_Y + QR_SIZE + 40}" text-anchor="middle" class="merchant">${safeName}</text>
  <text x="${W / 2}" y="${QR_PAD_Y + QR_SIZE + 60}" text-anchor="middle" class="nmid">NMID: ID10${refShort}  ·  A01</text>

  <!-- Divider -->
  <line x1="60" y1="${QR_PAD_Y + QR_SIZE + 78}" x2="${W - 60}" y2="${QR_PAD_Y + QR_SIZE + 78}" stroke="#E5E5E5" stroke-width="1"/>

  <!-- Amount -->
  <text x="${W / 2}" y="${QR_PAD_Y + QR_SIZE + 102}" text-anchor="middle" class="amount-label">NOMINAL PEMBAYARAN</text>
  <text x="${W / 2}" y="${QR_PAD_Y + QR_SIZE + 132}" text-anchor="middle" class="amount">${amountStr}</text>

  <!-- GPN badge bottom right -->
  <text x="${W - 20}" y="${H - 12}" text-anchor="end" class="gpn">GPN</text>
  <text x="20" y="${H - 12}" text-anchor="start" class="footer-txt">Powered by Kelola.ai</text>
</svg>`

  // Composite: SVG background + QR image on top
  return await sharp(Buffer.from(svg))
    .composite([
      {
        input: qr,
        left: Math.round(QR_PAD_X),
        top: Math.round(QR_PAD_Y)
      }
    ])
    .png()
    .toBuffer()
}
