function $(id) {
    return document.getElementById(id);
}

function buildPayload() {
    return {
        chat_count: $('chat_count').value || '10',
        api_per_chat: $('api_per_chat').value || '3',
        max_duration: $('max_duration').value || '2m',
        login_url: $('login_url').value || '',
        api_url: $('api_url').value || '',
        ws_url: $('ws_url').value || '',
        username: $('username').value || '',
        password: $('password').value || '',
        out_mode: $('out_mode').value || 'web-dashboard',
        linger: false,
    };
}

function initForm() {
    const form = $('k6-form');
    const output = $('k6-command');
    const result = $('k6-result');
    const runBtn = $('run-btn');
    const dashBtn = $('dash-btn');
    const summaryBox = $('k6-summary');
    if (!form || !output) return;

    let pollTimer = null;
    let waitTimer = null;
    let waitTick = 0;

    const setWaiting = () => {
        if (!summaryBox) return;
        const base = 'Đang chờ kết quả nhanh';
        const dots = '.'.repeat((waitTick % 10) + 1); // 1..10 dots then loop
        summaryBox.innerHTML = `${base}${dots}`;
        waitTick = (waitTick + 1) % 10;
    };

    const startWaiting = () => {
        stopWaiting();
        waitTick = 0;
        setWaiting();
        waitTimer = setInterval(setWaiting, 500);
    };

    const stopWaiting = () => {
        if (waitTimer) {
            clearInterval(waitTimer);
            waitTimer = null;
        }
    };
    const stopPolling = () => {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    };

    const renderSummary = (data, payload, lingerMode) => {
        if (!summaryBox || !data) return;
        if (data.status === 'waiting' || !data.metrics) {
            // Với chế độ dashboard (linger), không đè bảng cũ khi chưa có metrics mới
            if (!lingerMode) {
                startWaiting();
            }
            return;
        }
        stopWaiting();
        const metricValues = (name) => data.metrics?.[name]?.values || {};
        const fmt = (v) => (typeof v === 'number' ? v.toFixed(1) : '0');
        const fmtUnit = (v, unit) => `${fmt(v)} ${unit}`;
        const fmtMsToSec = (v) => (typeof v === 'number' ? (v / 1000).toFixed(1) : '0');

        const chatCount = Number(payload.chat_count || 0);
        const apiPerChat = Number(payload.api_per_chat || 0);
        const totalApi = chatCount * apiPerChat;

        const apiErr = metricValues('api_errors').count || 0;
        const apiLat = metricValues('api_latency_ms');
        const wsErr = metricValues('ws_errors').count || 0;
        const wsLat = metricValues('ws_connect_latency_ms');
        const wsSuccess = Math.max(chatCount - wsErr, 0);
        const iterDur = metricValues('iteration_duration');
        const totalMs = data?.state?.testRunDurationMs
            ?? iterDur.max
            ?? iterDur.avg
            ?? 0;
        const totalSecs = fmtMsToSec(totalMs);

        summaryBox.innerHTML = `
            <table class="summary-table">
                <tbody>
                    <tr><td>Chat windows</td><td><strong>${chatCount}</strong></td></tr>
                    <tr><td>API calls</td><td><strong>${totalApi}</strong></td></tr>
                    <tr><td>Thành công / Thất bại</td><td><strong>${totalApi - apiErr}</strong> / <strong>${apiErr}</strong></td></tr>
                    <tr><td>API latency (ms)</td><td>min <strong>${fmtUnit(apiLat.min, 'ms')}</strong> / avg <strong>${fmtUnit(apiLat.avg, 'ms')}</strong> / max <strong>${fmtUnit(apiLat.max, 'ms')}</strong></td></tr>
                    <tr><td>WS thành công / thất bại</td><td><strong>${wsSuccess}</strong> / <strong>${wsErr}</strong></td></tr>
                    <tr><td>WS latency (ms)</td><td>min <strong>${fmtUnit(wsLat.min, 'ms')}</strong> / avg <strong>${fmtUnit(wsLat.avg, 'ms')}</strong> / max <strong>${fmtUnit(wsLat.max, 'ms')}</strong></td></tr>
                    <tr><td>Total latency (s)</td><td><strong>${totalSecs} s</strong></td></tr>
                </tbody>
            </table>
        `;
    };

    const startPolling = (payload, lingerMode) => {
        stopPolling();
        pollTimer = setInterval(async () => {
            try {
                const res = await fetch(`/static/summary.json?ts=${Date.now()}`);
                if (!res.ok) return;
                const data = await res.json();
                renderSummary(data, payload, lingerMode);
                // Stop polling once we have real metrics (not waiting)
                if (data && data.metrics) {
                    stopPolling();
                }
            } catch (e) {
                // ignore transient errors
            }
        }, 3000);
    };

    const runTest = async (lingerMode = false) => {
        if (runBtn) {
            runBtn.disabled = true;
            runBtn.classList.add('loading');
            runBtn.textContent = 'Đang chạy...';
        }
        if (dashBtn) dashBtn.disabled = true;
        if (result) result.textContent = 'Đang chạy k6...';
        output.value = '';
        stopPolling();
        // Với chế độ dashboard (linger), giữ nguyên bảng Kết quả nhanh đang hiển thị
        if (summaryBox && !lingerMode) {
            startWaiting();
        }

        try {
            const payload = buildPayload();
            payload.linger = lingerMode;
            const res = await fetch('/api/run-k6', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data?.detail || res.statusText);
            }
            const dash = data.dashboard || 'http://127.0.0.1:5665';
            if (result) {
                const note = data.note ? `<br>${data.note}` : '';
                result.innerHTML = `PID: <strong>${data.pid}</strong><br>Dashboard: <a href="${dash}" target="_blank">${dash}</a>${note}`;
            }
            if (output) output.value = data.cmd || '';
            startPolling(payload, lingerMode);
        } catch (err) {
            if (result) result.textContent = `Lỗi: ${err.message}`;
        } finally {
            if (runBtn) {
                runBtn.disabled = false;
                runBtn.classList.remove('loading');
                runBtn.textContent = 'Test nhanh';
            }
            if (dashBtn) dashBtn.disabled = false;
        }
    };

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        runTest(false); // Test nhanh (không linger)
    });

    if (dashBtn) {
        dashBtn.addEventListener('click', (e) => {
            e.preventDefault();
            runTest(true); // Report to Dashboard (linger)
        });
    }
}

document.addEventListener('DOMContentLoaded', initForm);
