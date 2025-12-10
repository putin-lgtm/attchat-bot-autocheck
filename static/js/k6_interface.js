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
    };
}

function initForm() {
    const form = $('k6-form');
    const output = $('k6-command');
    const result = $('k6-result');
    const runBtn = $('run-btn');
    if (!form || !output) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (runBtn) {
            runBtn.disabled = true;
            runBtn.classList.add('loading');
            runBtn.textContent = 'Đang chạy...';
        }
        if (result) result.textContent = 'Đang chạy k6...';
        output.value = '';

        try {
            const payload = buildPayload();
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
                result.innerHTML = `PID: <strong>${data.pid}</strong><br>Dashboard: <a href="${dash}" target="_blank">${dash}</a>`;
            }
            if (output) output.value = data.cmd || '';
        } catch (err) {
            if (result) result.textContent = `Lỗi: ${err.message}`;
        } finally {
            if (runBtn) {
                runBtn.disabled = false;
                runBtn.classList.remove('loading');
                runBtn.textContent = 'Bắt đầu test';
            }
        }
    });
}

document.addEventListener('DOMContentLoaded', initForm);
