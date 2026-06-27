require('dotenv').config();
const express = require('express');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Configs from .env
const API_KEY = process.env.STOCK_API_KEY;
const API_BASE_URL = process.env.STOCK_API_URL || 'https://finnhub.io/api/v1';

// Supported Stock List
const SUPPORTED_STOCKS = [
    { symbol: 'MSFT', name: 'Microsoft' },
    { symbol: 'AAPL', name: 'Apple' },
    { symbol: 'NVDA', name: 'NVIDIA' },
    { symbol: 'GOOGL', name: 'Alphabet' },
    { symbol: 'AMZN', name: 'Amazon' },
    { symbol: 'META', name: 'Meta' },
    { symbol: 'BRK.B', name: 'Berkshire Hathaway' },
    { symbol: 'LLY', name: 'Eli Lilly' },
    { symbol: 'AVGO', name: 'Broadcom' },
    { symbol: 'TSLA', name: 'Tesla' },
    { symbol: '005930.KS', name: '삼성전자' },
    { symbol: '000660.KS', name: 'SK하이닉스' }
];

// High-fidelity fallback seeds
const FALLBACK_SEEDS = {
    'MSFT': 390.0,
    'AAPL': 210.0,
    'NVDA': 120.0,
    'GOOGL': 175.0,
    'AMZN': 185.0,
    'META': 500.0,
    'BRK.B': 410.0,
    'LLY': 830.0,
    'AVGO': 1500.0,
    'TSLA': 180.0,
    '005930.KS': 74200.0,
    '000660.KS': 185300.0
};

// In-memory cache for simulated fallback quotes
const stockRealtimeCache = {};

function getFallbackPrice(symbol) {
    if (!stockRealtimeCache[symbol]) {
        const base = FALLBACK_SEEDS[symbol] || 100.0;
        stockRealtimeCache[symbol] = {
            price: base,
            prevClose: base * 0.99,
            high: base * 1.01,
            low: base * 0.985
        };
    }

    const cached = stockRealtimeCache[symbol];
    const change = (Math.random() - 0.5) * 0.003;
    cached.price = cached.price * (1 + change);
    if (cached.price > cached.high) cached.high = cached.price;
    if (cached.price < cached.low) cached.low = cached.price;

    const digits = symbol.endsWith('.KS') ? 0 : 2;
    cached.price = parseFloat(cached.price.toFixed(digits));
    cached.high = parseFloat(cached.high.toFixed(digits));
    cached.low = parseFloat(cached.low.toFixed(digits));
    return cached;
}

function getFallbackHistory(symbol) {
    const basePrice = FALLBACK_SEEDS[symbol] || 100.0;
    const data = [];
    const now = new Date();
    let price = basePrice * 0.9;

    for (let i = 90; i >= 0; i--) {
        const date = new Date(now.getTime() - (i * 24 * 60 * 60 * 1000));
        if (date.getDay() === 0 || date.getDay() === 6) continue;
        
        const change = (Math.random() - 0.48) * 0.03;
        const openVal = price;
        const closeVal = price * (1 + change);
        const highVal = Math.max(openVal, closeVal) * (1 + Math.random() * 0.01);
        const lowVal = Math.min(openVal, closeVal) * (1 - Math.random() * 0.01);
        
        const digits = symbol.endsWith('.KS') ? 0 : 2;
        data.push({
            time: date.toISOString().split('T')[0],
            open: parseFloat(openVal.toFixed(digits)),
            high: parseFloat(highVal.toFixed(digits)),
            low: parseFloat(lowVal.toFixed(digits)),
            close: parseFloat(closeVal.toFixed(digits))
        });
        price = closeVal;
    }
    return data;
}

// HTTPS Request Helper
function fetchFromFinnhub(endpoint) {
    if (!API_KEY) {
        return Promise.reject(new Error('STOCK_API_KEY is not configured in .env file.'));
    }
    const url = `${API_BASE_URL}/${endpoint}&token=${API_KEY}`;
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';

            if (res.statusCode === 429) {
                return reject(new Error('Finnhub API Rate Limit Exceeded'));
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Finnhub HTTP Status ${res.statusCode}`));
            }

            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}

// Serve static assets
app.use(express.static(__dirname));

// Endpoints
app.get('/api/firebase-config', (req, res) => {
    if (!process.env.FIREBASE_API_KEY) {
        return res.status(500).json({ error: 'Firebase configuration is missing in backend .env' });
    }
    res.json({
        status: 'ready',
        config: {
            apiKey: process.env.FIREBASE_API_KEY,
            authDomain: process.env.FIREBASE_AUTH_DOMAIN,
            projectId: process.env.FIREBASE_PROJECT_ID,
            storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
            messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
            appId: process.env.FIREBASE_APP_ID,
            measurementId: process.env.FIREBASE_MEASUREMENT_ID
        }
    });
});

// 1. Get List of Supported Stocks
app.get('/api/stocks', (req, res) => {
    res.json(SUPPORTED_STOCKS);
});

// 2. Get Historical Candlestick Data
app.get('/api/stock/history', async (req, res) => {
    const symbol = req.query.symbol || 'AAPL';

    if (symbol.endsWith('.KS')) {
        const historyData = getFallbackHistory(symbol);
        return res.json(historyData);
    }

    try {
        const to = Math.floor(Date.now() / 1000);
        const from = to - (90 * 24 * 60 * 60); // 90 days ago
        
        const endpoint = `stock/candle?symbol=${symbol}&resolution=D&from=${from}&to=${to}`;
        const rawData = await fetchFromFinnhub(endpoint);
        
        if (rawData.s !== 'ok' || !rawData.t || rawData.t.length === 0) {
            throw new Error('No historical data found or API limit hit');
        }
        
        const chartData = rawData.t.map((timestamp, index) => {
            const date = new Date(timestamp * 1000);
            const dateStr = date.toISOString().split('T')[0];
            return {
                time: dateStr,
                open: rawData.o[index],
                high: rawData.h[index],
                low: rawData.l[index],
                close: rawData.c[index]
            };
        });
        
        res.json(chartData);
    } catch (err) {
        const fallbackData = getFallbackHistory(symbol);
        res.json(fallbackData);
    }
});

// 3. Get Realtime Quote
app.get('/api/stock/realtime', async (req, res) => {
    const symbol = req.query.symbol || 'AAPL';

    if (symbol.endsWith('.KS')) {
        const cached = getFallbackPrice(symbol);
        const diff = cached.price - cached.prevClose;
        const diffPercent = (diff / cached.prevClose) * 100;
        
        const quoteData = {
            c: cached.price,
            d: diff,
            dp: parseFloat(diffPercent.toFixed(2)),
            h: cached.high,
            l: cached.low,
            o: cached.prevClose,
            pc: cached.prevClose
        };
        return res.json(quoteData);
    }

    try {
        const endpoint = `quote?symbol=${symbol}`;
        const rawData = await fetchFromFinnhub(endpoint);
        
        if (!rawData || !rawData.c) {
            throw new Error('No quote data found or API limit hit');
        }
        
        const digits = 2;
        const quoteData = {
            c: parseFloat(rawData.c.toFixed(digits)),
            d: parseFloat(rawData.d.toFixed(digits)),
            dp: parseFloat(rawData.dp.toFixed(2)),
            h: parseFloat(rawData.h.toFixed(digits)),
            l: parseFloat(rawData.l.toFixed(digits)),
            o: parseFloat(rawData.o.toFixed(digits)),
            pc: parseFloat(rawData.pc.toFixed(digits))
        };
        
        res.json(quoteData);
    } catch (err) {
        const cached = getFallbackPrice(symbol);
        const diff = cached.price - cached.prevClose;
        const diffPercent = (diff / cached.prevClose) * 100;
        
        const quoteData = {
            c: cached.price,
            d: parseFloat(diff.toFixed(2)),
            dp: parseFloat(diffPercent.toFixed(2)),
            h: cached.high,
            l: cached.low,
            o: cached.prevClose,
            pc: cached.prevClose
        };
        res.json(quoteData);
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
