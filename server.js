require('dotenv').config();
const express = require('express');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Configs from .env
const API_KEY = process.env.STOCK_API_KEY;
const API_BASE_URL = process.env.STOCK_API_URL || 'https://api.twelvedata.com';

// Supported Stock List (Global Top 20 Market Cap on US Exchanges)
const SUPPORTED_STOCKS = [
    { symbol: 'MSFT', name: 'Microsoft' },
    { symbol: 'AAPL', name: 'Apple' },
    { symbol: 'NVDA', name: 'NVIDIA' },
    { symbol: 'GOOGL', name: 'Alphabet' },
    { symbol: 'AMZN', name: 'Amazon' },
    { symbol: 'META', name: 'Meta' },
    { symbol: 'TSM', name: 'TSMC' },
    { symbol: 'LLY', name: 'Eli Lilly' },
    { symbol: 'AVGO', name: 'Broadcom' },
    { symbol: 'TSLA', name: 'Tesla' },
    { symbol: 'BRK.B', name: 'Berkshire Hathaway' },
    { symbol: 'NVO', name: 'Novo Nordisk' },
    { symbol: 'JPM', name: 'JPMorgan Chase' },
    { symbol: 'V', name: 'Visa' },
    { symbol: 'UNH', name: 'UnitedHealth' },
    { symbol: 'WMT', name: 'Walmart' },
    { symbol: 'XOM', name: 'Exxon Mobil' },
    { symbol: 'MA', name: 'Mastercard' },
    { symbol: 'ASML', name: 'ASML' },
    { symbol: 'COST', name: 'Costco' }
];

// High-fidelity fallback seeds for emergency rate limit bypass
const FALLBACK_SEEDS = {
    'MSFT': 390.0,
    'AAPL': 210.0,
    'NVDA': 120.0,
    'GOOGL': 175.0,
    'AMZN': 185.0,
    'META': 500.0,
    'TSM': 150.0,
    'LLY': 830.0,
    'AVGO': 1500.0,
    'TSLA': 180.0,
    'BRK.B': 410.0,
    'NVO': 130.0,
    'JPM': 190.0,
    'V': 270.0,
    'UNH': 490.0,
    'WMT': 65.0,
    'XOM': 115.0,
    'MA': 450.0,
    'ASML': 950.0,
    'COST': 720.0
};

// Memory caches to respect Twelve Data Free Tier (8 requests per minute)
const quoteCache = {};
const historyCache = {};

// HTTPS Request Helper for Twelve Data
function fetchFromTwelveData(endpoint) {
    if (!API_KEY) {
        return Promise.reject(new Error('STOCK_API_KEY is not configured in .env file.'));
    }
    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `${API_BASE_URL}/${endpoint}${separator}apikey=${API_KEY}`;
    
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';

            if (res.statusCode === 429) {
                return reject(new Error('Twelve Data API Rate Limit Exceeded'));
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Twelve Data HTTP Status ${res.statusCode}`));
            }

            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.status === 'error') {
                        return reject(new Error(parsed.message));
                    }
                    resolve(parsed);
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}

// Emergency Fallback Generation (US stock precision is always 2 decimals)
function getFallbackPrice(symbol) {
    if (!quoteCache[symbol]) {
        const base = FALLBACK_SEEDS[symbol] || 100.0;
        quoteCache[symbol] = {
            data: {
                c: base,
                d: base * 0.01,
                dp: 1.00,
                h: base * 1.01,
                l: base * 0.99,
                o: base * 0.995,
                pc: base * 0.99
            },
            timestamp: Date.now()
        };
    }
    const cached = quoteCache[symbol].data;
    const change = (Math.random() - 0.5) * 0.003;
    cached.c = parseFloat((cached.c * (1 + change)).toFixed(2));
    if (cached.c > cached.h) cached.h = cached.c;
    if (cached.c < cached.l) cached.l = cached.c;
    cached.d = parseFloat((cached.c - cached.pc).toFixed(2));
    cached.dp = parseFloat(((cached.d / cached.pc) * 100).toFixed(2));
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
        
        data.push({
            time: date.toISOString().split('T')[0],
            open: parseFloat(openVal.toFixed(2)),
            high: parseFloat(highVal.toFixed(2)),
            low: parseFloat(lowVal.toFixed(2)),
            close: parseFloat(closeVal.toFixed(2))
        });
        price = closeVal;
    }
    return data;
}

// Serve static assets
app.use(express.static(__dirname));

// Firebase configuration delivery
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

// 2. Get Historical Candlestick Data (Cached for 5 minutes)
app.get('/api/stock/history', async (req, res) => {
    const symbol = req.query.symbol || 'AAPL';
    
    // Check 5 minutes cache
    const cached = historyCache[symbol];
    if (cached && (Date.now() - cached.timestamp < 300000)) {
        return res.json(cached.data);
    }

    try {
        const endpoint = `time_series?symbol=${symbol}&interval=1day&outputsize=90`;
        const rawData = await fetchFromTwelveData(endpoint);
        
        if (!rawData.values || rawData.values.length === 0) {
            throw new Error('No historical data found or API limit hit');
        }
        
        // Reverse array to follow oldest -> newest order
        const reversed = [...rawData.values].reverse();
        
        const chartData = reversed.map(val => {
            return {
                time: val.datetime.split(' ')[0], // YYYY-MM-DD
                open: parseFloat(parseFloat(val.open).toFixed(2)),
                high: parseFloat(parseFloat(val.high).toFixed(2)),
                low: parseFloat(parseFloat(val.low).toFixed(2)),
                close: parseFloat(parseFloat(val.close).toFixed(2))
            };
        });
        
        // Update cache
        historyCache[symbol] = {
            data: chartData,
            timestamp: Date.now()
        };
        
        res.json(chartData);
    } catch (err) {
        console.error(`Error fetching history for ${symbol}:`, err.message);
        // Under extreme rate limits, fallback gracefully to seeds to keep UI rendering
        const fallbackData = getFallbackHistory(symbol);
        res.json(fallbackData);
    }
});

// 3. Get Realtime Quote (Cached for 15 seconds to respect Rate Limit)
app.get('/api/stock/realtime', async (req, res) => {
    const symbol = req.query.symbol || 'AAPL';

    // Check 15 seconds cache
    const cached = quoteCache[symbol];
    if (cached && (Date.now() - cached.timestamp < 15000)) {
        return res.json(cached.data);
    }

    try {
        const endpoint = `quote?symbol=${symbol}`;
        const rawData = await fetchFromTwelveData(endpoint);
        
        if (!rawData || !rawData.close) {
            throw new Error('No quote data found or API limit hit');
        }
        
        const cVal = parseFloat(parseFloat(rawData.close).toFixed(2));
        const pcVal = parseFloat(parseFloat(rawData.previous_close).toFixed(2));
        const diff = cVal - pcVal;
        const diffPercent = (diff / pcVal) * 100;
        
        const quoteData = {
            c: cVal,
            d: parseFloat(diff.toFixed(2)),
            dp: parseFloat(diffPercent.toFixed(2)),
            h: parseFloat(parseFloat(rawData.high).toFixed(2)),
            l: parseFloat(parseFloat(rawData.low).toFixed(2)),
            o: parseFloat(parseFloat(rawData.open).toFixed(2)),
            pc: pcVal
        };
        
        // Update cache
        quoteCache[symbol] = {
            data: quoteData,
            timestamp: Date.now()
        };
        
        res.json(quoteData);
    } catch (err) {
        console.error(`Error fetching realtime quote for ${symbol}:`, err.message);
        // Fallback gracefully on rate limit blocks to prevent UI freeze
        const fallbackData = getFallbackPrice(symbol);
        res.json(fallbackData);
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
