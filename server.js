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

// Memory caches
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

// 10 Seconds Auto Batch Sync Poller
// Queries all 20 stocks in 1 single API call every 10 seconds.
// Absolutely no AI price manipulation or fake simulation seeds are allowed.
async function syncAllQuotesFromTwelveData() {
    if (!API_KEY) return;
    
    try {
        const symbolsStr = SUPPORTED_STOCKS.map(s => s.symbol).join(',');
        const endpoint = `quote?symbol=${symbolsStr}`;
        const rawData = await fetchFromTwelveData(endpoint);
        
        // Twelve Data returns object keyed by symbols for batch queries
        SUPPORTED_STOCKS.forEach(stock => {
            const sym = stock.symbol;
            const quote = rawData[sym];
            if (quote && quote.close) {
                const digits = 2;
                const cVal = parseFloat(parseFloat(quote.close).toFixed(digits));
                const pcVal = parseFloat(parseFloat(quote.previous_close).toFixed(digits));
                const diff = cVal - pcVal;
                const diffPercent = (diff / pcVal) * 100;
                
                quoteCache[sym] = {
                    c: cVal,
                    d: parseFloat(diff.toFixed(2)),
                    dp: parseFloat(diffPercent.toFixed(2)),
                    h: parseFloat(parseFloat(quote.high).toFixed(2)),
                    l: parseFloat(parseFloat(quote.low).toFixed(2)),
                    o: parseFloat(parseFloat(quote.open).toFixed(2)),
                    pc: pcVal
                };
            }
        });
        console.log(`[Batch Sync] Successfully updated 20 stocks at ${new Date().toLocaleTimeString()}`);
    } catch (err) {
        console.error('[Batch Sync Failed]:', err.message);
    }
}

// Start batch syncing immediately and repeat every 10 seconds (6 times per minute)
setTimeout(syncAllQuotesFromTwelveData, 1000);
setInterval(syncAllQuotesFromTwelveData, 10000);

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

// 2. Get Historical Candlestick Data (Cached for 5 minutes, 100% unaltered real data only)
app.get('/api/stock/history', async (req, res) => {
    const symbol = req.query.symbol || 'AAPL';
    const timeframe = req.query.timeframe || '3M';
    const cacheKey = `${symbol}_${timeframe}`;
    
    // Check 5 minutes cache
    const cached = historyCache[cacheKey];
    if (cached && (Date.now() - cached.timestamp < 300000)) {
        return res.json(cached.data);
    }

    // Timeframe configurations for Twelve Data API
    const configMap = {
        '1D': { interval: '1min', outputsize: 80 },
        '1W': { interval: '15min', outputsize: 130 },
        '1M': { interval: '1day', outputsize: 30 },
        '3M': { interval: '1day', outputsize: 90 },
        '1Y': { interval: '1week', outputsize: 52 },
        '5Y': { interval: '1month', outputsize: 60 },
        '10Y': { interval: '1month', outputsize: 120 }
    };
    
    const config = configMap[timeframe] || configMap['3M'];

    try {
        const endpoint = `time_series?symbol=${symbol}&interval=${config.interval}&outputsize=${config.outputsize}`;
        const rawData = await fetchFromTwelveData(endpoint);
        
        if (!rawData.values || rawData.values.length === 0) {
            throw new Error('No historical data found or API limit hit');
        }
        
        // Reverse array to follow oldest -> newest order
        const reversed = [...rawData.values].reverse();
        
        const chartData = reversed.map(val => {
            let isoStr = val.datetime;
            if (val.datetime.includes(' ')) {
                isoStr = val.datetime.replace(' ', 'T') + 'Z';
            } else {
                isoStr = val.datetime + 'T00:00:00Z';
            }
            const timestamp = Math.floor(new Date(isoStr).getTime() / 1000);
            return {
                time: timestamp, // Unix timestamp in seconds for perfect time-axis on intraday/monthly charts
                open: parseFloat(parseFloat(val.open).toFixed(2)),
                high: parseFloat(parseFloat(val.high).toFixed(2)),
                low: parseFloat(parseFloat(val.low).toFixed(2)),
                close: parseFloat(parseFloat(val.close).toFixed(2))
            };
        });
        
        // Update cache
        historyCache[cacheKey] = {
            data: chartData,
            timestamp: Date.now()
        };
        
        res.json(chartData);
    } catch (err) {
        console.error(`Error fetching history for ${symbol} with timeframe ${timeframe}:`, err.message);
        // Strictly return HTTP 500 error instead of faking data
        res.status(500).json({ error: 'Twelve Data API Rate Limit Exceeded or Network Error' });
    }
});

// 3. Get Realtime Quote (Served instantly from 10-seconds raw batch sync cache)
app.get('/api/stock/realtime', async (req, res) => {
    const symbol = req.query.symbol || 'AAPL';
    const cached = quoteCache[symbol];
    if (cached) {
        // Return 100% raw, unaltered stock data directly from the batch sync
        return res.json(cached);
    }
    
    // If cache not warmed up, attempt immediate fetch or throw 500
    try {
        const endpoint = `quote?symbol=${symbol}`;
        const rawData = await fetchFromTwelveData(endpoint);
        if (!rawData || !rawData.close) {
            throw new Error('No quote data found from Twelve Data');
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
        quoteCache[symbol] = quoteData;
        res.json(quoteData);
    } catch (err) {
        console.error(`Fallback fetch failed for ${symbol}:`, err.message);
        res.status(500).json({ error: 'Twelve Data API Rate Limit Exceeded or Network Error' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
