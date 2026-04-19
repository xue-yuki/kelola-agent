import dotenv from 'dotenv'
import supabase from './src/db/supabase.js'

dotenv.config()

async function test() {
    console.log("Checking orders table schema...");
    const { data: oData, error: oError } = await supabase.from('orders').select('*').limit(1);
    if (oError) {
        console.error("Orders Table Error:", oError);
    } else {
        console.log("Orders schema sample:", oData[0] ? Object.keys(oData[0]) : "Empty table, cannot guess schema from REST API if empty.");
    }

    console.log("Checking customers table schema...");
    const { data: cData, error: cError } = await supabase.from('customers').select('*').limit(1);
    if (cError) {
        console.error("Customers Table Error:", cError);
    } else {
        console.log("Customers schema sample:", cData[0] ? Object.keys(cData[0]) : "Empty table, cannot guess schema from REST API if empty.");
    }
}
test();
