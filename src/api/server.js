import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode';
import { currentQR, botStatus, logoutAndReconnect } from '../bot/connection.js';

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

export const startServer = () => {
    const port = process.env.PORT || 3001;
    app.listen(port, () => {
        console.log(`🌐 Server API berjalan di port ${port}`);
    });
};
