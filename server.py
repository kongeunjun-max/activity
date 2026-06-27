import http.server
import socketserver
import urllib.request
import urllib.parse
import json
import os
import random
from datetime import datetime, timedelta

PORT = 8080

# Load .env manually if exists
env_vars = {}
if os.path.exists('.env'):
    with open('.env', 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' in line:
                key, val = line.split('=', 1)
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                env_vars[key] = val

# Combine with system environment variables
for key, val in os.environ.items():
    env_vars[key] = val

STOCK_API_KEY = env_vars.get('STOCK_API_KEY', '')
STOCK_API_URL = env_vars.get('STOCK_API_URL', 'https://finnhub.io/api/v1')

SUPPORTED_STOCKS = [
    { 'symbol': 'MSFT', 'name': 'Microsoft' },
    { 'symbol': 'AAPL', 'name': 'Apple' },
    { 'symbol': 'NVDA', 'name': 'NVIDIA' },
    { 'symbol': 'GOOGL', 'name': 'Alphabet' },
    { 'symbol': 'AMZN', 'name': 'Amazon' },
    { 'symbol': 'META', 'name': 'Meta' },
    { 'symbol': 'BRK.B', 'name': 'Berkshire Hathaway' },
    { 'symbol': 'LLY', 'name': 'Eli Lilly' },
    { 'symbol': 'AVGO', 'name': 'Broadcom' },
    { 'symbol': 'TSLA', 'name': 'Tesla' },
    { 'symbol': '005930.KS', 'name': '삼성전자' },
    { 'symbol': '000660.KS', 'name': 'SK하이닉스' }
]

# High-fidelity realistic stock seed values in case Finnhub API Key is invalid or rate limited (429)
FALLBACK_SEEDS = {
    'MSFT': 415.0,
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
}

# Client-side cache to keep simulated prices steady and prevent flickering
stock_realtime_cache = {}

def get_fallback_price(symbol):
    if symbol not in stock_realtime_cache:
        base = FALLBACK_SEEDS.get(symbol, 100.0)
        stock_realtime_cache[symbol] = {
            'price': base,
            'prevClose': base * 0.99,
            'high': base * 1.01,
            'low': base * 0.985
        }
    
    cached = stock_realtime_cache[symbol]
    # Small brownian motion swing
    change = (random.random() - 0.5) * 0.003
    cached['price'] = cached['price'] * (1 + change)
    if cached['price'] > cached['high']: cached['high'] = cached['price']
    if cached['price'] < cached['low']: cached['low'] = cached['price']
    
    digits = 0 if symbol.endswith('.KS') else 2
    cached['price'] = round(cached['price'], digits)
    cached['high'] = round(cached['high'], digits)
    cached['low'] = round(cached['low'], digits)
    return cached

def get_fallback_history(symbol):
    base_price = FALLBACK_SEEDS.get(symbol, 100.0)
    data = []
    now = datetime.now()
    price = base_price * 0.9
    
    for i in range(90, -1, -1):
        date = now - timedelta(days=i)
        if date.weekday() >= 5:
            continue
        
        change = (random.random() - 0.48) * 0.03
        open_val = price
        close_val = price * (1 + change)
        high_val = max(open_val, close_val) * (1 + random.random() * 0.01)
        low_val = min(open_val, close_val) * (1 - random.random() * 0.01)
        
        digits = 0 if symbol.endswith('.KS') else 2
        data.append({
            'time': date.strftime('%Y-%m-%d'),
            'open': round(open_val, digits),
            'high': round(high_val, digits),
            'low': round(low_val, digits),
            'close': round(close_val, digits)
        })
        price = close_val
        
    return data

def fetch_from_finnhub(endpoint):
    if not STOCK_API_KEY:
        raise Exception("Finnhub STOCK_API_KEY is not configured in .env file.")
        
    url = f"{STOCK_API_URL}/{endpoint}&token={STOCK_API_KEY}"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=5) as response:
        if response.status == 200:
            return json.loads(response.read().decode('utf-8'))
        else:
            raise Exception(f"Finnhub HTTP Status {response.status}")

class QuantumTradeHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Enable CORS and disable cache
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

    def do_GET(self):
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path
        query_params = urllib.parse.parse_qs(parsed_url.query)

        # 1. API: Firebase Config
        if path == '/api/firebase-config':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            
            if not env_vars.get('FIREBASE_API_KEY'):
                self.wfile.write(json.dumps({ 'status': 'missing' }).encode('utf-8'))
                return
                
            config_res = {
                'status': 'ready',
                'config': {
                    'apiKey': env_vars.get('FIREBASE_API_KEY'),
                    'authDomain': env_vars.get('FIREBASE_AUTH_DOMAIN'),
                    'projectId': env_vars.get('FIREBASE_PROJECT_ID'),
                    'storageBucket': env_vars.get('FIREBASE_STORAGE_BUCKET'),
                    'messagingSenderId': env_vars.get('FIREBASE_MESSAGING_SENDER_ID'),
                    'appId': env_vars.get('FIREBASE_APP_ID'),
                    'measurementId': env_vars.get('FIREBASE_MEASUREMENT_ID')
                }
            }
            self.wfile.write(json.dumps(config_res).encode('utf-8'))
            return

        # 2. API: Supported Stocks
        if path == '/api/stocks':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(SUPPORTED_STOCKS).encode('utf-8'))
            return

        # 3. API: Stock Candlestick History
        if path == '/api/stock/history':
            symbol = query_params.get('symbol', ['AAPL'])[0]
            
            # Intercept Korean Stocks as Finnhub blocks them on Free tier
            if symbol.endswith('.KS'):
                history_data = get_fallback_history(symbol)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(history_data).encode('utf-8'))
                return
            
            try:
                import time
                now = int(time.time())
                from_ts = now - (90 * 24 * 60 * 60) # 90 days
                endpoint = f"stock/candle?symbol={symbol}&resolution=D&from={from_ts}&to={now}"
                raw_data = fetch_from_finnhub(endpoint)
                
                if raw_data.get('s') != 'ok' or not raw_data.get('t'):
                    raise Exception("No data from Finnhub.")
                    
                chart_data = []
                from datetime import datetime
                for i in range(len(raw_data['t'])):
                    dt = datetime.fromtimestamp(raw_data['t'][i])
                    chart_data.append({
                        'time': dt.strftime('%Y-%m-%d'),
                        'open': raw_data['o'][i],
                        'high': raw_data['h'][i],
                        'low': raw_data['l'][i],
                        'close': raw_data['c'][i]
                    })
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(chart_data).encode('utf-8'))
            except Exception as e:
                # API limit/key failure safety backup
                print(f"[Warning] Failed to fetch history for {symbol} from API, returning high-fidelity simulated chart.")
                fallback_data = get_fallback_history(symbol)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(fallback_data).encode('utf-8'))
            return

        # 4. API: Stock Realtime Quote
        if path == '/api/stock/realtime':
            symbol = query_params.get('symbol', ['AAPL'])[0]
            
            # Intercept Korean Stocks
            if symbol.endswith('.KS'):
                fallback = get_fallback_price(symbol)
                diff = fallback['price'] - fallback['prevClose']
                diff_percent = (diff / fallback['prevClose']) * 100
                
                quote_data = {
                    'c': fallback['price'],
                    'd': round(diff, 0),
                    'dp': round(diff_percent, 2),
                    'h': fallback['high'],
                    'l': fallback['low'],
                    'o': fallback['prevClose'],
                    'pc': fallback['prevClose']
                }
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(quote_data).encode('utf-8'))
                return
            
            try:
                endpoint = f"quote?symbol={symbol}"
                raw_data = fetch_from_finnhub(endpoint)
                if not raw_data.get('c'):
                    raise Exception("No current price data returned from Finnhub.")
                
                digits = 2
                quote_data = {
                    'c': round(raw_data['c'], digits),
                    'd': round(raw_data['d'], digits),
                    'dp': round(raw_data['dp'], 2),
                    'h': round(raw_data['h'], digits),
                    'l': round(raw_data['l'], digits),
                    'o': round(raw_data['o'], digits),
                    'pc': round(raw_data['pc'], digits)
                }
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(quote_data).encode('utf-8'))
            except Exception as e:
                # API limit/key failure safety backup
                fallback = get_fallback_price(symbol)
                diff = fallback['price'] - fallback['prevClose']
                diff_percent = (diff / fallback['prevClose']) * 100
                
                quote_data = {
                    'c': fallback['price'],
                    'd': round(diff, 2),
                    'dp': round(diff_percent, 2),
                    'h': fallback['high'],
                    'l': fallback['low'],
                    'o': fallback['prevClose'],
                    'pc': fallback['prevClose']
                }
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(quote_data).encode('utf-8'))
            return

        # Serve regular files
        return super().do_GET()

# Use Multi-threaded HTTP Server to prevent socket locking/hanging on concurrent browser assets fetch
class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True

if __name__ == '__main__':
    server_address = ('127.0.0.1', PORT)
    httpd = ThreadingHTTPServer(server_address, QuantumTradeHandler)
    print(f"QuantumTrade Multi-threaded Server started at http://localhost:{PORT}")
    print("Press Ctrl+C to terminate.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer terminated.")
