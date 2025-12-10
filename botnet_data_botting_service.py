import asyncio
import time
from typing import Dict, List, Optional

import httpx
import websockets


class DataBottingService:
    """
    Simple load-test helper to exercise HTTP and WebSocket endpoints in parallel.
    This is intentionally lightweight (no persistence) and returns per-call timings.
    """

    def __init__(self):
        self._http_timeout = httpx.Timeout(10.0, connect=5.0)
        self._http_limits = httpx.Limits(max_connections=200, max_keepalive_connections=50)

    async def _http_call(self, client: httpx.AsyncClient, endpoint: str, method: str, token: str, payload: Optional[Dict]):
        started = time.perf_counter()
        try:
            headers = {}
            if token:
                headers["Authorization"] = f"Bearer {token}"

            req_kwargs = {"headers": headers}
            if method == "POST":
                req_kwargs["json"] = payload or {}

            resp = await client.request(method, endpoint, **req_kwargs)
            elapsed = (time.perf_counter() - started) * 1000
            return {
                "ok": resp.is_success,
                "status": resp.status_code,
                "ms": elapsed,
                "message": resp.reason_phrase or "OK",
            }
        except Exception as exc:
            elapsed = (time.perf_counter() - started) * 1000
            return {"ok": False, "status": 0, "ms": elapsed, "message": str(exc)}

    async def run_http_burst(
        self,
        endpoint: str,
        method: str,
        count: int,
        token: str = "",
        payload: Optional[Dict] = None,
    ) -> List[Dict]:
        method = method.upper()
        async with httpx.AsyncClient(timeout=self._http_timeout, limits=self._http_limits, follow_redirects=True) as client:
            tasks = [self._http_call(client, endpoint, method, token, payload) for _ in range(count)]
            return await asyncio.gather(*tasks)

    def _append_token_to_ws(self, endpoint: str, token: str) -> str:
        if not token:
            return endpoint
        try:
            from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse
            parsed = urlparse(endpoint)
            query = dict(parse_qsl(parsed.query))
            query["token"] = token
            new_query = urlencode(query)
            return urlunparse(parsed._replace(query=new_query))
        except Exception:
            sep = "&" if "?" in endpoint else "?"
            return f"{endpoint}{sep}token={token}"

    async def _ws_call(self, endpoint: str, token: str):
        ws_url = self._append_token_to_ws(endpoint, token)
        started = time.perf_counter()
        try:
            async with websockets.connect(ws_url, ping_interval=20, ping_timeout=10) as ws:
                # consider connection established once open; close immediately
                elapsed = (time.perf_counter() - started) * 1000
                try:
                    await ws.close()
                except Exception:
                    pass
                return {"ok": True, "status": "open", "ms": elapsed, "message": "opened"}
        except Exception as exc:
            elapsed = (time.perf_counter() - started) * 1000
            return {"ok": False, "status": "error", "ms": elapsed, "message": str(exc)}

    async def run_ws_burst(self, endpoint: str, count: int, token: str = "") -> List[Dict]:
        tasks = [self._ws_call(endpoint, token) for _ in range(count)]
        return await asyncio.gather(*tasks)

    @staticmethod
    def summarize(results: List[Dict]):
        if not results:
            return {"success": 0, "fail": 0, "min": 0, "max": 0, "avg": 0}
        success = sum(1 for r in results if r.get("ok"))
        fail = len(results) - success
        ms_values = [r.get("ms", 0) for r in results]
        return {
            "success": success,
            "fail": fail,
            "min": min(ms_values),
            "max": max(ms_values),
            "avg": sum(ms_values) / len(ms_values),
        }

