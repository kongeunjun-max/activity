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

# Client-side cache for Korean stocks realtime simulation to avoid sudden price jumps
korea_stock_cache = {
    '005930.KS': { 'price': 74200, 'prevClose': 73800, 'high': 74800, 'low': 73500 },
    '000660.KS': { 'price': 185300, 'prevClose': 183500, 'high': 187000, 'low': 182000 }
}

def generate_korean_history(symbol):
    base_price = 74200 if symbol == '005930.KS' else 185300
    data = []
    now = datetime.now()
    price = base_price * 0.9  # start slightly lower 90 days ago
    
    for i in range(90, -1, -1):
        date = now - timedelta(days=i)
        if date.weekday() >= 5: # Exclude weekends
            continue
        
        # Simple random walk
        change = (random.random() - 0.47) * 0.03 # slightly positive bias
        open_val = int(price)
        close_val = int(price * (1 + change))
        high_val = int(max(open_val, close_val) * (1 + random.random() * 0.01))
        low_val = int(min(open_val, close_val) * (1 - random.random() * 0.01))
        
        data.append({
            'time': date.strftime('%Y-%m-%d'),
            'open': open_val,
            'high': high_val,
            'low': low_val,
            'close': close_val
        })
        price = close_val
        
    # Update cache with latest simulated day's values
    korea_stock_cache[symbol]['price'] = price
    korea_stock_cache[symbol]['prevClose'] = data[-2]['close'] if len(data) > 1 else price
    korea_stock_cache[symbol]['high'] = int(price * 1.015)
    korea_stock_cache[symbol]['low'] = int(price * 0.985)
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
            
            # Intercept Korean Stocks (.KS) as Finnhub Free tier blocks/fails them
            if symbol.endswith('.KS'):
                history_data = generate_korean_history(symbol)
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
                    raise Exception("Invalid response structure or no data from Finnhub.")
                    
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
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({ 'error': str(e) }).encode('utf-8'))
            return

        # 4. API: Stock Realtime Quote
        if path == '/api/stock/realtime':
            symbol = query_params.get('symbol', ['AAPL'])[0]
            
            # Intercept Korean Stocks (.KS) as Finnhub Free tier blocks them
            if symbol.endswith('.KS'):
                cached = korea_stock_cache[symbol]
                # Slight random walk update for real-time tick changes
                change = (random.random() - 0.5) * 0.003
                cached['price'] = int(cached['price'] * (1 + change))
                if cached['price'] > cached['high']: cached['high'] = cached['price']
                if cached['price'] < cached['low']: cached['low'] = cached['price']
                
                diff = cached['price'] - cached['prevClose']
                diff_percent = (diff / cached['prevClose']) * 100
                
                quote_data = {
                    'c': cached['price'],
                    'd': diff,
                    'dp': round(diff_percent, 2),
                    'h': cached['high'],
                    'l': cached['low'],
                    'o': cached['prevClose'],
                    'pc': cached['prevClose']
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
                
                digits = 0 if symbol.endswith('.KS') else 2
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
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({ 'error': str(e) }).encode('utf-8'))
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
