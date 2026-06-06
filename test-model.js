// Script test: verifikasi model gemini-2.5-flash-lite bisa dipanggil
// Jalankan: node test-model.js
import 'dotenv/config'

const model = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite'

console.log(`🧪 Testing model: ${model}`)
console.log(`🔑 API Key: ${process.env.OPENROUTER_API_KEY?.slice(0, 20)}...`)

const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://kelola.ai',
    'X-Title': 'Kelola.ai Agent'
  },
  body: JSON.stringify({
    model,
    messages: [
      { role: 'system', content: 'Kamu adalah asisten toko online.' },
      { role: 'user', content: 'Halo, apakah ada promo hari ini?' }
    ],
    max_tokens: 100
  })
})

const data = await response.json()

if (data.error) {
  console.error('❌ GAGAL! Error dari OpenRouter:')
  console.error(JSON.stringify(data.error, null, 2))
  process.exit(1)
} else {
  console.log('✅ BERHASIL! Model merespons dengan baik.')
  console.log(`💬 Balasan AI: "${data.choices?.[0]?.message?.content}"`)
  console.log(`📊 Token dipakai: ${JSON.stringify(data.usage)}`)
}
