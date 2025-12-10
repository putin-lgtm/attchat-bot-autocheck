const summaryEl = () => document.getElementById('summary-content');
const chatGridEl = () => document.getElementById('chat-grid');
const apiResultsEl = () => document.getElementById('api-results');
const startBtn = () => document.getElementById('start-btn');
const tokenDisplayEl = () => document.getElementById('token-display');

let authToken = '';
let stopRequested = false;

function tail(arr, n) {
    if (!Array.isArray(arr)) return [];
    return arr.slice(Math.max(arr.length - n, 0));
}
function resetDashboard() {
    chatGridEl().innerHTML = '';
    apiResultsEl().innerHTML = '';
    if (summaryEl()) summaryEl().textContent = 'Chưa chạy.';
    const btn = startBtn();
    if (btn) {
        btn.disabled = true;
        btn.classList.add('disabled');
    }
    stopRequested = true;
}

function renderChatWindows(count) {
    const grid = chatGridEl();
    grid.innerHTML = '';
    const start = Math.max(1, count - 9); // tail last 10
    for (let i = start; i <= count; i++) {
        const card = document.createElement('div');
        card.className = 'chat-card';
        card.innerHTML = `
            <div class="chat-card__header">
                <span>Chat #${i}</span>
                <span class="badge">pending</span>
            </div>
            <div class="chat-card__body">
                <div class="bubble bubble--in">Init payload</div>
            </div>
        `;
        grid.appendChild(card);
    }
}

function updateChatStatuses(statusText, type = 'ok') {
    chatGridEl().querySelectorAll('.badge').forEach((b) => {
        b.textContent = statusText;
        b.className = `badge badge--${type}`;
    });
}

function renderResultSection(title, results) {
    const wrapper = document.createElement('div');
    wrapper.className = 'result-section';

    const heading = document.createElement('h4');
    const total = results.length;
    const limited = tail(results, 10);
    heading.textContent = total > 10 ? `${title} (last 10 of ${total})` : title;
    wrapper.appendChild(heading);

    const offset = total - limited.length;
    limited.forEach((r, idx) => {
        const absoluteIdx = offset + idx + 1; // 1-based index in full list
        const row = document.createElement('div');
        row.className = `api-row ${r.ok ? 'ok' : 'fail'}`;
        row.innerHTML = `
            <div class="api-row__left">
                <strong>#${absoluteIdx}</strong> | ${r.status || 'ERR'} | ${r.ms.toFixed(1)} ms
            </div>
            <div class="api-row__right">
                ${r.ok ? '✅' : '❌'} ${r.message || ''}
            </div>
        `;
        wrapper.appendChild(row);
    });
    return wrapper;
}

function renderApiAndWsResults(apiResults, wsResults) {
    const container = apiResultsEl();
    container.innerHTML = '';
    container.appendChild(renderResultSection('HTTP API burst', apiResults));
    container.appendChild(renderResultSection('WebSocket burst', wsResults));
}

function renderSummary(stats) {
    summaryEl().innerHTML = `
        <table class="summary-table">
            <tbody>
                <tr>
                    <td>Chat windows</td>
                    <td><strong>${stats.chatCount}</strong></td>
                </tr>
                <tr>
                    <td>API calls</td>
                    <td><strong>${stats.apiCount}</strong></td>
                </tr>
                <tr>
                    <td>Thành công / Thất bại</td>
                    <td><strong>${stats.success}</strong> / <strong>${stats.fail}</strong></td>
                </tr>
                <tr>
                    <td>API latency (ms)</td>
                    <td>min <strong>${stats.min.toFixed(1)} ms</strong> / avg <strong>${stats.avg.toFixed(1)} ms</strong> / max <strong>${stats.max.toFixed(1)} ms</strong></td>
                </tr>
                <tr>
                    <td>WS thành công / thất bại</td>
                    <td><strong>${stats.wsSuccess}</strong> / <strong>${stats.wsFail}</strong></td>
                </tr>
                <tr>
                    <td>WS latency (ms)</td>
                    <td>min <strong>${stats.wsMin.toFixed(1)} ms</strong> / avg <strong>${stats.wsAvg.toFixed(1)} ms</strong> / max <strong>${stats.wsMax.toFixed(1)} ms</strong></td>
                </tr>
                <tr>
                    <td>Total latency (s)</td>
                    <td><strong>${(stats.totalSecs || 0).toFixed(2)} s</strong></td>
                </tr>
            </tbody>
        </table>
    `;
}

async function runApiBurst(endpoint, amount, token, method = 'GET') {
    const tasks = [];
    for (let i = 0; i < amount; i++) {
        tasks.push((async () => {
            const started = performance.now();
            try {
                if (stopRequested) throw new Error('stopped');
                const headers = token ? { Authorization: `Bearer ${token}` } : {};
                const options = { method, headers };
                if (method === 'POST') {
                    headers['Content-Type'] = 'application/json';
                    options.body = JSON.stringify({});
                }
                const resp = await fetch(endpoint, options);
                const ms = performance.now() - started;
                return { ok: resp.ok, status: resp.status, ms, message: resp.statusText || 'OK' };
            } catch (err) {
                const ms = performance.now() - started;
                return { ok: false, status: 0, ms, message: err.message };
            }
        })());
    }
    return Promise.all(tasks);
}

function appendTokenToWs(endpoint, token) {
    if (!token) return endpoint;
    try {
        const url = new URL(endpoint);
        url.searchParams.set('token', token);
        return url.toString();
    } catch {
        return endpoint + (endpoint.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
    }
}

async function runWsBurst(endpoint, amount, token) {
    const tasks = [];
    for (let i = 0; i < amount; i++) {
        tasks.push(new Promise((resolve) => {
            const wsUrl = appendTokenToWs(endpoint, token);
            const started = performance.now();
            try {
                if (stopRequested) throw new Error('stopped');
                const ws = new WebSocket(wsUrl);
                const timeout = setTimeout(() => {
                    try { ws.close(); } catch {}
                    resolve({ ok: false, status: 'timeout', ms: performance.now() - started, message: 'timeout' });
                }, 8000);

                ws.onopen = () => {
                    const ms = performance.now() - started;
                    clearTimeout(timeout);
                    try { ws.close(); } catch {}
                    resolve({ ok: true, status: 'open', ms, message: 'opened' });
                };
                ws.onerror = (err) => {
                    clearTimeout(timeout);
                    resolve({ ok: false, status: 'error', ms: performance.now() - started, message: err?.message || 'ws error' });
                };
            } catch (e) {
                resolve({ ok: false, status: 'error', ms: performance.now() - started, message: e.message });
            }
        }));
    }
    return Promise.all(tasks);
}

async function runChatSession(wsEndpoint, apiEndpoint, apiCount, token, apiMethod) {
    const wsPromise = runWsBurst(wsEndpoint, 1, token).then((arr) => arr[0] || null);
    const apiPromise = runApiBurst(apiEndpoint, apiCount, token, apiMethod);
    const [wsResult, apiResults] = await Promise.all([wsPromise, apiPromise]);
    return { wsResult, apiResults };
}

function computeStats(apiResults) {
    if (!apiResults.length) {
        return { success: 0, fail: 0, min: 0, max: 0, avg: 0 };
    }
    let min = Infinity, max = 0, sum = 0, success = 0;
    apiResults.forEach(r => {
        min = Math.min(min, r.ms);
        max = Math.max(max, r.ms);
        sum += r.ms;
        if (r.ok) success += 1;
    });
    return {
        success,
        fail: apiResults.length - success,
        min,
        max,
        avg: sum / apiResults.length
    };
}

async function startLoadTest() {
    stopRequested = false;
    if (!authToken) {
        alert('Vui lòng lấy token trước khi chạy test.');
        return;
    }
    const chatCount = Math.max(1, Number(document.getElementById('chat-count').value) || 0);
    const apiCount = Math.max(1, Number(document.getElementById('api-count').value) || 0);
    const apiEndpoint = (document.getElementById('api-endpoint').value || '').trim() || '/api/data';
    const apiMethod = (document.getElementById('api-method').value || 'GET').toUpperCase();
    const wsEndpoint = (document.getElementById('ws-endpoint').value || '').trim() || 'wss://echo.websocket.events/';
    const totalApiPlanned = chatCount * apiCount;
    const startedAt = performance.now();

    // Render chat windows immediately
    renderChatWindows(chatCount);
    updateChatStatuses('running', 'warn');

    // Disable button during run
    startBtn().disabled = true;
    startBtn().classList.add('loading');
    startBtn().textContent = 'Đang chạy...';

    try {
        // Per-chat: mỗi chat mở WS và tự bắn apiCount API
        const chatTasks = [];
        for (let i = 0; i < chatCount; i++) {
            chatTasks.push(runChatSession(wsEndpoint, apiEndpoint, apiCount, authToken, apiMethod));
        }
        const chatResults = await Promise.all(chatTasks);

        const allApiResults = [];
        const allWsResults = [];
        chatResults.forEach(({ wsResult, apiResults }) => {
            if (wsResult) allWsResults.push(wsResult);
            if (Array.isArray(apiResults)) allApiResults.push(...apiResults);
        });

        renderApiAndWsResults(allApiResults, allWsResults);
        const stats = computeStats(allApiResults);
        const wsStats = computeStats(allWsResults);
        const totalSecs = (performance.now() - startedAt) / 1000;
        renderSummary({
            ...stats,
            chatCount,
            apiCount: allApiResults.length, // tổng API thực sự đã bắn
            totalSecs,
            wsSuccess: wsStats.success,
            wsFail: wsStats.fail,
            wsMin: wsStats.min,
            wsMax: wsStats.max,
            wsAvg: wsStats.avg
        });

        updateChatStatuses('done', 'ok');
    } catch (err) {
        console.error(err);
        const totalSecs = (performance.now() - startedAt) / 1000;
        renderSummary({
            chatCount,
            apiCount: totalApiPlanned,
            success: 0,
            fail: totalApiPlanned,
            min: 0,
            max: 0,
            avg: 0,
            totalSecs,
            wsSuccess: 0,
            wsFail: 0,
            wsMin: 0,
            wsMax: 0,
            wsAvg: 0
        });
        updateChatStatuses('error', 'fail');
    } finally {
        startBtn().disabled = false;
        startBtn().classList.remove('loading');
        startBtn().textContent = '🚀 Bắt đầu test';
    }
}

function setTokenDisplay(text, isError = false) {
    if (!tokenDisplayEl()) return;
    tokenDisplayEl().textContent = text;
    tokenDisplayEl().className = `token-display ${isError ? 'error' : 'ok'}`;
    const btn = startBtn();
    if (btn) {
        const enabled = !isError && !!authToken;
        btn.disabled = !enabled;
        btn.classList.toggle('disabled', !enabled);
    }
}

async function getToken() {
    const endpoint = (document.getElementById('login-endpoint').value || '').trim();
    const username = (document.getElementById('login-username').value || '').trim();
    const password = document.getElementById('login-password').value || '';

    if (!endpoint || !username || !password) {
        setTokenDisplay('Thiếu endpoint / username / password', true);
        return;
    }

    const btn = document.getElementById('login-btn');
    btn.disabled = true;
    btn.classList.add('loading');
    btn.textContent = 'Đang lấy token...';

    try {
        const resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await resp.json().catch(() => ({}));
        // cố gắng bắt nhiều key phổ biến
        const token =
            data.token ||
            data.access_token ||
            data.accessToken ||
            data.id_token ||
            (data.data && (data.data.token || data.data.accessToken || data.data.access_token)) ||
            '';

        if (!resp.ok || !token) {
            setTokenDisplay(`Lấy token thất bại: ${data.message || resp.statusText || 'Unknown'}`, true);
            authToken = '';
            return;
        }

        authToken = token;
        setTokenDisplay(`${token}`);
    } catch (err) {
        setTokenDisplay(`Lỗi: ${err.message}`, true);
        authToken = '';
    } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
        btn.textContent = 'Get Token';
    }
}
