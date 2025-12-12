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
const wsUrlBase = __ENV.WS_URL || 'ws://localhost:8086/ws';
const username = __ENV.USERNAME || 'admin';
const password = __ENV.PASSWORD || 'admin123';
const providedToken = __ENV.TOKEN; // If set, skip login.
const wsLingerMs = parseDurationMs(__ENV.MAX_DURATION || __ENV.WS_LINGER_MS || '0'); // keep WS open equal to MAX_DURATION by default
const wsHardTimeoutMs = parseDurationMs(__ENV.WS_HARD_TIMEOUT_MS || '5000'); // force-close guard
const brandIds = Array.from({ length: 10 }, (_, i) => `${i + 1}`);
const streamTypes = (__ENV.STREAM_TYPES || 'CHAT')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map((s) => s.toUpperCase());
const userIds = Array.from({ length: chatCount }, (_, i) => `${i + 1}`);

// Metrics
const apiLatency = new Trend('api_latency_ms');
const wsConnectLatency = new Trend('ws_connect_latency_ms');
const wsEndToEndLatency = new Trend('ws_end_to_end_latency_ms');
const apiErrors = new Counter('api_errors');
const wsErrors = new Counter('ws_errors');
const wsClosed = new Counter('ws_closed');
const wsReceiveErrors = new Counter('ws_receive_errors');

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
  const wsRoundTrip = doWsRoundTrip(token);
  const apiRun = doApiBurst(requests);
  console.log(`VU ${__VU} WS starting with streamTypes=${streamTypes.join(',')}`);
  wsRun();
  wsRoundTrip();
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

// WS round-trip: subscriber then publisher send, expect to receive broadcast and measure latency
function doWsRoundTrip(token) {
  return () => {
    const userId = userIds[(__VU - 1) % userIds.length];
    const brandId = brandIds[Math.floor(Math.random() * brandIds.length)];
    const streamType = streamTypes[Math.floor(Math.random() * streamTypes.length)];
    const roomId = `room_user_${userId}`;
    const tokenShort = token ? `${String(token).slice(0, 12)}...` : '';

    let recvAt = null;
    let sendAt = null;
    let subscriberClosed = false;

    const subUrl = appendWsParams(wsUrlBase, token, {
      brand_id: brandId,
      type: streamType,
      user_id: `sub_${userId}`,
      room_id: roomId,
    });
    const pubUrl = appendWsParams(wsUrlBase, token, {
      brand_id: brandId,
      type: streamType,
      user_id: `pub_${userId}`,
      room_id: roomId,
    });

    const subRes = ws.connect(subUrl, {}, (socket) => {
      let subInterval = null;
      socket.on('open', () => {
        // CSKH side: send heartbeat every 1s
        subInterval = socket.setInterval(() => {
          socket.send(
            JSON.stringify({
              type: 'cskh_heartbeat',
              text: 'cskh hello',
              room: roomId,
              payload: { ts: new Date().toISOString(), role: 'cskh' },
            }),
          );
        }, 1000);
      });
      socket.on('message', (msg) => {
        recvAt = Date.now();
        subscriberClosed = true;
        if (subInterval) socket.clearInterval(subInterval);
        socket.close();
      });
      socket.on('error', () => {
        if (!subscriberClosed) {
          wsReceiveErrors.add(1);
          subscriberClosed = true;
          if (subInterval) socket.clearInterval(subInterval);
          socket.close();
        }
      });
      socket.setTimeout(() => {
        if (!subscriberClosed) {
          wsReceiveErrors.add(1);
          subscriberClosed = true;
          if (subInterval) socket.clearInterval(subInterval);
          socket.close();
          console.log('WS subscriber hard-timeout close', subUrl);
        }
      }, wsHardTimeoutMs || parseDurationMs(__ENV.MAX_DURATION || '5000'));
    });
    const subOk = check(subRes, { 'sub ws status 101': (r) => r && r.status === 101 });
    if (!subOk) {
      wsErrors.add(1);
      console.log('Subscriber WS upgrade failed', subUrl, subRes && subRes.error || subRes);
      return;
    }

    const pubRes = ws.connect(pubUrl, {}, (socket) => {
      let pubInterval = null;
      socket.on('open', () => {
        const payload = {
          type: 'chat_message',
          room: roomId,
          payload: {
            text: 'k6 roundtrip',
            ts: new Date().toISOString(),
            brand_id: brandId,
            user_id: userId,
          },
        };
        sendAt = Date.now();
        socket.send(JSON.stringify(payload));
        // User side: send message every 1s
        pubInterval = socket.setInterval(() => {
          socket.send(
            JSON.stringify({
              type: 'chat_message',
              room: roomId,
              payload: {
                text: 'user hello',
                ts: new Date().toISOString(),
                brand_id: brandId,
                user_id: userId,
              },
            }),
          );
        }, 1000);
        if (wsLingerMs > 0) {
          socket.setTimeout(() => {
            if (pubInterval) socket.clearInterval(pubInterval);
            socket.close();
          }, wsLingerMs);
        } else {
          if (pubInterval) socket.clearInterval(pubInterval);
          socket.close();
        }
      });
      socket.on('error', () => {
        wsErrors.add(1);
        if (pubInterval) socket.clearInterval(pubInterval);
        socket.close();
      });
      socket.setTimeout(() => {
        if (pubInterval) socket.clearInterval(pubInterval);
        socket.close();
      }, wsHardTimeoutMs || parseDurationMs(__ENV.MAX_DURATION || '5000'));
    });
    const pubOk = check(pubRes, { 'pub ws status 101': (r) => r && r.status === 101 });
    wsConnectLatency.add(wsHardTimeoutMs ? wsHardTimeoutMs : 0); // approximate since we open two sockets
    if (!pubOk) {
      wsErrors.add(1);
      console.log('Publisher WS upgrade failed', pubUrl, pubRes && pubRes.error || pubRes);
    }

    // allow some time for delivery
    sleep((wsLingerMs || 500) / 1000);
    if (recvAt && sendAt) {
      wsEndToEndLatency.add(recvAt - sendAt);
      wsClosed.add(1);
    } else {
      wsReceiveErrors.add(1);
      console.log(`No message received for room=${roomId} brand=${brandId} type=${streamType} token=${tokenShort}`);
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
