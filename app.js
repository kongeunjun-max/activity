// Global State
const state = {
    balance: 100000000,    // Default 100,000,000 KRW
    holdings: {},          // Portfolio holdings { 'AAPL': { quantity: 5, avgPrice: 220 } }
    pendingOrders: [],     // Active Limit Orders [{ id, symbol, type: 'buy'|'sell', price, qty, time }]
    history: [],           // Filled / Cancelled Transaction History list
    currentStock: 'AAPL',
    currentTimeframe: '3M',// Selected Chart Timeframe (1D, 1W, 1M, 3M, 1Y, 5Y, 10Y)
    orderType: 'buy',      // 'buy' or 'sell'
    stocks: {}             // Stock details metadata
};

// TradingView & Polling references
let chart = null;
let areaSeries = null;
let pollingTimer = null;
let auth = null;
let db = null;
let firestoreUnsubscribe = null;
let leaderboardUnsubscribe = null;

// ==========================================
// 1. Firebase Authentication Setup
// ==========================================

async function initAuthentication() {
    const response = await fetch('/api/firebase-config');
    if (!response.ok) throw new Error('서버로부터 Firebase 설정을 가져오는 데 실패했습니다.');
    
    const data = await response.json();
    if (data.status !== 'ready') {
        throw new Error('서버의 .env 파일에 Firebase 설정값이 채워지지 않았습니다.');
    }
    
    if (typeof firebase === 'undefined') {
        throw new Error('인터넷 연결 문제 등으로 Firebase CDN 라이브러리를 로드하지 못했습니다.');
    }
    
    // Initialize Firebase
    firebase.initializeApp(data.config);
    auth = firebase.auth();
    db = firebase.firestore();
    
    // Listen for Auth changes
    auth.onAuthStateChanged(handleAuthStateChanged);
}

// Handle Authentication State Changes
async function handleAuthStateChanged(user) {
    if (user) {
        state.currentUser = {
            uid: user.uid,
            email: user.email
        };
        subscribeUserFirestore(user.uid);
        subscribeLeaderboard();
    } else {
        if (firestoreUnsubscribe) {
            firestoreUnsubscribe();
            firestoreUnsubscribe = null;
        }
        if (leaderboardUnsubscribe) {
            leaderboardUnsubscribe();
            leaderboardUnsubscribe = null;
        }
        state.currentUser = null;
        exitAppSession();
    }
}

// Subscribe to Firestore for real-time portfolio, balance, and pending orders updates
function subscribeUserFirestore(uid) {
    if (!db) return;
    
    const userDocRef = db.collection("users").doc(uid);
    
    firestoreUnsubscribe = userDocRef.onSnapshot((docSnap) => {
        if (docSnap.exists) {
            const data = docSnap.data();
            state.balance = data.balance !== undefined ? data.balance : 100000000;
            state.holdings = data.holdings || {};
            state.pendingOrders = data.pendingOrders || [];
            state.history = data.history || [];
            state.currentUser.username = data.username || '트레이더';
            
            syncPendingOrdersToHistory();
            enterAppSession();
            updateUI();
        } else {
            userDocRef.set({
                uid: uid,
                email: state.currentUser.email,
                username: state.currentUser.email.split('@')[0],
                balance: 100000000,
                holdings: {},
                pendingOrders: [],
                history: [],
                totalAsset: 100000000,
                profitRate: 0,
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        }
    }, (err) => {
        console.error("Firestore user subscription error:", err);
    });
}

// Subscribe to global users leaderboard top 10 from Firestore
function subscribeLeaderboard() {
    if (!db) return;
    
    if (leaderboardUnsubscribe) leaderboardUnsubscribe();
    
    const q = db.collection("users").orderBy("totalAsset", "desc").limit(10);
    
    leaderboardUnsubscribe = q.onSnapshot((querySnapshot) => {
        const leaderboardTbody = document.getElementById('leaderboard-tbody');
        if (!leaderboardTbody) return;
        leaderboardTbody.innerHTML = '';
        
        let rank = 1;
        querySnapshot.forEach((doc) => {
            const userData = doc.data();
            const isMe = userData.uid === state.currentUser?.uid;
            
            const tr = document.createElement('tr');
            if (isMe) tr.className = 'user-row';
            
            const total = userData.totalAsset || 100000000;
            const rate = userData.profitRate || 0;
            
            let rankBadge = `<span class="rank">${rank}</span>`;
            if (rank === 1) rankBadge = `<span class="rank rank-1">1</span>`;
            if (rank === 2) rankBadge = `<span class="rank rank-2">2</span>`;
            
            tr.innerHTML = `
                <td>${rankBadge}</td>
                <td>${userData.username || '트레이더'} ${isMe ? '(나)' : ''}</td>
                <td>₩${Math.round(total).toLocaleString()}</td>
                <td class="${rate > 0 ? 'positive' : (rate < 0 ? 'negative' : 'neutral')}">
                    ${rate >= 0 ? '+' : ''}${rate.toFixed(2)}%
                </td>
            `;
            leaderboardTbody.appendChild(tr);
            rank++;
        });
        
        if (rank === 1) {
            leaderboardTbody.innerHTML = '<tr><td colspan="4" class="neutral" style="text-align:center;">순위표 데이터가 비어 있습니다.</td></tr>';
        }
    }, (err) => {
        console.error("Leaderboard subscription error:", err);
    });
}

// Auth Event Hooks
function setupAuthEventListeners() {
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const tabLoginMode = document.getElementById('tab-login-mode');
    const tabRegisterMode = document.getElementById('tab-register-mode');
    
    tabLoginMode.onclick = () => {
        tabLoginMode.classList.add('active');
        tabRegisterMode.classList.remove('active');
        loginForm.classList.remove('hidden');
        registerForm.classList.add('hidden');
        document.getElementById('login-error').innerText = '';
        document.getElementById('register-error').innerText = '';
    };
    
    tabRegisterMode.onclick = () => {
        tabRegisterMode.classList.add('active');
        tabLoginMode.classList.remove('active');
        registerForm.classList.remove('hidden');
        loginForm.classList.add('hidden');
        document.getElementById('login-error').innerText = '';
        document.getElementById('register-error').innerText = '';
    };
    
    loginForm.onsubmit = async (e) => {
        e.preventDefault();
        const email = document.getElementById('login-email').value.trim();
        const password = document.getElementById('login-password').value;
        const errEl = document.getElementById('login-error');
        errEl.innerText = '';
        
        if (!auth) {
            errEl.innerText = '서버와 Firebase가 연동되지 않은 상태입니다. .env 설정을 확인해 주세요.';
            return;
        }
        
        try {
            await auth.signInWithEmailAndPassword(email, password);
        } catch (err) {
            console.error(err);
            errEl.innerText = translateAuthError(err.code);
        }
    };
    
    registerForm.onsubmit = async (e) => {
        e.preventDefault();
        const username = document.getElementById('register-username').value.trim();
        const email = document.getElementById('register-email').value.trim();
        const password = document.getElementById('register-password').value;
        const passwordConfirm = document.getElementById('register-password-confirm').value;
        const errEl = document.getElementById('register-error');
        errEl.innerText = '';
        
        if (!auth || !db) {
            errEl.innerText = '서버와 Firebase가 연동되지 않은 상태입니다. .env 설정을 확인해 주세요.';
            return;
        }
        
        if (password.length < 6) {
            errEl.innerText = '비밀번호는 최소 6자리 이상이어야 합니다.';
            return;
        }
        if (password !== passwordConfirm) {
            errEl.innerText = '비밀번호가 서로 일치하지 않습니다.';
            return;
        }
        
        try {
            const credential = await auth.createUserWithEmailAndPassword(email, password);
            const user = credential.user;
            
            await db.collection("users").doc(user.uid).set({
                uid: user.uid,
                email: email,
                username: username,
                balance: 100000000,
                holdings: {},
                pendingOrders: [],
                history: [],
                totalAsset: 100000000,
                profitRate: 0,
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        } catch (err) {
            console.error(err);
            errEl.innerText = translateAuthError(err.code);
        }
    };
    
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.onclick = async () => {
            if (auth) await auth.signOut();
        };
    }
}

function enterAppSession() {
    const authModal = document.getElementById('auth-modal');
    if (authModal) authModal.classList.add('hidden');
    
    const appContainer = document.querySelector('.app-container');
    if (appContainer) appContainer.classList.remove('blur-active');
    
    const displayName = state.currentUser.username || state.currentUser.email.split('@')[0];
    const usernameEl = document.getElementById('username');
    if (usernameEl) usernameEl.innerText = displayName;
    
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.classList.remove('hidden');
    
    if (!chart) {
        loadChartHistory(state.currentStock).then(() => {
            startRealtimePolling();
        });
    } else {
        updateUI();
    }
    
    lucide.createIcons();
}

function exitAppSession() {
    const authModal = document.getElementById('auth-modal');
    if (authModal) authModal.classList.remove('hidden');
    
    const appContainer = document.querySelector('.app-container');
    if (appContainer) appContainer.classList.add('blur-active');
    
    const usernameEl = document.getElementById('username');
    if (usernameEl) usernameEl.innerText = '로그인 필요';
    
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.classList.add('hidden');
    
    // Clear user-specific UI data on logout
    state.balance = 100000000;
    state.holdings = {};
    state.pendingOrders = [];
    state.history = [];
    
    const balEl = document.getElementById('user-balance');
    if (balEl) balEl.innerText = '₩100,000,000';
    const assetEl = document.getElementById('user-total-asset');
    if (assetEl) assetEl.innerText = '₩100,000,000';
    const profitValEl = document.getElementById('user-total-profit');
    if (profitValEl) profitValEl.innerText = '₩0 (0.00%)';
    const portfolioTbody = document.getElementById('portfolio-tbody');
    if (portfolioTbody) portfolioTbody.innerHTML = '<tr class="empty-row"><td colspan="5">보유 중인 주식이 없습니다.</td></tr>';
    const historyTbody = document.getElementById('history-tbody');
    if (historyTbody) historyTbody.innerHTML = '<tr class="empty-row"><td colspan="6">체결 내역이 없습니다.</td></tr>';
    
    if (pollingTimer) {
        clearInterval(pollingTimer);
        pollingTimer = null;
    }
    if (chart) {
        try {
            chart.remove(); // 메모리 릭 방지
        } catch (e) {
            console.error(e);
        }
        chart = null;
        areaSeries = null;
        const container = document.getElementById('stock-chart');
        if (container) container.innerHTML = '';
    }
}

function translateAuthError(code) {
    switch (code) {
        case 'auth/email-already-in-use':
            return '이미 가입된 이메일 주소입니다.';
        case 'auth/invalid-email':
            return '올바르지 않은 이메일 형식입니다.';
        case 'auth/weak-password':
            return '비밀번호가 너무 취약합니다.';
        case 'auth/wrong-password':
        case 'auth/user-not-found':
        case 'auth/invalid-credential':
            return '이메일 또는 비밀번호가 올바르지 않습니다.';
        case 'auth/operation-not-allowed':
            return 'Firebase 콘솔의 Authentication -> Sign-in method에서 [이메일/비밀번호] 로그인을 활성화해야 합니다. (auth/operation-not-allowed)';
        case 'permission-denied':
            return '데이터베이스(Firestore) 쓰기 권한이 없습니다. 규칙을 [테스트 모드]로 변경해 주세요. (permission-denied)';
        default:
            return `인증 처리 도중 오류가 발생했습니다. (${code || 'unknown'})`;
    }
}

// Sync active limit orders from database to transaction history local cache list
function syncPendingOrdersToHistory() {
    state.history = state.history.filter(item => item.status !== '대기');
    
    state.pendingOrders.forEach(order => {
        const isKRW = order.symbol.endsWith('.KS');
        const currency = isKRW ? '₩' : '$';
        const digits = isKRW ? 0 : 2;
        
        state.history.push({
            id: order.id,
            time: order.time,
            symbol: order.symbol,
            type: order.type === 'buy' ? '매수' : '매도',
            price: `${currency}${order.price.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })} (지정가)`,
            qty: order.qty,
            status: '대기'
        });
    });
    
    updateHistoryTable();
}

// ==========================================
// 2. Chart Rendering & Polling Operations
// ==========================================

function initTradingViewChart() {
    const chartContainer = document.getElementById('stock-chart');
    if (!chartContainer) return;
    
    // 이전 차트 인스턴스가 존재할 경우 확실히 해제(remove)하지 않으면 캔버스 중첩/락 크래시가 유발됨
    if (chart) {
        try {
            chart.remove();
        } catch (e) {
            console.error("Error disposing old chart:", e);
        }
        chart = null;
        areaSeries = null;
    }
    
    chartContainer.innerHTML = '';
    
    chart = LightweightCharts.createChart(chartContainer, {
        layout: {
            background: { type: 'solid', color: 'transparent' },
            textColor: '#9ca3af',
            fontSize: 11,
            fontFamily: 'Outfit, Noto Sans KR, sans-serif',
        },
        grid: {
            vertLines: { color: 'rgba(255, 255, 255, 0.02)' },
            horzLines: { color: 'rgba(255, 255, 255, 0.02)' },
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
            vertLine: {
                color: 'rgba(0, 242, 254, 0.3)',
                width: 1,
                style: 3,
                labelBackgroundColor: '#1f2937',
            },
            horzLine: {
                color: 'rgba(0, 242, 254, 0.3)',
                width: 1,
                style: 3,
                labelBackgroundColor: '#1f2937',
            },
        },
        rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.08)' },
        timeScale: { borderColor: 'rgba(255, 255, 255, 0.08)', timeVisible: true },
    });

    const isKRW = state.currentStock.endsWith('.KS');
    
    // 봉 차트 대신 그라데이션 광택이 가미된 예쁜 영역 곡선형 차트로 구현
    areaSeries = chart.addAreaSeries({
        topColor: isKRW ? 'rgba(0, 255, 135, 0.35)' : 'rgba(0, 242, 254, 0.35)',
        bottomColor: 'rgba(0, 0, 0, 0)',
        lineColor: isKRW ? 'rgba(0, 255, 135, 1)' : 'rgba(0, 242, 254, 1)',
        lineWidth: 3,
        crosshairMarkerVisible: true,
        priceFormat: {
            type: 'price',
            precision: isKRW ? 0 : 2,
            minMove: isKRW ? 1 : 0.01
        }
    });

    const resizeObserver = new ResizeObserver(entries => {
        if (entries.length === 0 || !entries[0].contentRect || !chart) return;
        const { width, height } = entries[0].contentRect;
        chart.resize(width, height);
    });
    if (chartContainer.parentElement) {
        resizeObserver.observe(chartContainer.parentElement);
    }
}

async function fetchStockList() {
    const response = await fetch('/api/stocks');
    if (!response.ok) throw new Error('API server down');
    
    const stockList = await response.json();
    const selector = document.getElementById('stock-selector');
    selector.innerHTML = '';
    
    stockList.forEach(stock => {
        const opt = document.createElement('option');
        opt.value = stock.symbol;
        opt.innerText = `${stock.name} (${stock.symbol})`;
        selector.appendChild(opt);
        
        state.stocks[stock.symbol] = {
            name: stock.name,
            price: 0,
            prevClose: 0,
            high: 0,
            low: 0,
            volume: 0
        };
    });
    
    if (stockList.length > 0) {
        state.currentStock = stockList[0].symbol;
        selector.value = state.currentStock;
    }
}

async function loadChartHistory(symbol, timeframe) {
    const tf = timeframe || state.currentTimeframe || '3M';
    // 종목에 맞는 원화/달러화 포맷과 색상 곡선 반영을 위해 진입 시 차트를 새로 빌드
    initTradingViewChart();
    
    if (!chart) return;
    
    const loadingOverlay = document.getElementById('chart-loading');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    
    try {
        const response = await fetch(`/api/stock/history?symbol=${symbol}&timeframe=${tf}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const historyData = await response.json();
        if (historyData && historyData.length > 0) {
            const mappedData = historyData.map(d => ({
                time: d.time,
                value: d.close
            }));
            areaSeries.setData(mappedData);
            chart.timeScale().fitContent();
            
            // Set initial state price
            const lastCandle = historyData[historyData.length - 1];
            if (state.stocks[symbol]) {
                state.stocks[symbol].price = lastCandle.close;
            }
        }
    } catch (err) {
        console.error(`Failed to load history for ${symbol} (${tf}):`, err);
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
}

async function updateRealtimeQuote(symbol) {
    const stock = state.stocks[symbol];
    if (!stock) return;
    
    try {
        const response = await fetch(`/api/stock/realtime?symbol=${symbol}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const data = await response.json();
        if (!data || !data.c) return;
        
        stock.price = data.c;
        stock.prevClose = data.pc || data.o;
        stock.high = data.h;
        stock.low = data.l;
        stock.volume = data.v || 500000;
        
        
        let updateTime;
        if (state.currentTimeframe === '1D' || state.currentTimeframe === '1W') {
            updateTime = Math.floor(Date.now() / 1000);
        } else {
            const dateStr = new Date().toISOString().split('T')[0];
            updateTime = Math.floor(new Date(dateStr).getTime() / 1000);
        }
        if (areaSeries) {
            areaSeries.update({
                time: updateTime,
                value: data.c
            });
        }

        const statusDot = document.getElementById('status-dot');
        const connStatus = document.getElementById('connection-status');
        if (statusDot) statusDot.className = 'status-dot online';
        if (connStatus) connStatus.innerText = '실시간 서버 연결됨';
        
        updateUI();
        
        // Trigger limit order checking
        checkPendingOrders(symbol, stock.price);
    } catch (err) {
        console.error(`Failed to update realtime data for ${symbol}:`, err);
        const statusDot = document.getElementById('status-dot');
        const connStatus = document.getElementById('connection-status');
        if (statusDot) statusDot.className = 'status-dot offline';
        if (connStatus) connStatus.innerText = '서버 연결 끊김';
    }
    
    // Periodically sync user assets valuation back to Firestore
    if (state.currentUser && Math.random() < 0.25) {
        syncUserAssets();
    }
}

function startRealtimePolling() {
    if (pollingTimer) clearInterval(pollingTimer);
    updateRealtimeQuote(state.currentStock);
    pollingTimer = setInterval(() => {
        updateRealtimeQuote(state.currentStock);
    }, 4000);
}

// ==========================================
// 3. Limit Order Matching Logic
// ==========================================

async function checkPendingOrders(symbol, currentPrice) {
    if (!state.currentUser || state.pendingOrders.length === 0) return;
    
    let matchedAny = false;
    const newHoldings = JSON.parse(JSON.stringify(state.holdings));
    let newBalance = state.balance;
    const remainingOrders = [];
    
    for (const order of state.pendingOrders) {
        if (order.symbol !== symbol) {
            remainingOrders.push(order);
            continue;
        }
        
        let triggerMatch = false;
        
        if (order.type === 'buy') {
            if (currentPrice <= order.price) {
                triggerMatch = true;
                
                if (!newHoldings[symbol]) {
                    newHoldings[symbol] = { quantity: 0, avgPrice: 0 };
                }
                const hold = newHoldings[symbol];
                const newQty = hold.quantity + order.qty;
                const orderCost = order.price * order.qty;
                const newAvg = ((hold.avgPrice * hold.quantity) + orderCost) / newQty;
                
                const digits = symbol.endsWith('.KS') ? 0 : 2;
                hold.quantity = newQty;
                hold.avgPrice = parseFloat(newAvg.toFixed(digits));
            }
        } else {
            if (currentPrice >= order.price) {
                triggerMatch = true;
                const exchangeRate = symbol.endsWith('.KS') ? 1 : 1400;
                const orderRevenue = (order.price * order.qty) * exchangeRate;
                newBalance += orderRevenue;
            }
        }
        
        if (triggerMatch) {
            matchedAny = true;
            const timeString = new Date().toLocaleTimeString('ko-KR', { hour12: false });
            const isSymbolKRW = symbol.endsWith('.KS');
            const currency = isSymbolKRW ? '₩' : '$';
            const digits = isSymbolKRW ? 0 : 2;
            const formatPrice = (v) => v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
            
            state.history.unshift({
                id: order.id,
                time: timeString,
                symbol: symbol,
                type: order.type === 'buy' ? '매수' : '매도',
                price: `${currency}${formatPrice(order.price)} (지정가)`,
                qty: order.qty,
                status: '체결'
            });
            
            alert(`[알림] 지정가 주문 체결!\n${symbol} ${order.qty}주가 ${currency}${formatPrice(order.price)}에 체결되었습니다.`);
        } else {
            remainingOrders.push(order);
        }
    }
    
    if (matchedAny) {
        state.balance = newBalance;
        state.holdings = newHoldings;
        state.pendingOrders = remainingOrders;
        
        await syncUserAssets();
        syncPendingOrdersToHistory();
        updateUI();
    }
}

// User Assets Sync Helper
async function syncUserAssets() {
    if (!state.currentUser || !db) return;
    
    let totalEvalHoldings = 0;
    let totalBuyHoldings = 0;
    let lockedOrdersValue = 0;
    
    Object.keys(state.holdings).forEach(holdSym => {
        const hold = state.holdings[holdSym];
        const curStock = state.stocks[holdSym];
        const currentPrice = curStock && curStock.price > 0 ? curStock.price : hold.avgPrice;
        
        const rate = holdSym.endsWith('.KS') ? 1 : 1400;
        totalEvalHoldings += (currentPrice * hold.quantity) * rate;
        totalBuyHoldings += (hold.avgPrice * hold.quantity) * rate;
    });
    
    state.pendingOrders.forEach(order => {
        if (order.type === 'buy') {
            const rate = order.symbol.endsWith('.KS') ? 1 : 1400;
            lockedOrdersValue += (order.price * order.qty) * rate;
        }
    });
    
    const totalAssets = state.balance + totalEvalHoldings + lockedOrdersValue;
    const profitRate = totalAssets === 100000000 ? 0 : ((totalAssets - 100000000) / 100000000) * 100;
    
    try {
        const userDocRef = db.collection("users").doc(state.currentUser.uid);
        await userDocRef.update({
            balance: state.balance,
            holdings: state.holdings,
            pendingOrders: state.pendingOrders,
            history: state.history,
            totalAsset: totalAssets,
            profitRate: profitRate
        });
    } catch (err) {
        console.error('Failed to sync assets with Firestore:', err);
    }
}

// Cancel Pending Limit Order Action
async function cancelOrder(orderId) {
    const orderIndex = state.pendingOrders.findIndex(o => o.id === orderId);
    if (orderIndex === -1) return;
    
    const order = state.pendingOrders[orderIndex];
    const symbol = order.symbol;
    const exchangeRate = symbol.endsWith('.KS') ? 1 : 1400;
    
    if (order.type === 'buy') {
        const lockedCostKRW = (order.price * order.qty) * exchangeRate;
        state.balance += lockedCostKRW;
    } else {
        if (!state.holdings[symbol]) {
            state.holdings[symbol] = { quantity: 0, avgPrice: order.price };
        }
        state.holdings[symbol].quantity += order.qty;
    }
    
    state.pendingOrders.splice(orderIndex, 1);
    
    const timeString = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    state.history.unshift({
        id: order.id,
        time: timeString,
        symbol: symbol,
        type: order.type === 'buy' ? '매수' : '매도',
        price: `${symbol.endsWith('.KS') ? '₩' : '$'}${order.price.toLocaleString()} (지정가)`,
        qty: order.qty,
        status: '취소'
    });
    
    await syncUserAssets();
    syncPendingOrdersToHistory();
    updateUI();
    
    alert('대기 중인 지정가 주문이 취소되었습니다.');
}
window.cancelOrder = cancelOrder;

// ==========================================
// 4. UI Syncing & Rendering Operations
// ==========================================

function updateUI() {
    const symbol = state.currentStock;
    const stock = state.stocks[symbol];
    if (!stock || stock.price === 0) return;
    
    const isUp = stock.price >= stock.prevClose;
    const diff = stock.price - stock.prevClose;
    const diffPercent = (diff / stock.prevClose) * 100;
    
    const isKRW = symbol.endsWith('.KS');
    const currencySymbol = isKRW ? '₩' : '$';
    const decimalDigits = isKRW ? 0 : 2;
    
    const formatValue = (val) => {
        return val.toLocaleString(undefined, { minimumFractionDigits: decimalDigits, maximumFractionDigits: decimalDigits });
    };
    
    // 1. Stock Stats
    const priceEl = document.getElementById('current-stock-price');
    if (priceEl) priceEl.innerText = `${currencySymbol}${formatValue(stock.price)}`;
    
    const changeEl = document.getElementById('current-stock-change');
    if (changeEl) {
        changeEl.innerText = `${isUp ? '+' : ''}${currencySymbol}${formatValue(diff)} (${isUp ? '+' : ''}${diffPercent.toFixed(2)}%)`;
        changeEl.className = `price-change ${isUp ? 'positive' : 'negative'}`;
    }
    
    const highEl = document.getElementById('stock-high');
    if (highEl) highEl.innerText = `${currencySymbol}${formatValue(stock.high)}`;
    const lowEl = document.getElementById('stock-low');
    if (lowEl) lowEl.innerText = `${currencySymbol}${formatValue(stock.low)}`;
    const volEl = document.getElementById('stock-volume');
    if (volEl) volEl.innerText = stock.volume.toLocaleString();
    
    // 2. Limit/Market Price switches & Total Order Calculation
    const qtyInput = document.getElementById('order-quantity');
    const qty = qtyInput ? (parseInt(qtyInput.value) || 0) : 0;
    const activePriceRadio = document.querySelector('input[name="price-type"]:checked');
    const isLimit = activePriceRadio ? activePriceRadio.value === 'limit' : false;
    
    const priceInput = document.getElementById('order-price');
    const finalPrice = isLimit ? (priceInput ? (parseFloat(priceInput.value) || 0) : 0) : stock.price;
    const orderTotal = finalPrice * qty;
    
    const totalEl = document.getElementById('order-total-price');
    if (totalEl) totalEl.innerText = `${currencySymbol}${formatValue(orderTotal)}`;
    
    // 3. Exchange Rate Guide Row for US stocks
    const exchangeInfoEl = document.getElementById('order-exchange-info');
    if (exchangeInfoEl) {
        if (!isKRW) {
            exchangeInfoEl.style.display = 'flex';
            exchangeInfoEl.children[1].innerText = `₩${Math.round(orderTotal * 1400).toLocaleString()} (1$ = 1,400원)`;
        } else {
            exchangeInfoEl.style.display = 'none';
        }
    }
    
    // 4. Calculate Maximum orderable limits label
    const maxQtyLabel = document.getElementById('max-order-qty-label');
    const exchangeRate = isKRW ? 1 : 1400;
    
    if (maxQtyLabel) {
        if (state.orderType === 'buy') {
            const buyPriceKRW = finalPrice * exchangeRate;
            const maxBuyQty = buyPriceKRW > 0 ? Math.floor(state.balance / buyPriceKRW) : 0;
            maxQtyLabel.innerText = `최대 매수가능: ${maxBuyQty.toLocaleString()}주`;
        } else {
            const holdingsQty = state.holdings[symbol] ? state.holdings[symbol].quantity : 0;
            maxQtyLabel.innerText = `매도 가능: ${holdingsQty.toLocaleString()}주`;
        }
    }
    
    // 5. Global Asset Calculations
    let totalEvalHoldings = 0;
    let totalBuyHoldings = 0;
    let lockedOrdersValue = 0;
    
    const holdingKeys = Object.keys(state.holdings);
    holdingKeys.forEach(holdSym => {
        const hold = state.holdings[holdSym];
        const curStock = state.stocks[holdSym];
        const currentPrice = curStock && curStock.price > 0 ? curStock.price : hold.avgPrice;
        
        const rate = holdSym.endsWith('.KS') ? 1 : 1400;
        totalEvalHoldings += (currentPrice * hold.quantity) * rate;
        totalBuyHoldings += (hold.avgPrice * hold.quantity) * rate;
    });
    
    state.pendingOrders.forEach(order => {
        if (order.type === 'buy') {
            const rate = order.symbol.endsWith('.KS') ? 1 : 1400;
            lockedOrdersValue += (order.price * order.qty) * rate;
        }
    });
    
    const totalAssets = state.balance + totalEvalHoldings + lockedOrdersValue;
    const totalProfit = totalEvalHoldings - totalBuyHoldings;
    const totalProfitRate = totalBuyHoldings === 0 ? 0 : (totalProfit / totalBuyHoldings) * 100;
    
    const balEl = document.getElementById('user-balance');
    if (balEl) balEl.innerText = `₩${Math.round(state.balance).toLocaleString()}`;
    const assetEl = document.getElementById('user-total-asset');
    if (assetEl) assetEl.innerText = `₩${Math.round(totalAssets).toLocaleString()}`;
    
    const profitCardEl = document.getElementById('profit-card');
    const profitValEl = document.getElementById('user-total-profit');
    if (profitValEl) {
        profitValEl.innerText = `₩${Math.round(totalProfit).toLocaleString()} (${totalProfit >= 0 ? '+' : ''}${totalProfitRate.toFixed(2)}%)`;
    }
    
    if (profitCardEl) {
        if (totalProfit > 0) {
            profitCardEl.className = 'summary-card profit positive';
        } else if (totalProfit < 0) {
            profitCardEl.className = 'summary-card profit negative';
        } else {
            profitCardEl.className = 'summary-card profit neutral';
        }
    }
    
    // 6. Portfolio table rendering
    const portfolioTbody = document.getElementById('portfolio-tbody');
    if (portfolioTbody) {
        portfolioTbody.innerHTML = '';
        
        if (holdingKeys.length === 0) {
            portfolioTbody.innerHTML = `
                <tr class="empty-row">
                    <td colspan="5">보유 중인 주식이 없습니다.</td>
                </tr>`;
        } else {
            holdingKeys.forEach(holdSym => {
                const hold = state.holdings[holdSym];
                if (hold.quantity <= 0) return;
                
                const curStock = state.stocks[holdSym];
                const currentPrice = curStock && curStock.price > 0 ? curStock.price : hold.avgPrice;
                const evalPrice = currentPrice * hold.quantity;
                const buyPrice = hold.avgPrice * hold.quantity;
                
                const profit = evalPrice - buyPrice;
                const indivRate = hold.avgPrice === 0 ? 0 : ((currentPrice - hold.avgPrice) / hold.avgPrice) * 100;
                const isProfitUp = profit >= 0;
                
                const rate = holdSym.endsWith('.KS') ? 1 : 1400;
                const weight = totalAssets === 0 ? 0 : ((evalPrice * rate) / totalAssets) * 100;
                
                const isHoldKRW = holdSym.endsWith('.KS');
                const holdCurrency = isHoldKRW ? '₩' : '$';
                const holdDigits = isHoldKRW ? 0 : 2;
                const formatHoldVal = (v) => v.toLocaleString(undefined, { minimumFractionDigits: holdDigits, maximumFractionDigits: holdDigits });
                
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>${holdSym}</strong></td>
                    <td>${hold.quantity} 주</td>
                    <td>
                        ${holdCurrency}${formatHoldVal(evalPrice)} 
                        <span style="font-size:11px; color:var(--text-secondary); margin-left:4px;">(${weight.toFixed(1)}%)</span>
                    </td>
                    <td style="font-family: 'Outfit'; font-size:12px;">
                        ${holdCurrency}${formatHoldVal(hold.avgPrice)} / <span style="color:#fff;">${holdCurrency}${formatHoldVal(currentPrice)}</span>
                    </td>
                    <td class="${isProfitUp ? 'positive' : 'negative'}">
                        ${holdCurrency}${formatHoldVal(profit)} (${isProfitUp ? '+' : ''}${indivRate.toFixed(2)}%)
                    </td>
                `;
                portfolioTbody.appendChild(tr);
            });
        }
    }
}

// Set Order Type
function setOrderType(type) {
    state.orderType = type;
    const buyTab = document.getElementById('tab-buy');
    const sellTab = document.getElementById('tab-sell');
    const submitBtn = document.getElementById('submit-order-btn');
    
    if (type === 'buy') {
        if (buyTab) buyTab.classList.add('active');
        if (sellTab) sellTab.classList.remove('active');
        if (submitBtn) {
            submitBtn.className = 'btn btn-buy w-full';
            submitBtn.innerText = '매수 주문';
        }
    } else {
        if (sellTab) sellTab.classList.add('active');
        if (buyTab) buyTab.classList.remove('active');
        if (submitBtn) {
            submitBtn.className = 'btn btn-sell w-full';
            submitBtn.innerText = '매도 주문';
        }
    }
    updateUI();
}

function adjustQty(amount) {
    const qtyInput = document.getElementById('order-quantity');
    if (!qtyInput) return;
    let currentVal = parseInt(qtyInput.value) || 0;
    currentVal = Math.max(1, currentVal + amount);
    qtyInput.value = currentVal;
    updateUI();
}

// ==========================================
// 5. Order Submissions Execution
// ==========================================

async function handleOrderSubmit() {
    if (!state.currentUser) {
        alert('주문 전 먼저 로그인해 주세요.');
        return;
    }
    
    const symbol = state.currentStock;
    const stock = state.stocks[symbol];
    const qtyInput = document.getElementById('order-quantity');
    const qty = qtyInput ? (parseInt(qtyInput.value) || 0) : 0;
    const activePriceRadio = document.querySelector('input[name="price-type"]:checked');
    const isLimit = activePriceRadio ? activePriceRadio.value === 'limit' : false;
    const priceInput = document.getElementById('order-price');
    const limitPrice = priceInput ? (parseFloat(priceInput.value) || 0) : 0;
    
    const dealPrice = isLimit ? limitPrice : stock.price;
    const orderCost = dealPrice * qty;
    
    const exchangeRate = symbol.endsWith('.KS') ? 1 : 1400;
    const orderCostKRW = orderCost * exchangeRate;
    
    if (qty <= 0) {
        alert('주문 수량은 1주 이상이어야 합니다.');
        return;
    }
    
    if (isLimit && dealPrice <= 0) {
        alert('지정가를 올바르게 입력하세요.');
        return;
    }
    
    const timeString = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const isSymbolKRW = symbol.endsWith('.KS');
    const currency = isSymbolKRW ? '₩' : '$';
    const digits = isSymbolKRW ? 0 : 2;
    const formatPrice = (v) => v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    
    const newHoldings = JSON.parse(JSON.stringify(state.holdings));
    let newBalance = state.balance;
    
    if (isLimit) {
        const orderId = 'ord_' + Math.random().toString(36).substr(2, 9);
        
        if (state.orderType === 'buy') {
            if (state.balance < orderCostKRW) {
                alert('가용 예수금이 부족하여 대기 매수 주문을 걸 수 없습니다.');
                return;
            }
            newBalance -= orderCostKRW;
        } else {
            const hold = newHoldings[symbol];
            if (!hold || hold.quantity < qty) {
                alert('보유 주식이 부족하여 대기 매도 주문을 걸 수 없습니다.');
                return;
            }
            hold.quantity -= qty;
            if (hold.quantity === 0) {
                delete newHoldings[symbol];
            }
        }
        
        state.pendingOrders.push({
            id: orderId,
            symbol: symbol,
            type: state.orderType,
            price: dealPrice,
            qty: qty,
            time: timeString
        });
        
        state.balance = newBalance;
        state.holdings = newHoldings;
        
        // 대기 리스트 동기화
        syncPendingOrdersToHistory();
        await syncUserAssets();
        updateUI();
        
        alert(`${symbol} ${qty}주 ${state.orderType === 'buy' ? '매수' : '매도'} 지정가 대기 주문이 등록되었습니다.`);
        
    } else {
        if (state.orderType === 'buy') {
            if (state.balance < orderCostKRW) {
                alert('예수금이 부족합니다.');
                return;
            }
            
            newBalance -= orderCostKRW;
            
            if (!newHoldings[symbol]) {
                newHoldings[symbol] = { quantity: 0, avgPrice: 0 };
            }
            
            const hold = newHoldings[symbol];
            const newQty = hold.quantity + qty;
            const newAvg = ((hold.avgPrice * hold.quantity) + orderCost) / newQty;
            
            hold.quantity = newQty;
            hold.avgPrice = parseFloat(newAvg.toFixed(digits));
            
        } else {
            const hold = newHoldings[symbol];
            if (!hold || hold.quantity < qty) {
                alert('보유 주식이 부족하여 매도할 수 없습니다.');
                return;
            }
            
            newBalance += orderCostKRW;
            hold.quantity -= qty;
            
            if (hold.quantity === 0) {
                delete newHoldings[symbol];
            }
        }
        
        state.balance = newBalance;
        state.holdings = newHoldings;
        
        // 거래 기록 배열(history)에 먼저 추가 (체결 즉시 반영)
        state.history.unshift({
            id: 'mkt_' + Date.now(),
            time: timeString,
            symbol: symbol,
            type: state.orderType === 'buy' ? '매수' : '매도',
            price: `${currency}${formatPrice(dealPrice)}`,
            qty: qty,
            status: '체결'
        });
        
        // DB에 기록 내역까지 한 번에 일괄 동기화
        await syncUserAssets();
        
        updateHistoryTable();
        updateUI();
        
        alert(`${symbol} ${qty}주 시장가 주문이 체결되었습니다.`);
    }
}

function updateHistoryTable() {
    const historyTbody = document.getElementById('history-tbody');
    if (!historyTbody) return;
    historyTbody.innerHTML = '';
    
    if (state.history.length === 0) {
        historyTbody.innerHTML = `
            <tr class="empty-row">
                <td colspan="6">체결 내역이 없습니다.</td>
            </tr>`;
    } else {
        state.history.forEach(item => {
            const tr = document.createElement('tr');
            
            let statusBadge = '';
            if (item.status === '대기') {
                statusBadge = `<span class="badge pending">${item.status}</span> <button class="btn-cancel" onclick="cancelOrder('${item.id}')">취소</button>`;
            } else if (item.status === '취소') {
                statusBadge = `<span class="badge status-badge" style="background: rgba(255,255,255,0.04); color: var(--text-secondary); border: 1px solid rgba(255,255,255,0.08)">${item.status}</span>`;
            } else {
                statusBadge = `<span class="badge status-badge" style="background: rgba(0,255,135,0.06); color:#00ff87; border: 1px solid rgba(0,255,135,0.15)">${item.status}</span>`;
            }
            
            tr.innerHTML = `
                <td>${item.time}</td>
                <td><strong>${item.symbol}</strong></td>
                <td class="${item.type === '매수' ? 'positive' : 'negative'}">${item.type}</td>
                <td>${item.price}</td>
                <td>${item.qty}주</td>
                <td>${statusBadge}</td>
            `;
            historyTbody.appendChild(tr);
        });
    }
}

// ==========================================
// 6. App Event Listeners & Bootstrapping
// ==========================================

document.addEventListener('DOMContentLoaded', async () => {
    // 1. 이벤트 리스너 즉각 바인딩
    setupAuthEventListeners();
    
    try {
        // 2. 주식 목록 불러오기
        await fetchStockList();
        
        // 🚀 [핵심 수정 부분] 로그인을 안 한 상태여도 차트와 실시간 주가를 무조건 띄우도록 강제 실행!
        if (state.currentStock) {
            await loadChartHistory(state.currentStock, state.currentTimeframe); // 차트 즉시 그리기
            startRealtimePolling(); // 실시간 가격 4초마다 갱신 시작
        }
    } catch (err) {
        console.error('Initial data load failed:', err);
    }
    
    try {
        // 3. Firebase 초기화
        await initAuthentication();
    } catch (err) {
        console.error('Firebase init failed:', err);
        const loginErr = document.getElementById('login-error');
        const regErr = document.getElementById('register-error');
        const msg = `서버/Firebase 연동 실패: ${err.message}`;
        if (loginErr) loginErr.innerText = msg;
        if (regErr) regErr.innerText = msg;
    }
    
    // 4. UI 컨트롤 리스너 등록
    const stockSelector = document.getElementById('stock-selector');
    if (stockSelector) {
        stockSelector.addEventListener('change', async (e) => {
            state.currentStock = e.target.value;
            
            const activePriceRadio = document.querySelector('input[name="price-type"]:checked');
            const isLimit = activePriceRadio ? activePriceRadio.value === 'limit' : false;
            
            await loadChartHistory(state.currentStock, state.currentTimeframe);
            await updateRealtimeQuote(state.currentStock);
            
            if (isLimit) {
                const curStock = state.stocks[state.currentStock];
                if (curStock && curStock.price > 0) {
                    const priceInput = document.getElementById('order-price');
                    if (priceInput) priceInput.value = curStock.price;
                }
            }
            
            startRealtimePolling();
        });
    }
    
    // 4-1. 차트 타임프레임 버튼 리스너 바인딩
    const tfButtons = document.querySelectorAll('.timeframe-btn');
    tfButtons.forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const selectedTf = e.target.getAttribute('data-timeframe');
            if (!selectedTf) return;
            
            tfButtons.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            
            state.currentTimeframe = selectedTf;
            await loadChartHistory(state.currentStock, state.currentTimeframe);
        });
    });
    
    const qtyPlusBtn = document.getElementById('qty-plus');
    if (qtyPlusBtn) qtyPlusBtn.addEventListener('click', () => adjustQty(1));
    const qtyMinusBtn = document.getElementById('qty-minus');
    if (qtyMinusBtn) qtyMinusBtn.addEventListener('click', () => adjustQty(-1));
    
    const qtyInput = document.getElementById('order-quantity');
    if (qtyInput) {
        qtyInput.addEventListener('input', () => {
            if (parseInt(qtyInput.value) < 1 || isNaN(parseInt(qtyInput.value))) {
                qtyInput.value = 1;
            }
            updateUI();
        });
    }
    
    const radioButtons = document.querySelectorAll('input[name="price-type"]');
    radioButtons.forEach(radio => {
        radio.addEventListener('change', (e) => {
            const limitGroup = document.getElementById('limit-price-group');
            if (limitGroup) {
                if (e.target.value === 'limit') {
                    limitGroup.style.display = 'flex';
                    const curStock = state.stocks[state.currentStock];
                    if (curStock && curStock.price > 0) {
                        const priceInput = document.getElementById('order-price');
                        if (priceInput) priceInput.value = curStock.price;
                    }
                } else {
                    limitGroup.style.display = 'none';
                }
            }
            updateUI();
        });
    });
    
    const orderPriceInput = document.getElementById('order-price');
    if (orderPriceInput) orderPriceInput.addEventListener('input', updateUI);
    
    const tabBuy = document.getElementById('tab-buy');
    if (tabBuy) tabBuy.addEventListener('click', () => setOrderType('buy'));
    const tabSell = document.getElementById('tab-sell');
    if (tabSell) tabSell.addEventListener('click', () => setOrderType('sell'));
    
    const submitBtn = document.getElementById('submit-order-btn');
    if (submitBtn) submitBtn.addEventListener('click', handleOrderSubmit);
});
