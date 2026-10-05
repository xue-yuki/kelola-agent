// Sliding-window rate limiter di memori. Aman karena agent berjalan 1 instance
// (WA session tidak bisa di-cluster). Dipakai untuk membatasi pesan masuk per menit.

export function createLimiter({ windowMs, max }) {
  const hits = new Map()

  function check(key, now = Date.now()) {
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs)
    if (recent.length >= max) {
      hits.set(key, recent)
      return { ok: false, retryAfterMs: windowMs - (now - recent[0]) }
    }
    recent.push(now)
    hits.set(key, recent)
    return { ok: true }
  }

  // Bersihkan key lama supaya Map tidak membengkak
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [key, list] of hits) {
      const recent = list.filter((t) => now - t < windowMs)
      if (recent.length === 0) hits.delete(key)
      else hits.set(key, recent)
    }
  }, windowMs)
  timer.unref?.()

  return { check }
}

// Batas pesan masuk: per bisnis (lindungi kuota AI bersama) dan per pelanggan (anti-spam)
const PER_BUSINESS_PER_MIN = Number(process.env.RL_BUSINESS_PER_MIN || 50)
const PER_CUSTOMER_PER_MIN = Number(process.env.RL_CUSTOMER_PER_MIN || 10)

const businessLimiter = createLimiter({ windowMs: 60_000, max: PER_BUSINESS_PER_MIN })
const customerLimiter = createLimiter({ windowMs: 60_000, max: PER_CUSTOMER_PER_MIN })
const lastNotice = new Map() // customerKey -> waktu terakhir diberi pesan "terlalu cepat"

export function checkIncoming(businessId, customerWa) {
  const customerKey = `${businessId}:${customerWa}`

  const byCustomer = customerLimiter.check(customerKey)
  if (!byCustomer.ok) return { ok: false, scope: 'customer', notify: shouldNotify(customerKey) }

  const byBusiness = businessLimiter.check(businessId)
  if (!byBusiness.ok) return { ok: false, scope: 'business', notify: shouldNotify(customerKey) }

  return { ok: true }
}

// Beri tahu pelanggan paling sering sekali per menit supaya kita tidak ikut membanjiri chat
function shouldNotify(key) {
  const now = Date.now()
  if (now - (lastNotice.get(key) || 0) < 60_000) return false
  lastNotice.set(key, now)
  if (lastNotice.size > 5000) {
    for (const [k, t] of lastNotice) if (now - t > 60_000) lastNotice.delete(k)
  }
  return true
}
