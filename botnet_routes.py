import asyncio
from fastapi import APIRouter, HTTPException, Body
from typing import Dict
from botnet_service import get_botnet_service
from botnet_data_botting_service import DataBottingService

router = APIRouter()
data_botting_service = DataBottingService()

@router.post("/botnet")
async def botnet(request: Dict):
    """🤖 Single bot login using optimized botnet service"""
    botnet_service = get_botnet_service()
    username = request.get("username", "")
    password = request.get("password", "")
    appId = request.get("appId", "")
    result = await botnet_service.manage_bot_session(username, password, appId)
    if result.get("success"):
        return {
            "message": result["message"],
            "username": result["username"],
            "userId": result.get("userId", ""),
            "accessToken": result.get("accessToken", ""),
            "authCode": result.get("authCode", ""),
            "sync_result": result.get("sync_result", {}),
            "ws_result": result.get("ws_result", {}),
            "ws_response": result.get("ws_result", {}).get("response", ""),
        }
    else:
        return {"message": result.get("message", "Unknown error"), "success": False}

@router.get("/scrape-sjc")
async def scrape_sjc():
    """🔍 Crawl SJC gold prices from webgia.com and return status via backend logs"""
    try:
        botnet_service = get_botnet_service()
        result = await botnet_service.scrape_sjc()
        if result.get("success"):
            return {
                "message": "SJC scraping completed successfully",
                "status": "success",
                "data": result
            }
        else:
            return {
                "message": f"SJC scraping failed: {result.get('error', 'Unknown error')}",
                "status": "error",
                "data": result
            }
    except Exception as e:
        return {
            "message": f"API error: {str(e)}",
            "status": "error"
        }


@router.post("/botnet/data-botting")
async def botnet_data_botting(
    payload: Dict = Body(
        ...,
        example={
            "httpEndpoint": "http://localhost:8083/api/data-botting",
            "httpMethod": "GET",
            "httpCount": 10,
            "wsEndpoint": "ws://localhost:8086/ws",
            "wsCount": 5,
            "token": "",
            "body": {},
        },
    )
):
    """
    Run lightweight HTTP + WS burst from backend for load-test UI.
    """
    http_endpoint = payload.get("httpEndpoint", "")
    http_method = (payload.get("httpMethod", "GET") or "GET").upper()
    http_count = int(payload.get("httpCount", 0) or 0)
    ws_endpoint = payload.get("wsEndpoint", "")
    ws_count = int(payload.get("wsCount", 0) or 0)
    token = payload.get("token", "") or ""
    body = payload.get("body", {}) or {}

    if not http_endpoint and not ws_endpoint:
        raise HTTPException(status_code=400, detail="httpEndpoint or wsEndpoint is required")

    if http_count < 0 or ws_count < 0:
        raise HTTPException(status_code=400, detail="Counts must be non-negative")

    # Cap to prevent accidental overload
    if http_count > 2000 or ws_count > 2000:
        raise HTTPException(status_code=400, detail="Counts too large (max 2000)")

    # Tính tổng HTTP = httpCount * wsCount (luôn nhân kể cả wsCount=0)
    effective_http = http_count * ws_count

    http_task = asyncio.create_task(
        data_botting_service.run_http_burst(
            http_endpoint, http_method, effective_http, token=token, payload=body
        )
    ) if http_endpoint and effective_http > 0 else None

    ws_task = asyncio.create_task(
        data_botting_service.run_ws_burst(ws_endpoint, ws_count, token=token)
    ) if ws_endpoint and ws_count > 0 else None

    http_results, ws_results = [], []
    if http_task and ws_task:
        http_results, ws_results = await asyncio.gather(http_task, ws_task)
    elif http_task:
        http_results = await http_task
    elif ws_task:
        ws_results = await ws_task

    return {
        "http": {
            "endpoint": http_endpoint,
            "method": http_method,
            "count": effective_http,
            "results": http_results,
            "summary": data_botting_service.summarize(http_results),
        },
        "ws": {
            "endpoint": ws_endpoint,
            "count": ws_count,
            "results": ws_results,
            "summary": data_botting_service.summarize(ws_results),
        },
        "token_used": bool(token),
    }
