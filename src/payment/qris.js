// ─────────────────────────────────────────────────────────────────────
// QRIS milik penjual
//
// Penjual meng-upload foto QRIS statis toko di dashboard (Pengaturan → Pembayaran); isi kodenya
// ada di businesses.qris_payload. Untuk tiap pesanan dibuat QR DINAMIS: tag 01 = "12", nominal
// disisipkan (tag 54), CRC dihitung ulang → pembeli scan, nominal terisi, uang langsung masuk
// ke rekening penjual. Logika sama dengan kelola.ai src/lib/qris.ts — ubah keduanya bersamaan.
//
// Setelah QR dikirim: pelanggan kirim foto bukti bayar → src/payment/proof.js, lalu penjual
// Konfirmasi / Tolak di dashboard (tidak ada konfirmasi otomatis: bukti bisa dipalsukan).
// Belum ada QRIS penjual → bot hanya menawarkan COD (src/ai/agent.js).
// ─────────────────────────────────────────────────────────────────────

import QRCode from 'qrcode'
import sharp from 'sharp'
import supabase from '../db/supabase.js'

// Config
const QRIS_EXPIRY_MINUTES = 15

// ─── EMVCo: TLV (Tag-Length-Value), CRC16 di akhir ─────────────────────
function tlv(tag, value) {
  const len = value.length.toString().padStart(2, '0')
  return `${tag}${len}${value}`
}

// CRC16-CCITT-FALSE (poly 0x1021, init 0xFFFF) — algoritma resmi QRIS
export function crc16(str) {
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

// "000201010211…" → [['00','01'], ['01','11'], …]; null kalau formatnya rusak
export function parseTlv(s) {
  const out = []
  let i = 0
  while (i < s.length) {
    const tag = s.slice(i, i + 2)
    const lenStr = s.slice(i + 2, i + 4)
    const len = Number(lenStr)
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lenStr) || i + 4 + len > s.length) return null
    out.push([tag, s.slice(i + 4, i + 4 + len)])
    i += 4 + len
  }
  return out
}

// QRIS penjual utuh? (diawali 000201 dan CRC cocok)
export function isValidQris(payload) {
  if (typeof payload !== 'string' || !payload.startsWith('000201')) return false
  const body = payload.slice(0, -4)
  return body.endsWith('6304') && crc16(body) === payload.slice(-4).toUpperCase() && !!parseTlv(payload)
}

// QR dinamis dari QRIS statis penjual: nominal terisi otomatis saat di-scan
export function toDynamicQris(staticPayload, amount) {
  const value = Math.round(Number(amount))
  if (!Number.isFinite(value) || value <= 0) throw new Error('Nominal QRIS harus lebih dari 0')
  const tags = parseTlv(String(staticPayload).trim())
  if (!tags) throw new Error('QRIS toko tidak valid')
  // Buang CRC lama, nominal & tip (55–57), set inisiasi dinamis, sisipkan nominal sesuai urutan tag
  const kept = tags.filter(([t]) => !['01', '54', '55', '56', '57', '63'].includes(t))
  kept.push(['01', '12'], ['54', String(value)])
  kept.sort((a, b) => Number(a[0]) - Number(b[0]))
  const body = kept.map(([t, v]) => tlv(t, v)).join('') + '6304'
  return body + crc16(body)
}

/**
 * QR pembayaran untuk 1 pesanan dari QRIS penjual.
 * @param {object} params
 * @param {string} params.orderId - UUID order
 * @param {string} params.qrisPayload - QRIS statis penjual (businesses.qris_payload)
 * @param {string} [params.merchantName] - nama merchant di QRIS (businesses.qris_merchant_name)
 * @param {string|null} [params.nmid] - NMID QRIS (businesses.qris_nmid)
 * @param {number} params.total - nominal (Rp)
 * @returns {Promise<{ qrisBuffer: Buffer, qrisPayload: string, expiresAt: Date }>}
 */
export async function generateQrisForOrder({ orderId, qrisPayload, merchantName, nmid, total }) {
  const expiresAt = new Date(Date.now() + QRIS_EXPIRY_MINUTES * 60 * 1000)
  const payload = toDynamicQris(qrisPayload, total)

  // Generate raw QR sebagai PNG buffer
  const qrRaw = await QRCode.toBuffer(payload, {
    errorCorrectionLevel: 'M',
    type: 'png',
    width: 520,
    margin: 1,
    color: { dark: '#000000', light: '#FFFFFF' }
  })

  // Kartu: header QRIS + QR di tengah + nama merchant, NMID, nominal
  const qrisBuffer = await composeQrisCard({
    qr: qrRaw,
    merchantName: (merchantName || 'MERCHANT').toUpperCase(),
    nmid,
    amount: total,
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

// ─── Compose kartu QRIS-style (SVG overlay via sharp) ────────────────
// Layout: header merah "QRIS" + garis putih tipis + QR (520px) + footer info.
// Ini yang bikin visual keliatan legit — bukan cuma QR code polos.
async function composeQrisCard({ qr, merchantName, nmid, amount }) {
  const W = 600
  const HEADER_H = 130
  const QR_SIZE = 520
  const QR_PAD_X = (W - QR_SIZE) / 2
  const QR_PAD_Y = HEADER_H + 20
  const FOOTER_H = 160
  const H = HEADER_H + 20 + QR_SIZE + FOOTER_H

  const safeName = merchantName.slice(0, 30).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const amountStr = 'Rp ' + amount.toLocaleString('id-ID')
  const nmidLine = nmid ? `NMID: ${String(nmid).replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}` : ''

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
  <text x="${W / 2}" y="${QR_PAD_Y + QR_SIZE + 60}" text-anchor="middle" class="nmid">${nmidLine}</text>

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
