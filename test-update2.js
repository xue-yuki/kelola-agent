import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
)

async function run() {
  const { data: business } = await supabase.from('businesses').select('*').limit(1).single()
  console.log("Found Business:", business.business_name, "token:", business.token_usage)
  
  const currentUsage = business.token_usage || 0;
  const res = await supabase.from('businesses').update({ token_usage: currentUsage + 1 }).eq('id', business.id).select();
  console.log("Update response:", res);
}

run()
