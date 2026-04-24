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

async function saveOrder(businessId, customerWa, items, total, customerName, customerAddress) {
  const { error: orderError } = await supabase.from('orders').insert({
    business_id: businessId,
    customer_name: customerName || customerWa,
    customer_address: customerAddress || '',
    channel: 'whatsapp',
    total,
    status: 'menunggu',
    items
  })

  if (orderError) console.error("Error inserting order:", orderError);

  // Check if customer exists first
  const { data: existingCustomer } = await supabase
    .from('customers')
    .select('id')
    .eq('business_id', businessId)
    .eq('wa_number', customerWa)
    .single()

  if (existingCustomer) {
    // Update existing customer
    const { error: updateError } = await supabase
      .from('customers')
      .update({
        name: customerName || customerWa,
        address: customerAddress || '',
      })
      .eq('id', existingCustomer.id)

    if (updateError) console.error("Error updating customer:", updateError);
  } else {
    // Insert new customer
    const { error: insertError } = await supabase
      .from('customers')
      .insert({
        business_id: businessId,
        wa_number: customerWa,
        name: customerName || customerWa,
        address: customerAddress || '',
      })

    if (insertError) console.error("Error inserting customer:", insertError);
  }

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

  // Check Token Quota Limit
  let limit = 1000; // Starter default
  const tier = business.subscription_tier?.toLowerCase() || 'starter';
  if (tier === 'pro') limit = -1;
  else if (tier === 'basic') limit = 3000;

  if (limit !== -1 && (business.token_usage || 0) >= limit) {
      return '⛔ Maaf, layanan AI untuk toko ini sedang ditangguhkan karena telah mencapai batas kuota pesan bulanan. Mohon pesan melalui panggilan/chat manual ke pemilik toko ya!';
  }

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

ALUR WAJIB SEBELUM KONFIRMASI ORDER:
1. Tanyakan produk apa yang mau dipesan dan berapa jumlahnya
2. WAJIB tanyakan nama lengkap customer jika belum disebutkan
3. WAJIB tanyakan alamat lengkap pengiriman (jalan, RT/RW, kelurahan, kecamatan, kota) jika belum disebutkan
4. Konfirmasi ulang pesanan beserta total harga
5. Baru setelah customer setuju, generate ORDER tag

PENTING:
- Jangan sebut harga berbeda dari daftar di atas!
- JANGAN PERNAH gunakan alamat palsu/contoh seperti "Jl. Sudirman" atau alamat placeholder!
- Alamat HARUS dari customer langsung, jika belum ada TANYAKAN DULU!

FORMAT KONFIRMASI PESANAN (setelah customer setuju):
Tulis rincian pesanan dalam FORMAT TEKS BIASA yang bisa dibaca customer, contoh:
---
📦 *RINCIAN PESANAN*
• Air RO 2 galon x Rp 5.500 = Rp 11.000
• Gas 3KG 1 x Rp 24.000 = Rp 24.000
*Total: Rp 35.000*

Nama: Erlangga
Alamat: Kodam Jaya Blok D1 No. 33

Mas Adi langsung OTW ya kak! 🚚
---

LALU di AKHIR PESAN (SETELAH teks rincian), tambahkan tag ORDER untuk sistem:
<ORDER>{"items":[{"name":"Air RO","qty":2,"price":5500},{"name":"Gas 3KG","qty":1,"price":24000}],"total":35000,"customer_name":"Erlangga","customer_address":"Kodam Jaya Blok D1 No. 33"}</ORDER>

Tag ORDER HARUS di paling akhir pesan, JANGAN di tengah!
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
      model: 'google/gemini-2.0-flash-001',
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

  // Debug: log raw AI response
  console.log('🤖 Raw AI response:', reply.substring(0, 500))

  // Save conversation
  await saveConversation(business.id, customerWa, 'user', customerMessage)
  await saveConversation(business.id, customerWa, 'assistant', reply)

  // Increment token usage
  try {
    const currentUsage = business.token_usage || 0;
    const { error: tokenErr } = await supabase.from('businesses')
                                        .update({ token_usage: currentUsage + 1 })
                                        .eq('id', business.id);
    if (tokenErr) {
        console.error("Supabase update error (token_usage):", tokenErr);
    }
  } catch (err) {
    console.error("Gagal eksekusi update token usage:", err);
  }

  // Detect & save order
  const orderMatch = reply.match(/<ORDER>(.*?)<\/ORDER>/s)
  if (orderMatch) {
    try {
      // Bersihkan indikator markdown backtick jika terbawa oleh respon AI
      let rawJson = orderMatch[1].trim();
      rawJson = rawJson.replace(/^```json\s*/, '').replace(/```$/, '').trim();
      
      const order = JSON.parse(rawJson)
      await saveOrder(business.id, customerWa, order.items, order.total, order.customer_name, order.customer_address)
    } catch (e) {
      console.error('Failed to parse order JSON block:', e)
    }
  }

  // Return reply tanpa tag ORDER
  return reply.replace(/<ORDER>.*?<\/ORDER>/s, '').trim()
}