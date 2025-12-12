import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

// Config (override via env): CHAT_COUNT, API_PER_CHAT, LOGIN_URL, API_URL, WS_URL, USERNAME, PASSWORD, TOKEN, MAX_DURATION.
const chatCount = Number(__ENV.CHAT_COUNT || 10);
const apiPerChat = Number(__ENV.API_PER_CHAT || 3);
const loginUrl = __ENV.LOGIN_URL || 'http://localhost:8083/api/auth/login';
const apiUrl = __ENV.API_URL || 'http://localhost:8083/api/data-botting';
const publishUrl = __ENV.PUBLISH_URL || 'http://localhost:8083/api/publish-chat-event';
const username = __ENV.USERNAME || 'admin';
const password = __ENV.PASSWORD || 'admin123';
const providedToken = __ENV.TOKEN; // If set, skip login.
const wsLingerMs = parseDurationMs(__ENV.MAX_DURATION || __ENV.WS_LINGER_MS || '0'); // keep WS open equal to MAX_DURATION by default
const wsHardTimeoutMs = parseDurationMs(__ENV.WS_HARD_TIMEOUT_MS || '5000'); // force-close guard
const brandIds = Array.from({ length: 10 }, (_, i) => `${i + 1}`);
const streamTypes = [
  'ANALYTICS',
  'AUDIT',
  'BILLING',
  'CHAT',
  'EMAIL',
  'FILE',
  'NOTIFY',
  'ONLINE',
];
const userIds = Array.from({ length: chatCount }, (_, i) => `${i + 1}`);

// Metrics
const apiLatency = new Trend('api_latency_ms');
const wsConnectLatency = new Trend('ws_connect_latency_ms');
const apiErrors = new Counter('api_errors');
const wsErrors = new Counter('ws_errors');
const wsClosed = new Counter('ws_closed');

export const options = {
  scenarios: {
    chat_burst: {
      executor: 'per-vu-iterations',
      vus: chatCount,
      iterations: 1,
      maxDuration: __ENV.MAX_DURATION || '2m',
    },
  },
  thresholds: {
    api_errors: ['count==0'],
    ws_errors: ['count==0'],
  },
};

export function setup() {
  if (providedToken) {
    return { token: providedToken };
  }
  const res = http.post(
    loginUrl,
    JSON.stringify({ username, password }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(res, { 'login ok': (r) => r.status >= 200 && r.status < 300 });
  const token =
    res.json('access_token') ||
    res.json('accessToken') ||
    res.json('token') ||
    res.json('data.token') ||
    res.json('data.access_token') ||
    res.json('data.accessToken') ||
    '';
  if (!token) {
    throw new Error('Login succeeded but no token found in response');
  }
  return { token };
}

export default function (data) {
  const token = data.token;

  // Build batch of API calls for this chat
  const requests = [];
  for (let i = 0; i < apiPerChat; i++) {
    requests.push([
      'GET',
      apiUrl,
      null,
      { headers: { Authorization: `Bearer ${token}` } },
    ]);
  }

  // Run WS and API concurrently within the same VU
  const wsRun = doWsBurst(token);
  const apiRun = doApiBurst(requests);
  wsRun();
  apiRun();
}

function doWsBurst(token) {
  return () => {
    const started = Date.now();
    const userId = userIds[(__VU - 1) % userIds.length];
    const brandId = brandIds[Math.floor(Math.random() * brandIds.length)];
    const streamType = streamTypes[Math.floor(Math.random() * streamTypes.length)];
    const tokenShort = token ? `${String(token).slice(0, 12)}...` : '';
    const payload = {
      event: 'load_test_connect',
      type: streamType,
      brand_id: brandId,
      user_id: userId,
      room_id: `room_user_${userId}`,
      message: 'k6 load test publish',
      timestamp: new Date().toISOString(),
      token, // for WS connect on gateway-api side
    };
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
    const res = http.post(publishUrl, JSON.stringify(payload), { headers, timeout: wsHardTimeoutMs ? `${wsHardTimeoutMs}ms` : '5s' });
    const ok = check(res, { 'publish status 2xx': (r) => r && r.status >= 200 && r.status < 300 });
    wsConnectLatency.add(Date.now() - started);
    if (!ok) {
      wsErrors.add(1);
      console.log('publish failed', publishUrl, res && res.status, res && res.body);
    } else {
      wsClosed.add(1); // treat as completed request
      if (wsLingerMs > 0) {
        sleep(wsLingerMs / 1000);
      }
    }
  };
}

function doApiBurst(requests) {
  return () => {
    console.log(`VU ${__VU} API opened ${requests.length} calls`);
    const responses = http.batch(requests);
    responses.forEach((r) => {
      apiLatency.add(r.timings.duration);
      if (!(r.status >= 200 && r.status < 300)) {
        apiErrors.add(1);
      }
    });
  };
}

function appendToken(url, token) {
  if (!token) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('token', token);
    return u.toString();
  } catch (_) {
    return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  }
}

function appendWsParams(url, token, extraParams = {}) {
  let full = url;
  const pairs = [];
  if (token) pairs.push(['token', token]);
  Object.entries(extraParams || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null) {
      pairs.push([k, v]);
    }
  });
  if (pairs.length === 0) return full;
  const qs = pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  full += url.includes('?') ? '&' : '?';
  full += qs;
  return full;
}

export function handleSummary(data) {
  // Write summary into configured path (default: static/summary.json).
  const path = __ENV.SUMMARY_PATH || 'static/summary.json';
  return { [path]: JSON.stringify(data, null, 2) };
}

function parseDurationMs(v) {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  const s = v.toString().trim();
  if (!s) return 0;
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  const n = parseFloat(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  const factor = unit === 'ms' ? 1 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 1_000;
  return n * factor;
}
