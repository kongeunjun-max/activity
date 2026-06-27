require('dotenv').config();
const express = require('express');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Configs from .env
const API_KEY = process.env.STOCK_API_KEY;
const API_BASE_URL = process.env.STOCK_API_URL || 'https://api.twelvedata.com';

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
        // Twelve Data symbol format transformation (e.g. 005930.KS -> 005930)
        const apiSymbol = symbol.endsWith('.KS') ? symbol.split('.')[0] : symbol;
        const endpoint = `time_series?symbol=${apiSymbol}&interval=1day&outputsize=90`;
        const rawData = await fetchFromTwelveData(endpoint);
        
        if (!rawData.values || rawData.values.length === 0) {
            throw new Error('No historical data found or API limit hit');
        }
        
        // Reverse array to follow oldest -> newest order
        const reversed = [...rawData.values].reverse();
        const digits = symbol.endsWith('.KS') ? 0 : 2;
        
        const chartData = reversed.map(val => {
            return {
                time: val.datetime.split(' ')[0], // YYYY-MM-DD
                open: parseFloat(parseFloat(val.open).toFixed(digits)),
                high: parseFloat(parseFloat(val.high).toFixed(digits)),
                low: parseFloat(parseFloat(val.low).toFixed(digits)),
                close: parseFloat(parseFloat(val.close).toFixed(digits))
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
        res.status(500).json({ error: `Twelve Data API Error: ${err.message}` });
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
        const apiSymbol = symbol.endsWith('.KS') ? symbol.split('.')[0] : symbol;
        const endpoint = `quote?symbol=${apiSymbol}`;
        const rawData = await fetchFromTwelveData(endpoint);
        
        if (!rawData || !rawData.close) {
            throw new Error('No quote data found or API limit hit');
        }
        
        const digits = symbol.endsWith('.KS') ? 0 : 2;
        const cVal = parseFloat(parseFloat(rawData.close).toFixed(digits));
        const pcVal = parseFloat(parseFloat(rawData.previous_close).toFixed(digits));
        const diff = cVal - pcVal;
        const diffPercent = (diff / pcVal) * 100;
        
        const quoteData = {
            c: cVal,
            d: parseFloat(diff.toFixed(digits)),
            dp: parseFloat(diffPercent.toFixed(2)),
            h: parseFloat(parseFloat(rawData.high).toFixed(digits)),
            l: parseFloat(parseFloat(rawData.low).toFixed(digits)),
            o: parseFloat(parseFloat(rawData.open).toFixed(digits)),
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
        res.status(500).json({ error: `Twelve Data API Error: ${err.message}` });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
