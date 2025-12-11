"""
FastAPI Server - Modern Full-Stack Application
Serves both API and Static Frontend
"""

import warnings
warnings.filterwarnings("ignore", message=".*Pydantic V1 functionality.*")
from fastapi import FastAPI, HTTPException, status, Request, Body
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import uvicorn
from pymongo import MongoClient
from datetime import datetime
import os
import subprocess
import threading
import shlex
import shutil
import secrets
import json
from dotenv import load_dotenv
from typing import List, Dict
from pathlib import Path

# Track current k6 process
current_k6_proc = None

# Load environment variables
load_dotenv()

# Load config
from config import settings

# MongoDB helpers
def get_db():
    client = MongoClient(settings.MONGODB_URL, serverSelectionTimeoutMS=5000)
    return client[settings.MONGODB_DATABASE]

# Create FastAPI app with proper config
app = FastAPI(
    title=settings.APP_NAME,
    description=settings.APP_DESCRIPTION,
    version=settings.APP_VERSION
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files
app.mount("/static", StaticFiles(directory=str(settings.STATIC_DIR)), name="static")

# Templates
templates = Jinja2Templates(directory=str(settings.TEMPLATES_DIR))

# Frontend routes
@app.get("/", response_class=HTMLResponse)
async def frontend_home(request: Request):
    """Serve the main frontend application"""
    return templates.TemplateResponse("crud_interface.html", {"request": request})

@app.get("/health", response_class=JSONResponse)
async def health_check():
    """API Health check"""
    return {"status": "healthy", "server": "FastAPI + Static Frontend"}

@app.get("/k6", response_class=HTMLResponse)
async def k6_page(request: Request):
    """Serve k6 config UI"""
    return templates.TemplateResponse("k6_interface.html", {"request": request})

# Additional API Routes
@app.get("/api/info")
async def api_info():
    """Get API information"""
    return {"message": "KJC Python Server API running!", "version": "2.0.0", "type": "FastAPI + Static"}


@app.post("/api/run-k6", response_class=JSONResponse)
async def run_k6(payload: Dict = Body(None)):
    """
    Launch a k6 run as a subprocess. Requires k6 installed on host.
    Returns pid and dashboard URL (web-dashboard).
    """
    global current_k6_proc
    # Resolve k6 binary
    k6_bin_opt = os.getenv("K6_BIN", "")
    bin_candidates = []
    if k6_bin_opt:
        bin_candidates.append(k6_bin_opt)
    # common Windows install paths
    bin_candidates.extend([
        shutil.which("k6") or "k6",
        r"C:\Program Files\k6\k6.exe",
        r"C:\ProgramData\chocolatey\bin\k6.exe",
    ])
    k6_bin = next((p for p in bin_candidates if p and os.path.exists(p)), None)
    if not k6_bin:
        raise HTTPException(
            status_code=400,
            detail="k6 binary not found. Install k6 or set K6_BIN (e.g. C:\\Program Files\\k6\\k6.exe).",
        )

    chat_count = str(payload.get("chat_count", os.getenv("CHAT_COUNT", "10")))
    api_per_chat = str(payload.get("api_per_chat", os.getenv("API_PER_CHAT", "3")))
    max_duration = str(payload.get("max_duration", os.getenv("MAX_DURATION", "2m")))
    login_url = payload.get("login_url", os.getenv("LOGIN_URL", "http://localhost:8083/api/auth/login"))
    api_url = payload.get("api_url", os.getenv("API_URL", "http://localhost:8083/api/data-botting"))
    ws_url = payload.get("ws_url", os.getenv("WS_URL", "ws://localhost:8086/ws"))
    username = payload.get("username", os.getenv("USERNAME", "admin"))
    password = payload.get("password", os.getenv("PASSWORD", "admin123"))
    out_mode = payload.get("out_mode", "web-dashboard")
    linger = bool(payload.get("linger", False))
    ws_linger_ms = str(payload.get("ws_linger_ms", os.getenv("WS_LINGER_MS", "")))
    base_dir = settings.BASE_DIR
    k6_path = str(base_dir / "k6_load_test.js")
    # Use a relative path for k6 to write summary to static/summary.json
    summary_rel = "static/summary.json"
    summary_abs = settings.BASE_DIR / summary_rel

    # Build command
    cmd = [
        k6_bin, "run",
        "--out", out_mode,
        "-e", f"CHAT_COUNT={chat_count}",
        "-e", f"API_PER_CHAT={api_per_chat}",
        "-e", f"MAX_DURATION={max_duration}",
        "-e", f"LOGIN_URL={login_url}",
        "-e", f"API_URL={api_url}",
        "-e", f"WS_URL={ws_url}",
        "-e", f"SUMMARY_PATH={summary_rel}",
    ]
    cmd_display = [
        "k6", "run",
        "--out", out_mode,
        "-e", f"CHAT_COUNT={chat_count}",
        "-e", f"API_PER_CHAT={api_per_chat}",
        "-e", f"MAX_DURATION={max_duration}",
        "-e", f"LOGIN_URL={login_url}",
        "-e", f"API_URL={api_url}",
        "-e", f"WS_URL={ws_url}",
        "-e", f"SUMMARY_PATH={summary_rel}",
    ]
    if ws_linger_ms:
        cmd += ["-e", f"WS_LINGER_MS={ws_linger_ms}"]
        cmd_display += ["-e", f"WS_LINGER_MS={ws_linger_ms}"]
    if linger:
        cmd.insert(2, "--linger")
        cmd_display.insert(2, "--linger")
    cmd += ["-e", f"USERNAME={username}", "-e", f"PASSWORD={password}"]
    cmd_display += ["-e", f"USERNAME={username}", "-e", f"PASSWORD={password}"]

    cmd.append(k6_path)
    cmd_display.append("k6_load_test.js")

    # Kill existing job if running
    if current_k6_proc and current_k6_proc.poll() is None:
        try:
            current_k6_proc.terminate()
            current_k6_proc.wait(timeout=5)
        except Exception:
            try:
                current_k6_proc.kill()
            except Exception:
                pass

    # Reset summary file to avoid stale data while new run executes
    try:
        summary_abs.parent.mkdir(parents=True, exist_ok=True)
        summary_abs.write_text('{"status":"waiting"}', encoding="utf-8")
    except Exception:
        pass

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,  # avoid pipe blocking when k6 writes logs
            stderr=subprocess.STDOUT,
            text=True,
            cwd=str(base_dir),
        )
        current_k6_proc = proc
    except FileNotFoundError:
        raise HTTPException(status_code=400, detail="k6 binary not found or not executable.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start k6: {e}")

    # Guard: kill k6 if it exceeds declared max_duration (plus small buffer)
    def _kill_late(p: subprocess.Popen, guard_seconds: float):
        try:
            p.wait(timeout=guard_seconds)
        except subprocess.TimeoutExpired:
            try:
                p.terminate()
                p.wait(timeout=3)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass

    guard_seconds = max(parse_duration_seconds(max_duration) + 5, 10)  # at least 10s
    threading.Thread(target=_kill_late, args=(proc, guard_seconds), daemon=True).start()

    return {
        "pid": proc.pid,
        "cmd": " ".join(shlex.quote(c) for c in cmd_display),
        "dashboard": "http://127.0.0.1:5665",
        "note": "Dashboard available while the test is running." + (" (linger enabled)" if linger else ""),
    }


def parse_duration_seconds(value: str) -> float:
    """Parse duration string with units ms, s, m, h. Default seconds if no unit."""
    if not value:
        return 0
    s = str(value).strip()
    try:
        # simple number -> seconds
        return float(s)
    except Exception:
        pass
    num = ""
    unit = ""
    for ch in s:
        if (ch.isdigit() or ch == ".") and unit == "":
            num += ch
        else:
            unit += ch
    try:
        n = float(num)
    except Exception:
        return 0
    unit = unit.lower().strip() or "s"
    factor = {"ms": 0.001, "s": 1, "m": 60, "h": 3600}.get(unit, 1)
    return n * factor

@app.post("/auth/login")
async def auth_login(payload: Dict = Body(...)):
    """
    Simple login stub for load-test UI.
    Accepts username/password and returns a fake bearer token.
    """
    username = payload.get("username", "")
    password = payload.get("password", "")

    admin_user = os.getenv("ADMIN_USERNAME", "admin")
    admin_pass = os.getenv("ADMIN_PASSWORD", "admin123")

    if username == admin_user and password == admin_pass:
        token = secrets.token_urlsafe(32)
        return {
            "success": True,
            "token": token,
            "accessToken": token,
            "username": username
        }

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid credentials"
    )

@app.get("/api/data")
async def get_data():
    """Sample data endpoint"""
    return {
        "data": ["item1", "item2", "item3"],
        "count": 3
    }

@app.get("/mongodb/test")
async def test_mongodb():
    try:
        # Kết nối MongoDB Atlas từ env
        mongodb_url = os.getenv("MONGODB_URL")
        client = MongoClient(mongodb_url, serverSelectionTimeoutMS=5000)
        client.server_info()  # Test connection
        
        # Test database
        db_name = os.getenv("MONGODB_DATABASE", "kjc-group-staging")
        db = client[db_name]
        collection = db.api_test
        
        # Insert test data
        test_doc = {"message": "Hello MongoDB", "timestamp": datetime.now()}
        result = collection.insert_one(test_doc)
        
        # Read back
        found_doc = collection.find_one({"_id": result.inserted_id})
        found_doc["_id"] = str(found_doc["_id"])  # Convert ObjectId to string
        
        client.close()
        
        return {
            "status": "success",
            "mongodb_connected": True,
            "inserted_id": str(result.inserted_id),
            "document": found_doc
        }
    except Exception as e:
        return {
            "status": "error",
            "mongodb_connected": False,
            "error": str(e)
        }



# Import botnet routes
from botnet_routes import router as botnet_router
app.include_router(botnet_router, prefix="/api", tags=["API"])

# Development server
if __name__ == "__main__":
    print(f"🚀 Starting {settings.APP_NAME} v{settings.APP_VERSION}")
    print(f"🌐 Frontend: http://localhost:{settings.PORT}")  
    print(f"📖 API Docs: http://localhost:{settings.PORT}/docs")
    print(f"🔗 ReDoc: http://localhost:{settings.PORT}/redoc")
    
    uvicorn.run(
        "main:app", 
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.DEBUG
    )