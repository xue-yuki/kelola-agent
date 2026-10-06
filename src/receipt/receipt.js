// ─────────────────────────────────────────────────────────────────────
// Struk pesanan WhatsApp
//
// Bot mengirim struk sebagai GAMBAR (desain sama dengan struk cetak Kasir di dashboard)
// + caption singkat. Kalau gambar gagal dibuat/dikirim, otomatis kirim struk TEKS lama.
//
// Data struk (ReceiptData):
//   { businessName, businessAddress, businessWa, orderId, createdAt,
//     items: [{ name, qty, price, subtotal }], total, customerName, customerAddress,
//     paymentMethod: 'cod' | 'qris' | 'tunai' }
// ─────────────────────────────────────────────────────────────────────

import sharp from 'sharp'
import { fileURLToPath } from 'node:url'

// Font struk ikut di repo (src/receipt/fonts) — server belum tentu punya font sistem.
// Dibaca fontconfig saat gambar pertama dibuat, jadi cukup di-set sebelum render.
process.env.FONTCONFIG_FILE = fileURLToPath(new URL('./fonts/fonts.conf', import.meta.url))

const FONT = "'DejaVu Sans Mono', monospace"
const CHAR_W = 0.602            // lebar 1 karakter DejaVu Sans Mono (× ukuran font)

// Ukuran dalam px (lalu dirender 1,5× supaya tajam di HP)
const SCALE = 1.5
const IMG_W = 720
const PAPER_X = 40
const PAPER_W = IMG_W - PAPER_X * 2
const PAD = 40
const TEXT_W = PAPER_W - PAD * 2
const FS = 24                   // ukuran teks isi
const LH = 36                   // tinggi baris
const COLS = Math.floor(TEXT_W / (FS * CHAR_W))
const LABEL_COLS = 7            // lebar kolom label "Alamat "

const INK = '#18181B'
const MUTED = '#52525B'
const FAINT = '#71717A'

const PAYMENT_LABEL = { cod: 'COD (bayar di tempat)', qris: 'QRIS', tunai: 'Tunai' }
const PAYMENT_SHORT = { cod: 'COD', qris: 'QRIS', tunai: 'Tunai' }

export const rupiah = (n) => `Rp ${(Number(n) || 0).toLocaleString('id-ID')}`
const shortId = (orderId) => (orderId ? orderId.slice(0, 8).toUpperCase() : '--------')

// Nama pelanggan yang isinya cuma nomor WA tidak ditampilkan sebagai nama
const displayName = (name) => (name && !/^\+?\d{6,}$/.test(String(name).trim()) ? String(name).trim() : '')

// "6281234567890" → "0812-3456-7890"
export function formatWa(wa) {
  const d = String(wa || '').replace(/\D/g, '')
  if (!d) return ''
  const local = d.startsWith('62') ? `0${d.slice(2)}` : d
  return local.replace(/^(\d{4})(\d{4})(\d+)$/, '$1-$2-$3')
}

function formatWaktu(createdAt) {
  const d = createdAt ? new Date(createdAt) : new Date()
  const tanggal = d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' })
  const jam = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' })
  return `${tanggal}, ${jam} WIB`
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

// Pecah teks per kata supaya muat `width` karakter (kata kepanjangan dipotong paksa)
function wrap(text, width) {
  const lines = []
  let line = ''
  for (let word of String(text ?? '').trim().split(/\s+/).filter(Boolean)) {
    while (word.length > width) {
      if (line) { lines.push(line); line = '' }
      lines.push(word.slice(0, width))
      word = word.slice(width)
    }
    if (!line) line = word
    else if (line.length + 1 + word.length <= width) line += ` ${word}`
    else { lines.push(line); line = word }
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

const normalizeItems = (items) => (Array.isArray(items) ? items : []).map((it) => {
  const qty = Number(it.qty ?? it.quantity) || 1
  const price = Number(it.price) || 0
  return { name: it.name || 'Barang', qty, price, subtotal: Number(it.subtotal) || qty * price }
})

// ─── Gambar struk ────────────────────────────────────────────────────
export async function renderReceiptImage(data) {
  const items = normalizeItems(data.items)
  const rows = []   // { h, draw(y) → svg }
  const charW = FS * CHAR_W
  const left = PAPER_X + PAD
  const right = PAPER_X + PAD + TEXT_W
  const center = IMG_W / 2

  const text = (x, y, s, { size = FS, weight = 400, fill = INK, anchor = 'start' } = {}) =>
    `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`

  const add = (h, draw) => rows.push({ h, draw })
  const centered = (s, opts = {}) => {
    const size = opts.size || FS
    for (const line of wrap(s, Math.floor(TEXT_W / (size * CHAR_W)))) {
      add(opts.lh || LH, (y) => text(center, y, line, { ...opts, anchor: 'middle' }))
    }
  }
  // Garis putus-putus yang pas dari tepi kiri sampai kanan (40 strip)
  const dashGap = (TEXT_W - 40 * 8) / 39
  const sep = () => add(28, (y) =>
    `<line x1="${left}" x2="${right}" y1="${y - 10}" y2="${y - 10}" stroke="#A1A1AA" stroke-width="2" stroke-dasharray="8 ${dashGap.toFixed(2)}"/>`)
  const leftRight = (l, r, opts = {}) => add(opts.lh || LH, (y) =>
    text(left + (opts.indent || 0) * charW, y, l, opts) + text(right, y, r, { ...opts, anchor: 'end' }))
  const keyValue = (label, value) => {
    wrap(value, COLS - LABEL_COLS).forEach((line, i) => add(LH, (y) =>
      (i === 0 ? text(left, y, label, { fill: MUTED }) : '') + text(left + LABEL_COLS * charW, y, line)))
  }

  // Kepala: nama toko, alamat, WA
  centered(data.businessName || 'Toko', { size: 30, weight: 700, lh: 44 })
  if (data.businessAddress) centered(data.businessAddress, { fill: MUTED })
  if (data.businessWa) centered(`WA ${formatWa(data.businessWa)}`, { fill: MUTED })
  sep()

  keyValue('No.', `#${shortId(data.orderId)}`)
  keyValue('Waktu', formatWaktu(data.createdAt))
  const name = displayName(data.customerName)
  if (name) keyValue('Nama', name)
  if (data.customerAddress) keyValue('Alamat', data.customerAddress)
  sep()

  for (const it of items) {
    for (const line of wrap(it.name, COLS)) add(LH, (y) => text(left, y, line))
    leftRight(`${it.qty} x ${rupiah(it.price)}`, rupiah(it.subtotal), { indent: 2, fill: MUTED })
  }
  sep()

  leftRight('TOTAL', rupiah(data.total), { size: 28, weight: 700, lh: 44 })
  leftRight('Metode bayar', PAYMENT_LABEL[data.paymentMethod] || 'Tunai', { fill: MUTED })
  sep()

  centered('Terima kasih sudah berbelanja!')
  centered('Dibuat dengan Kelola.ai', { size: 20, fill: FAINT, lh: 32 })

  // Susun baris dari atas
  const paperTop = 40
  let y = paperTop + PAD
  const body = rows.map((r) => {
    const svg = r.draw(y + r.h * 0.72)
    y += r.h
    return svg
  }).join('')
  const paperBottom = y + PAD

  // Kertas putih dengan tepi bawah bergerigi
  const tooth = 20
  let edge = ''
  for (let x = PAPER_X + PAPER_W; x > PAPER_X; x -= tooth) {
    edge += ` L${x - tooth / 2},${paperBottom + 10} L${Math.max(x - tooth, PAPER_X)},${paperBottom}`
  }
  const paper = `M${PAPER_X},${paperTop} L${PAPER_X + PAPER_W},${paperTop} L${PAPER_X + PAPER_W},${paperBottom}${edge} Z`
  const imgH = paperBottom + 50

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${IMG_W}" height="${imgH}" viewBox="0 0 ${IMG_W} ${imgH}">
    <rect width="100%" height="100%" fill="#F4F4F5"/>
    <path d="${paper}" fill="#000" opacity="0.05" transform="translate(0,3)"/>
    <path d="${paper}" fill="#FFFFFF" stroke="#E4E4E7" stroke-width="1"/>
    ${body}
  </svg>`

  // Tanpa filter blur & palet effort 1: ±40 ms per struk (dengan blur + palet bawaan ±350 ms)
  return sharp(Buffer.from(svg), { density: 72 * SCALE })
    .png({ palette: true, effort: 1, colours: 64, dither: 0 })
    .toBuffer()
}

// Caption di bawah gambar. QRIS: struk dikirim setelah pesan "Pembayaran diterima"
// yang sudah berisi ucapan terima kasih, jadi cukup baris pertama.
export function receiptCaption(data) {
  const head = `🧾 Struk #${shortId(data.orderId)} · ${rupiah(data.total)} · ${PAYMENT_SHORT[data.paymentMethod] || 'Tunai'}`
  if (data.paymentMethod === 'qris') return head
  const name = displayName(data.customerName)
  return `${head}\nTerima kasih${name ? ` Kak ${name}` : ''}, pesanan segera kami proses 🚀`
}

// ─── Struk teks (cadangan kalau gambar gagal) ────────────────────────
export function buildReceiptText(data) {
  const items = normalizeItems(data.items)
  const itemLines = items.map((item) =>
    `• ${item.name} ${item.qty}x  @${rupiah(item.price)}  =  ${rupiah(item.subtotal)}`
  ).join('\n')
  const name = displayName(data.customerName) || data.customerName || ''

  return `━━━━━━━━━━━━━━━━━━━
🧾 *STRUK PESANAN*
━━━━━━━━━━━━━━━━━━━
📋 No. Order: *#${shortId(data.orderId)}*
📅 ${formatWaktu(data.createdAt)}

👤 *Nama:* ${name}
📍 *Alamat:* ${data.customerAddress || '-'}

📦 *Detail Pesanan:*
${itemLines}

━━━━━━━━━━━━━━━━━━━
💰 *TOTAL: ${rupiah(data.total)}*
💳 *Bayar:* ${PAYMENT_LABEL[data.paymentMethod] || 'Tunai'}
━━━━━━━━━━━━━━━━━━━

🙏 Terima kasih sudah order di *${data.businessName}*!
Pesanan Kak ${name} segera kami proses! 🚀`
}

// Kirim struk ke pelanggan: gambar + caption, cadangan teks. Mengembalikan 'image' | 'text'.
export async function sendReceipt(sock, jid, data) {
  try {
    const image = await renderReceiptImage(data)
    await sock.sendMessage(jid, { image, caption: receiptCaption(data) })
    return 'image'
  } catch (err) {
    console.error(`⚠️ Struk gambar gagal (#${shortId(data.orderId)}), kirim versi teks:`, err?.message || err)
    await sock.sendMessage(jid, { text: buildReceiptText(data) })
    return 'text'
  }
}
