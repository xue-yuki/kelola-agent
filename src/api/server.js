import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode';
import { currentQR, botStatus, logoutAndReconnect, getActiveSock, isSocketConnected } from '../bot/connection.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/qr/:businessId', async (req, res) => {
    try {
        if (!currentQR) {
            return res.json({ qr: null, status: botStatus });
        }
        const qrBase64 = await qrcode.toDataURL(currentQR);
        res.json({ qr: qrBase64, status: botStatus });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate QR code' });
    }
});

app.get('/api/status/:businessId', (req, res) => {
    res.json({ status: botStatus });
});

app.post('/api/disconnect/:businessId', async (req, res) => {
    try {
        await logoutAndReconnect();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to disconnect', message: err.message });
    }
});

// ─── Broadcast State ──────────────────────────────────────────────────────────
let broadcastState = { running: false, sent: 0, failed: 0, total: 0 };

app.post('/api/broadcast', async (req, res) => {
    const { recipients, template } = req.body;
    // recipients: [{ number: string, name: string }]
    // template: string (may contain [Nama])

    if (!isSocketConnected() || !getActiveSock()) {
        return res.status(503).json({ error: 'Bot tidak terhubung ke WhatsApp. Hubungkan dulu di Pengaturan.' });
    }
    if (!recipients?.length || !template?.trim()) {
        return res.status(400).json({ error: 'recipients dan template wajib diisi' });
    }
    if (broadcastState.running) {
        return res.status(409).json({ error: 'Broadcast sedang berjalan, tunggu hingga selesai.' });
    }

    broadcastState = { running: true, sent: 0, failed: 0, total: recipients.length };
    res.json({ success: true, total: recipients.length });

    // Process in background — always end with running=false
    try {
        for (const { number, name } of recipients) {
            if (!broadcastState.running) break;

            // Strip @lid / @s.whatsapp.net suffixes, keep only digits
            const cleanNumber = String(number).replace(/@.*$/, '').replace(/\D/g, '');

            // Skip LID numbers (stored before the @lid bug was fixed): Indonesia numbers
            // start with 62 and are 10-15 digits; LID numbers are 15 digits starting with non-62
            const isValidPhone = cleanNumber.length >= 10 && cleanNumber.length <= 15 && cleanNumber.startsWith('62');
            if (!isValidPhone) {
                console.log(`⚠️ Skip nomor tidak valid: ${number}`);
                broadcastState.failed++;
                continue;
            }

            try {
                // Get fresh socket each iteration (handles reconnects)
                const sock = getActiveSock();
                if (!sock || !isSocketConnected()) {
                    console.log(`⚠️ Bot tidak terhubung, menunggu 5s...`);
                    await new Promise(r => setTimeout(r, 5000));
                    broadcastState.failed++;
                    continue;
                }

                const text = template.replace(/\[Nama\]/gi, name || 'Kak');
                const jid = `${cleanNumber}@s.whatsapp.net`;

                await Promise.race([
                    sock.sendMessage(jid, { text }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout 15s')), 15000))
                ]);
                broadcastState.sent++;
                console.log(`📤 Broadcast → ${cleanNumber}: ${text.substring(0, 40)}...`);
            } catch (err) {
                broadcastState.failed++;
                console.error(`❌ Broadcast gagal ke ${cleanNumber}:`, err.message);
            }
            await new Promise(r => setTimeout(r, 2000));
        }
    } finally {
        broadcastState.running = false;
        console.log(`📊 Broadcast selesai: ${broadcastState.sent} berhasil, ${broadcastState.failed} gagal`);
    }
});

app.get('/api/broadcast/status', (req, res) => {
    res.json(broadcastState);
});

export const startServer = () => {
    const port = process.env.PORT || 3001;
    app.listen(port, () => {
        console.log(`🌐 Server API berjalan di port ${port}`);
    });
};
