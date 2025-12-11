import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

// Config (override via env): CHAT_COUNT, API_PER_CHAT, LOGIN_URL, API_URL, WS_URL, USERNAME, PASSWORD, TOKEN, MAX_DURATION.
const chatCount = Number(__ENV.CHAT_COUNT || 10);
const apiPerChat = Number(__ENV.API_PER_CHAT || 3);
const loginUrl = __ENV.LOGIN_URL || 'http://localhost:8083/api/auth/login';
const apiUrl = __ENV.API_URL || 'http://localhost:8083/api/data-botting';
const wsUrlBase = __ENV.WS_URL || 'ws://localhost:8086/ws';
const username = __ENV.USERNAME || 'admin';
const password = __ENV.PASSWORD || 'admin123';
const providedToken = __ENV.TOKEN; // If set, skip login.
const wsLingerMs = parseDurationMs(__ENV.WS_LINGER_MS || __ENV.MAX_DURATION || '0'); // keep WS open; default to MAX_DURATION if set
const wsHardTimeoutMs = parseDurationMs(__ENV.WS_HARD_TIMEOUT_MS || '5000'); // force-close guard

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

  // Run WS connect and API burst in parallel (best-effort)
  const wsPromise = connectWs(token);
  const apiPromise = doApiBurst(requests);

  // Wait both
  wsPromise();
  apiPromise();

  sleep(1); // small think-time to let k6 pacing
}

function connectWs(token) {
  return () => {
    const started = Date.now();
    const url = appendToken(wsUrlBase, token);
    const guardMs = wsHardTimeoutMs || 0;
    console.log('WS opened', url);
    const res = ws.connect(url, {}, (socket) => {
      let closed = false;

      socket.on('open', () => {
        wsConnectLatency.add(Date.now() - started);
        if (wsLingerMs > 0) {
          socket.setTimeout(() => {
            if (!closed) {
              socket.close();
              closed = true;
              wsClosed.add(1);
            }
          }, wsLingerMs);
        } else {
          socket.close();
          closed = true;
          wsClosed.add(1);
        }
      });
      socket.on('error', () => {
        wsErrors.add(1);
        if (!closed) {
          socket.close();
          closed = true;
          wsClosed.add(1);
        }
        console.log('WS error on connect', url);
      });
      socket.on('close', () => {
        if (!closed) {
          wsClosed.add(1);
          closed = true;
        }
        console.log('WS closed', url);
      });

      // Hard guard to ensure closure even if events fail
      socket.setTimeout(() => {
        if (!closed) {
          socket.close();
          closed = true;
          wsClosed.add(1);
          console.log('WS hard-timeout close', url);
        }
      }, guardMs);
    });
    const ok = check(res, { 'ws status 101': (r) => r && r.status === 101 });
    if (!ok) {
      wsErrors.add(1);
      console.log('WS upgrade failed', url, res && res.error || res);
    }
  };
}

function doApiBurst(requests) {
  return () => {
    console.log('API opened', requests.length, 'calls');
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
