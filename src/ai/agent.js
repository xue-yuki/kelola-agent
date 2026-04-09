import dotenv from 'dotenv'
import supabase from '../db/supabase.js'

dotenv.config()

async function getBusinessContext(waNumber) {
  const { data: business } = await supabase
    .from('businesses')
    .select('*')
    .eq('wa_number', waNumber)
    .single()

  if (!business) return null

  const { data: products } = await supabase
    .from('products')
    .select('name, price, stock')
    .eq('business_id', business.id)
    .gt('stock', 0)

  return { business, products }
}

async function getConversationHistory(businessId, customerWa) {
  const { data } = await supabase
    .from('conversations')
    .select('role, message')
    .eq('business_id', businessId)
    .eq('customer_wa', customerWa)
    .order('created_at', { ascending: false })
    .limit(10)

  return data ? data.reverse() : []
}

async function saveConversation(businessId, customerWa, role, message) {
  await supabase.from('conversations').insert({
    business_id: businessId,
    customer_wa: customerWa,
    role,
    message
  })
}

async function saveOrder(businessId, customerWa, items, total) {
  await supabase.from('orders').insert({
    business_id: businessId,
    customer_name: customerWa,
    channel: 'whatsapp',
    total,
    status: 'menunggu',
    items
  })

  // Kurangi stok
  for (const item of items) {
    const { data: product } = await supabase
      .from('products')
      .select('id, stock')
      .eq('business_id', businessId)
      .eq('name', item.name)
      .single()

    if (product) {
      await supabase
        .from('products')
        .update({ stock: product.stock - item.qty })
        .eq('id', product.id)
    }
  }
}

export async function processMessage(waNumber, customerWa, customerMessage) {
  const context = await getBusinessContext(waNumber)
  if (!context) return 'Maaf, bisnis ini belum terdaftar di Kelola.ai.'

  const { business, products } = context
  const history = await getConversationHistory(business.id, customerWa)

  const systemPrompt = `
${business.ai_instructions ? 
  business.ai_instructions 
  : 
  `Kamu adalah asisten AI untuk ${business.business_name}.
Balas dengan ramah, bahasa Indonesia santai.
Bantu customer tanya produk dan proses pesanan.`
}

PRODUK TERSEDIA:
${products?.map(p => 
  `- ${p.name}: Rp ${p.price.toLocaleString('id-ID')} (stok: ${p.stock})`
).join('\n') || 'Belum ada produk'}

PENTING: 
- Jangan sebut harga berbeda dari daftar di atas!
- Setelah customer konfirmasi order, balas dengan format JSON di dalam tag <ORDER>:
  <ORDER>{"items":[{"name":"nama produk","qty":1,"price":15000}],"total":15000}</ORDER>
`

  const messages = [
    ...history.map(h => ({
      role: h.role,
      content: h.message
    })),
    { role: 'user', content: customerMessage }
  ]

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://kelola.ai',
      'X-Title': 'Kelola.ai Agent'
    },
    body: JSON.stringify({
      model: 'qwen/qwen-turbo',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ]
    })
  })

  const data = await response.json()

  // Cek jika API return error
  if (!response.ok || !data.choices?.[0]?.message?.content) {
    console.error('❌ OpenRouter API error:', JSON.stringify(data))
    return 'Maaf, AI sedang tidak bisa dihubungi saat ini. Coba lagi sebentar ya! 🙏'
  }

  const reply = data.choices[0].message.content

  // Save conversation
  await saveConversation(business.id, customerWa, 'user', customerMessage)
  await saveConversation(business.id, customerWa, 'assistant', reply)

  // Detect & save order
  const orderMatch = reply.match(/<ORDER>(.*?)<\/ORDER>/s)
  if (orderMatch) {
    try {
      const order = JSON.parse(orderMatch[1])
      await saveOrder(business.id, customerWa, order.items, order.total)
    } catch (e) {
      console.error('Failed to parse order:', e)
    }
  }

  // Return reply tanpa tag ORDER
  return reply.replace(/<ORDER>.*?<\/ORDER>/s, '').trim()
}