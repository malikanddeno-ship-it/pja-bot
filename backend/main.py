"""
Project Azure — Backend API
Shared data layer between the Discord bot and the web portal.
Run: uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""

from fastapi import FastAPI, HTTPException, Depends, Header, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, HTMLResponse
from pydantic import BaseModel, Field
from typing import Optional, List
import base64, hashlib, hmac, json, os, re, secrets, threading, time, uuid
from datetime import datetime, timezone
from pathlib import Path

import dotenv

dotenv.load_dotenv(Path(__file__).parent.parent / ".env")


# ─── CONFIG ──────────────────────────────────────────────────────────────────
DATA_DIR = Path(os.environ.get("PJA_DATA_DIR", str(Path(__file__).parent / "data"))).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)
PORTAL_PATH = Path(__file__).parent.parent / "website" / "index.html"

API_SECRET = os.environ.get("PJA_API_SECRET", "").strip()
MANAGER_USERNAME = os.environ.get("PJA_MANAGER_USERNAME", "manager").strip()
MANAGER_PASSWORD = os.environ.get("PJA_MANAGER_PASSWORD", "").strip()
MANAGER_SESSION_SECRET = os.environ.get("PJA_MANAGER_SESSION_SECRET", "").strip()
MANAGER_SESSION_TTL_SECONDS = int(os.environ.get("PJA_MANAGER_SESSION_TTL_SECONDS", "28800"))
PLAYER_SESSION_TTL_SECONDS = int(os.environ.get("PJA_PLAYER_SESSION_TTL_SECONDS", "604800"))
PORTAL_CODE_TTL_SECONDS = int(os.environ.get("PJA_PORTAL_CODE_TTL_SECONDS", "600"))

# These role names always have access to manager-only Discord commands.
# Matching is case-insensitive and treats hyphens/underscores like spaces.
DEFAULT_MANAGER_ROLES = ("OWNER", "CO OWNER", "TEAM MANAGER")

missing_config = [
    name for name, value in {
        "PJA_API_SECRET": API_SECRET,
        "PJA_MANAGER_PASSWORD": MANAGER_PASSWORD,
        "PJA_MANAGER_SESSION_SECRET": MANAGER_SESSION_SECRET,
    }.items() if not value
]
if missing_config:
    raise RuntimeError(
        "Missing required environment variables: " + ", ".join(missing_config)
    )

app = FastAPI(title="Project Azure API", version="6.0.0", docs_url="/docs")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # Lock down to your domain in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── DB HELPERS (thread-locked to avoid lost writes under concurrent access) ──
_file_lock = threading.Lock()

def load(name: str) -> dict:
    p = DATA_DIR / f"{name}.json"
    with _file_lock:
        if not p.exists():
            return {}
        return json.loads(p.read_text())

def save(name: str, data: dict):
    p = DATA_DIR / f"{name}.json"
    with _file_lock:
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2))
        tmp.replace(p)  # atomic on POSIX, avoids truncated reads mid-write

def now() -> str:
    return datetime.now(timezone.utc).isoformat()

def new_id(prefix: str = "") -> str:
    return prefix + str(uuid.uuid4())[:8].upper()

def public_tryout(app: dict) -> dict:
    """Return only fields that are safe to show on the public portal."""
    keys = ("id", "username", "position", "overall", "status", "submitted_at", "source")
    return {key: app.get(key) for key in keys}


def archive_tryout_snapshot(app_data: dict, event: str, actor: str = "") -> None:
    """Keep a second, manager-only history of every tryout submission.

    The main tryouts.json file remains the live source of truth. This archive
    makes Discord submissions easy to find later even if the review message
    is deleted from Discord.
    """
    archive = load("tryout_archive")
    app_id = str(app_data.get("id", ""))
    if not app_id:
        return
    entry = archive.setdefault(app_id, {
        "id": app_id,
        "created_at": app_data.get("submitted_at") or now(),
        "history": [],
    })
    event_time = now()
    entry["application"] = dict(app_data)
    entry["updated_at"] = event_time
    entry["last_event"] = event
    entry.setdefault("history", []).append({
        "event": event,
        "status": app_data.get("status", "pending"),
        "actor": actor,
        "at": event_time,
    })
    save("tryout_archive", archive)

def load_portal_html() -> str:
    html = PORTAL_PATH.read_text(encoding="utf-8")
    injection = """
<script>
  window.PJA_API = window.location.origin;
</script>
"""
    if "</head>" in html:
        return html.replace("</head>", f"{injection}\n</head>", 1)
    return injection + html

@app.get("/portal", response_class=HTMLResponse)
@app.get("/portal/", response_class=HTMLResponse)
def portal():
    if not PORTAL_PATH.exists():
        raise HTTPException(404, "Portal not found")
    return HTMLResponse(load_portal_html())

def _sign_manager_session(payload: str) -> str:
    return hmac.new(MANAGER_SESSION_SECRET.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()

def _create_session_token(payload: dict, ttl_seconds: int) -> str:
    body = {**payload, "exp": int(time.time()) + ttl_seconds}
    payload_encoded = base64.urlsafe_b64encode(json.dumps(body, separators=(",", ":")).encode("utf-8")).decode("ascii")
    signature = _sign_manager_session(payload_encoded)
    return f"{payload_encoded}.{signature}"


def _verify_session_token(token: str, expected_role: str) -> Optional[dict]:
    try:
        payload_encoded, signature = token.split(".", 1)
        expected_signature = _sign_manager_session(payload_encoded)
        if not hmac.compare_digest(signature, expected_signature):
            return None
        payload = json.loads(base64.urlsafe_b64decode(payload_encoded.encode("ascii")).decode("utf-8"))
        if int(payload.get("exp", 0)) < int(time.time()):
            return None
        if payload.get("role") != expected_role:
            return None
        return payload
    except Exception:
        return None


def create_manager_token(username: str) -> str:
    return _create_session_token({"username": username, "role": "manager"}, MANAGER_SESSION_TTL_SECONDS)


def verify_manager_token(token: str) -> Optional[str]:
    payload = _verify_session_token(token, "manager")
    return payload.get("username") if payload else None


def create_player_token(discord_id: str, username: str) -> str:
    return _create_session_token({"discord_id": discord_id, "username": username, "role": "player"}, PLAYER_SESSION_TTL_SECONDS)


def verify_player_token(token: str) -> Optional[dict]:
    return _verify_session_token(token, "player")

class ManagerLoginRequest(BaseModel):
    username: str
    password: str

class ManagerLoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    username: str


class PortalCodeCreate(BaseModel):
    discord_id: str = Field(pattern=r"^\d{15,22}$")
    username: str = Field(min_length=1, max_length=100)


class PortalCodeRedeem(BaseModel):
    code: str = Field(min_length=6, max_length=20)


class PlayerSessionResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    discord_id: str
    username: str

@app.post("/auth/login", response_model=ManagerLoginResponse)
def manager_login(data: ManagerLoginRequest):
    if not hmac.compare_digest(data.username, MANAGER_USERNAME) or not hmac.compare_digest(data.password, MANAGER_PASSWORD):
        raise HTTPException(status_code=401, detail="Invalid manager credentials")
    return {
        "access_token": create_manager_token(data.username),
        "token_type": "bearer",
        "username": data.username,
    }


# ─── AUTH ─────────────────────────────────────────────────────────────────────
# Both the Discord bot and the website's manager dashboard are first-party
# clients of this backend and share one secret — a player's browser never
# holds this key, only requests the manager dashboard's server-side proxy
# makes do. What the bot DOES need to know is whether a write came from
# itself (so its WebSocket listener doesn't re-post a Discord message for
# something it already posted synchronously) or from the website. That's
# carried by X-Client, separate from auth, since spoofing "source" should
# require holding the real secret in the first place — a request with the
# right key but no X-Client is treated as "website" (the safer default: it
# means the bot posts a Discord message it might not strictly need to,
# rather than silently dropping a website action).
def require_client(x_api_key: str = Header(None), x_client: str = Header(None), authorization: str = Header(None)) -> str:
    if not x_api_key or not hmac.compare_digest(x_api_key, API_SECRET):
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(status_code=401, detail="Invalid API key")
        token = authorization.split(" ", 1)[1].strip()
        if not verify_manager_token(token):
            raise HTTPException(status_code=401, detail="Invalid manager session")
    return "bot" if x_client == "bot" else "website"


def require_player(authorization: str = Header(None)) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Player login required")
    token = authorization.split(" ", 1)[1].strip()
    payload = verify_player_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Player session expired or invalid")
    return payload

def identify_tryout_source(x_api_key: str = Header(None), x_client: str = Header(None)) -> str:
    """Public website applications are allowed; bot-tagged submissions require the secret."""
    if x_client == "bot":
        if not x_api_key or not hmac.compare_digest(x_api_key, API_SECRET):
            raise HTTPException(status_code=401, detail="Invalid API key")
        return "bot"
    return "website"


@app.post("/player/auth/code")
def create_portal_login_code(data: PortalCodeCreate, source: str = Depends(require_client)):
    # One-use code generated by the Discord bot. Store only its hash.
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    code = "".join(secrets.choice(alphabet) for _ in range(8))
    code_hash = hashlib.sha256(code.encode("utf-8")).hexdigest()
    db = load("portal_codes")
    cutoff = int(time.time())
    db = {key: value for key, value in db.items() if int(value.get("expires", 0)) >= cutoff}
    db[code_hash] = {
        "discord_id": data.discord_id,
        "username": data.username,
        "expires": cutoff + PORTAL_CODE_TTL_SECONDS,
        "created_at": now(),
    }
    save("portal_codes", db)
    return {"code": code, "expires_in": PORTAL_CODE_TTL_SECONDS}


@app.post("/player/auth/redeem", response_model=PlayerSessionResponse)
def redeem_portal_login_code(data: PortalCodeRedeem):
    code = re.sub(r"[^A-Z0-9]", "", data.code.upper())
    code_hash = hashlib.sha256(code.encode("utf-8")).hexdigest()
    db = load("portal_codes")
    entry = db.get(code_hash)
    if not entry or int(entry.get("expires", 0)) < int(time.time()):
        db.pop(code_hash, None)
        save("portal_codes", db)
        raise HTTPException(status_code=401, detail="That login code is invalid or expired")
    db.pop(code_hash, None)
    save("portal_codes", db)
    return {
        "access_token": create_player_token(entry["discord_id"], entry["username"]),
        "token_type": "bearer",
        "discord_id": entry["discord_id"],
        "username": entry["username"],
    }

# ─── LIVE SYNC (WebSocket broadcast) ───────────────────────────────────────────
# Both the bot and the website connect here. Any create/update/delete below
# calls `broadcast()` after a successful save, so every connected client
# (Discord bot's listener task + every open browser tab) gets the change
# immediately instead of having to poll.
class ConnectionManager:
    def __init__(self):
        self.active: List[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, event: str, payload: dict):
        dead = []
        message = json.dumps({"event": event, "data": payload, "ts": now()})
        for ws in self.active:
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

manager = ConnectionManager()

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # Clients don't need to send anything; this just keeps the
            # connection open and detects disconnects.
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

# ─── MODELS ──────────────────────────────────────────────────────────────────
class TryoutCreate(BaseModel):
    discord_id: str = Field(pattern=r"^\d{17,20}$")
    discord_tag: str = Field(min_length=2, max_length=100)
    username: str = Field(min_length=1, max_length=50)
    position: str = Field(min_length=1, max_length=30)
    overall: str = Field(min_length=1, max_length=20)
    experience: str = Field(min_length=3, max_length=1000)
    reason: str = Field(min_length=3, max_length=1000)
    availability: str = Field(min_length=1, max_length=100)

class TryoutReview(BaseModel):
    status: str          # accepted | denied | trial
    reviewed_by: str

class PlayerCreate(BaseModel):
    discord_id: str
    discord_tag: str
    username: str
    position: str
    overall: int
    status: str = "Active"
    added_by: str = "System"

class PlayerUpdate(BaseModel):
    overall: Optional[int] = None
    status: Optional[str] = None
    position: Optional[str] = None

class StatsCreate(BaseModel):
    discord_id: str = Field(pattern=r"^\d{15,22}$")
    discord_tag: str = Field(min_length=1, max_length=100)
    match_id: str = Field(min_length=1, max_length=50)
    opponent: str = Field(min_length=1, max_length=100)
    result: str = Field(min_length=1, max_length=50)
    goals: int = Field(default=0, ge=0, le=100)
    assists: int = Field(default=0, ge=0, le=100)
    saves: int = Field(default=0, ge=0, le=500)
    shots: int = Field(default=0, ge=0, le=500)
    passes: int = Field(default=0, ge=0, le=5000)
    tackles: int = Field(default=0, ge=0, le=500)
    interceptions: int = Field(default=0, ge=0, le=500)
    player_username: str = Field(default="", max_length=100)

class MOTMCreate(BaseModel):
    match_id: str
    opponent: str
    nominees: List[str]
    started_by: str

class MOTMVote(BaseModel):
    voter_id: str
    voter_tag: str
    nominee: str

def normalize_match_type(value: str) -> str:
    """Keep every match on one of the two PJA routing lanes."""
    cleaned = re.sub(r"[\s_-]+", " ", str(value or "").strip().lower())
    if "friendly" in cleaned:
        return "Friendly"
    if "league" in cleaned:
        return "League Match"
    raise ValueError("Match type must be Friendly or League Match")


class ScrimCreate(BaseModel):
    opponent: str
    match_type: str = "Friendly"
    match_time: str
    notes: str = ""
    created_by: str

class ScrimRSVP(BaseModel):
    discord_id: str
    username: str
    status: str          # going | maybe | cant
    note: str = Field(default="", max_length=300)


class ScrimChannelSettingsUpdate(BaseModel):
    league_channel_id: str = Field(pattern=r"^\d{15,22}$")
    friendly_channel_id: str = Field(pattern=r"^\d{15,22}$")
    league_channel_name: str = Field(default="league-ticks", min_length=1, max_length=100)
    friendly_channel_name: str = Field(default="friendly-ticks", min_length=1, max_length=100)
    updated_by: str = Field(default="Manager", min_length=1, max_length=100)

class AnnouncementCreate(BaseModel):
    title: str
    message: str
    color: str = "#3B82F6"
    image_url: str = ""
    link_label: str = ""
    link_url: str = ""
    ping: str = ""
    posted_by: str
    channel_id: Optional[str] = None   # Discord channel to post in; required if posted from the website

class ManagerRoleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    role_id: str = Field(min_length=15, max_length=22)

class StatsReview(BaseModel):
    status: str = Field(pattern=r"^(approved|denied)$")
    reviewed_by: str = Field(min_length=1, max_length=100)

class PointsAdjust(BaseModel):
    discord_id: str = Field(pattern=r"^\d{15,22}$")
    username: str = Field(min_length=1, max_length=100)
    amount: int = Field(ge=-100000, le=100000)
    reason: str = Field(min_length=2, max_length=300)
    actor: str = Field(min_length=1, max_length=100)

class PointsSet(BaseModel):
    discord_id: str = Field(pattern=r"^\d{15,22}$")
    username: str = Field(min_length=1, max_length=100)
    balance: int = Field(ge=0, le=1000000)
    reason: str = Field(min_length=2, max_length=300)
    actor: str = Field(min_length=1, max_length=100)

class ShopPurchase(BaseModel):
    discord_id: str = Field(pattern=r"^\d{15,22}$")
    username: str = Field(min_length=1, max_length=100)
    item_id: str = Field(min_length=1, max_length=100)

class ShopOrderReview(BaseModel):
    status: str = Field(pattern=r"^(fulfilled|rejected)$")
    reviewed_by: str = Field(min_length=1, max_length=100)
    manager_note: str = Field(default="", max_length=500)

class SuggestionCreate(BaseModel):
    discord_id: str = Field(pattern=r"^\d{15,22}$")
    username: str = Field(min_length=1, max_length=100)
    category: str = Field(min_length=1, max_length=50)
    message: str = Field(min_length=3, max_length=1500)

class ComplaintCreate(BaseModel):
    discord_id: str = Field(pattern=r"^\d{15,22}$")
    username: str = Field(min_length=1, max_length=100)
    category: str = Field(min_length=1, max_length=50)
    message: str = Field(min_length=3, max_length=1500)
    attachment_url: str = Field(default="", max_length=1000)

class FeedbackReview(BaseModel):
    status: str = Field(min_length=2, max_length=30)
    reviewed_by: str = Field(min_length=1, max_length=100)
    reply: str = Field(default="", max_length=1000)
    private_note: str = Field(default="", max_length=1000)


class PlayerConversationCreate(BaseModel):
    subject: str = Field(min_length=2, max_length=120)
    category: str = Field(default="General", min_length=1, max_length=50)
    message: str = Field(min_length=2, max_length=2000)
    attachment_url: str = Field(default="", max_length=1000)


class BotConversationCreate(PlayerConversationCreate):
    discord_id: str = Field(pattern=r"^\d{15,22}$")
    username: str = Field(min_length=1, max_length=100)


class ConversationMessageCreate(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    attachment_url: str = Field(default="", max_length=1000)


class ManagerConversationUpdate(BaseModel):
    status: str = Field(default="open", pattern=r"^(open|waiting_for_player|resolved|closed)$")
    assigned_to: str = Field(default="", max_length=100)
    reply: str = Field(default="", max_length=2000)
    manager_name: str = Field(default="Manager", max_length=100)


class PlayerRequestCreate(BaseModel):
    request_type: str = Field(min_length=1, max_length=80)
    details: str = Field(min_length=3, max_length=2000)
    attachment_url: str = Field(default="", max_length=1000)


class BotRequestCreate(PlayerRequestCreate):
    discord_id: str = Field(pattern=r"^\d{15,22}$")
    username: str = Field(min_length=1, max_length=100)


class ManagerRequestUpdate(BaseModel):
    status: str = Field(pattern=r"^(pending|reviewing|needs_info|accepted|declined|completed)$")
    reviewed_by: str = Field(min_length=1, max_length=100)
    reply: str = Field(default="", max_length=1500)
    private_note: str = Field(default="", max_length=1500)


class PlayerAvailabilitySet(BaseModel):
    scrim_id: str = Field(min_length=1, max_length=50)
    status: str = Field(pattern=r"^(going|maybe|cant)$")
    note: str = Field(default="", max_length=300)

class PlayerPortalStatsSubmit(BaseModel):
    match_id: str = Field(min_length=1, max_length=50)
    goals: int = Field(default=0, ge=0, le=100)
    assists: int = Field(default=0, ge=0, le=100)
    saves: int = Field(default=0, ge=0, le=500)
    shots: int = Field(default=0, ge=0, le=500)
    passes: int = Field(default=0, ge=0, le=5000)
    tackles: int = Field(default=0, ge=0, le=500)
    interceptions: int = Field(default=0, ge=0, le=500)


class PlayerPortalMOTMVote(BaseModel):
    nominee: str = Field(min_length=1, max_length=100)


class ManagerLineupUpdate(BaseModel):
    lineup: str = Field(default="", max_length=2000)
    notes: str = Field(default="", max_length=2000)
    updated_by: str = Field(default="Manager", max_length=100)


class PlayerShopPurchase(BaseModel):
    item_id: str = Field(min_length=1, max_length=100)


class PlayerSuggestionCreate(BaseModel):
    category: str = Field(min_length=1, max_length=50)
    message: str = Field(min_length=3, max_length=1500)


class PlayerComplaintCreate(BaseModel):
    category: str = Field(min_length=1, max_length=50)
    message: str = Field(min_length=3, max_length=1500)
    attachment_url: str = Field(default="", max_length=1000)
    attachment_url: str = Field(default="", max_length=1000)



class LineupPlayer(BaseModel):
    discord_id: str = Field(pattern=r"^\d{15,22}$")
    username: str = Field(min_length=1, max_length=100)
    position: str = Field(default="Player", max_length=40)
    x: float = Field(ge=0, le=100)
    y: float = Field(ge=0, le=100)
    slot: str = Field(default="starter", pattern=r"^(starter|bench|reserve)$")
    role: str = Field(default="", max_length=40)


class LineupTactics(BaseModel):
    formation: str = Field(default="4-3-3", max_length=30)
    attacking_style: str = Field(default="Balanced", max_length=60)
    passing_style: str = Field(default="Mixed", max_length=60)
    tempo: str = Field(default="Balanced", max_length=60)
    width: str = Field(default="Balanced", max_length=60)
    pressing: str = Field(default="Balanced", max_length=60)
    defensive_line: str = Field(default="Balanced", max_length=60)
    marking: str = Field(default="Zonal", max_length=60)
    counterattack: bool = False
    time_wasting: bool = False
    captain_id: str = ""
    vice_captain_id: str = ""
    penalty_taker_id: str = ""
    free_kick_taker_id: str = ""
    left_corner_taker_id: str = ""
    right_corner_taker_id: str = ""


class LineupV2Update(BaseModel):
    players: List[LineupPlayer] = Field(default_factory=list, max_length=40)
    tactics: LineupTactics = Field(default_factory=LineupTactics)
    notes: str = Field(default="", max_length=2000)
    published: bool = False
    updated_by: str = Field(default="Manager", max_length=100)


class ScrimEdit(BaseModel):
    opponent: Optional[str] = Field(default=None, max_length=100)
    match_type: Optional[str] = Field(default=None, max_length=40)
    match_time: Optional[str] = Field(default=None, max_length=100)
    notes: Optional[str] = Field(default=None, max_length=2000)
    status: Optional[str] = Field(default=None, pattern=r"^(scheduled|live|finished|cancelled)$")


class BroadcastStart(BaseModel):
    started_by: str = Field(default="Manager", max_length=100)
    channel_id: str = Field(default="", max_length=22)
    message_id: str = Field(default="", max_length=22)


class BroadcastEventCreate(BaseModel):
    event_type: str = Field(pattern=r"^(goal|assist|save|substitution|yellow|red|note)$")
    team: str = Field(default="pja", pattern=r"^(pja|opponent|team)$")
    player: str = Field(default="", max_length=100)
    secondary_player: str = Field(default="", max_length=100)
    minute: str = Field(default="", max_length=20)
    detail: str = Field(default="", max_length=500)
    home_score: Optional[int] = Field(default=None, ge=0, le=99)
    away_score: Optional[int] = Field(default=None, ge=0, le=99)
    actor: str = Field(default="Manager", max_length=100)


class BroadcastFinish(BaseModel):
    home_score: int = Field(ge=0, le=99)
    away_score: int = Field(ge=0, le=99)
    motm: str = Field(default="", max_length=100)
    summary: str = Field(default="", max_length=1000)
    finished_by: str = Field(default="Manager", max_length=100)


class SeasonStart(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    started_by: str = Field(default="Manager", max_length=100)


class SeasonFinish(BaseModel):
    finished_by: str = Field(default="Manager", max_length=100)
    notes: str = Field(default="", max_length=1000)


class AwardCreate(BaseModel):
    title: str = Field(min_length=1, max_length=100)
    winner: str = Field(min_length=1, max_length=100)
    discord_id: str = Field(default="", max_length=22)
    period: str = Field(default="Season", max_length=100)
    reason: str = Field(default="", max_length=500)
    awarded_by: str = Field(default="Manager", max_length=100)


class TrophyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    season: str = Field(default="", max_length=100)
    description: str = Field(default="", max_length=500)
    added_by: str = Field(default="Manager", max_length=100)

def normalize_role_name(name: str) -> str:
    return " ".join(name.replace("-", " ").replace("_", " ").split()).casefold()


POINT_RULES = {
    # Every approved match reward is worth at least 50 points.
    "played": 50,
    "win": 100,
    "draw": 50,
    "goal": 150,
    "assist": 100,
    "save": 50,
    "save_cap": 250,
    "clean_sheet": 150,
    "defensive": 100,
    "defensive_threshold": 5,
    "motm": 200,
}

DEFAULT_SHOP_ITEMS = [
    {"id": "custom-player-title", "name": "Custom Player Title", "price": 250, "description": "Add an approved title such as The Wall to your roster profile.", "fulfillment": "Manager adds the title to your profile."},
    {"id": "roster-emoji", "name": "Roster Emoji", "price": 350, "description": "Add an approved emoji beside your name on roster displays.", "fulfillment": "Manager adds the emoji to your profile."},
    {"id": "profile-bio", "name": "Player Profile Bio", "price": 500, "description": "Add a custom short bio to your website player profile.", "fulfillment": "Send the manager your approved bio."},
    {"id": "goal-celebration", "name": "Custom Goal Celebration", "price": 550, "description": "Your approved celebration text can appear with reported goals.", "fulfillment": "Manager records your celebration text."},
    {"id": "card-theme-unlock", "name": "Pro Card Theme", "price": 650, "description": "Unlock a brighter premium theme for /card view.", "fulfillment": "Automatically used by the card command after fulfillment."},
    {"id": "lineup-graphic", "name": "Matchday Lineup Graphic", "price": 750, "description": "Request one personalized matchday lineup graphic.", "fulfillment": "Manager creates the graphic for an upcoming match."},
    {"id": "position-trial", "name": "Position Trial Request", "price": 900, "description": "Request consideration for one practice at another position; selection is not guaranteed.", "fulfillment": "Manager reviews and schedules it when appropriate."},
    {"id": "matchday-spotlight", "name": "Matchday Spotlight", "price": 1000, "description": "Receive a featured player spotlight announcement.", "fulfillment": "Manager posts the spotlight at an appropriate time."},
    {"id": "custom-color-role", "name": "Custom Color Role", "price": 1200, "description": "Receive an approved custom Discord color role.", "fulfillment": "Manager creates or assigns the approved role."},
    {"id": "elite-card-theme", "name": "Elite Card Theme", "price": 1500, "description": "Unlock the full gold-foil Elite card with larger typography, unique serial, recent form, badges, lighting, and premium player presentation.", "fulfillment": "Automatically used by /card view after fulfillment."},
]


def approved_match(record: dict) -> bool:
    # Old records created before approval existed remain valid.
    return record.get("status", "approved") == "approved"


def _score_pair(result: str) -> Optional[tuple[int, int]]:
    match = re.search(r"(\d+)\s*[-:]\s*(\d+)", str(result))
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def result_is_win(result: str) -> bool:
    text = str(result).strip().upper()
    if text.startswith("W") or " WIN" in f" {text}":
        return True
    scores = _score_pair(text)
    return bool(scores and scores[0] > scores[1])


def result_is_draw(result: str) -> bool:
    text = str(result).strip().upper()
    if text.startswith("D") or " DRAW" in f" {text}":
        return True
    scores = _score_pair(text)
    return bool(scores and scores[0] == scores[1])


def result_is_clean_sheet(result: str) -> bool:
    scores = _score_pair(result)
    return bool(scores and scores[1] == 0)


def calculate_match_points(record: dict) -> tuple[int, list[dict]]:
    breakdown = [{"label": "Played in match", "amount": POINT_RULES["played"]}]
    result = record.get("result", "")
    if result_is_win(result):
        breakdown.append({"label": "Team win", "amount": POINT_RULES["win"]})
    elif result_is_draw(result):
        breakdown.append({"label": "Team draw", "amount": POINT_RULES["draw"]})

    goals = max(0, int(record.get("goals", 0)))
    assists = max(0, int(record.get("assists", 0)))
    saves_count = max(0, int(record.get("saves", 0)))
    tackles = max(0, int(record.get("tackles", 0)))
    interceptions = max(0, int(record.get("interceptions", 0)))

    if goals:
        breakdown.append({"label": f"{goals} goal{'s' if goals != 1 else ''}", "amount": goals * POINT_RULES["goal"]})
    if assists:
        breakdown.append({"label": f"{assists} assist{'s' if assists != 1 else ''}", "amount": assists * POINT_RULES["assist"]})
    if saves_count:
        raw_save_points = saves_count * POINT_RULES["save"]
        awarded_save_points = min(raw_save_points, POINT_RULES["save_cap"])
        cap_note = " (match cap reached)" if raw_save_points > awarded_save_points else ""
        breakdown.append({
            "label": f"{saves_count} save{'s' if saves_count != 1 else ''}{cap_note}",
            "amount": awarded_save_points,
        })
    if result_is_clean_sheet(result):
        breakdown.append({"label": "Clean sheet", "amount": POINT_RULES["clean_sheet"]})
    if tackles + interceptions >= POINT_RULES["defensive_threshold"]:
        breakdown.append({"label": "Strong defensive performance", "amount": POINT_RULES["defensive"]})
    return sum(item["amount"] for item in breakdown), breakdown


def points_profile(discord_id: str, username: str = "") -> dict:
    db = load("points")
    profile = db.get(discord_id, {"discord_id": discord_id, "username": username or discord_id, "balance": 0, "history": []})
    if username:
        profile["username"] = username
    profile.setdefault("history", [])
    profile.setdefault("balance", 0)
    return profile


def add_points(discord_id: str, username: str, amount: int, reason: str, actor: str, category: str = "manual", reference_id: str = "") -> dict:
    db = load("points")
    profile = db.get(discord_id, {"discord_id": discord_id, "username": username or discord_id, "balance": 0, "history": []})
    profile.setdefault("history", [])
    if username:
        profile["username"] = username
    if reference_id:
        previous = next((entry for entry in profile["history"] if entry.get("reference_id") == reference_id), None)
        if previous:
            return {"profile": profile, "transaction": previous, "duplicate": True}
    new_balance = int(profile.get("balance", 0)) + int(amount)
    if new_balance < 0:
        raise HTTPException(status_code=400, detail="Player does not have enough points")
    transaction = {
        "id": new_id("PT-"),
        "amount": int(amount),
        "reason": reason,
        "actor": actor,
        "category": category,
        "reference_id": reference_id,
        "created_at": now(),
        "balance_after": new_balance,
    }
    profile["balance"] = new_balance
    profile["updated_at"] = now()
    profile["history"] = [transaction] + profile["history"][:199]
    db[discord_id] = profile
    save("points", db)
    return {"profile": profile, "transaction": transaction, "duplicate": False}


def find_roster_player_by_username(username: str) -> Optional[dict]:
    wanted = normalize_role_name(username)
    for player in load("roster").values():
        if normalize_role_name(player.get("username", "")) == wanted:
            return player
    return None


def shop_catalog() -> list:
    return [dict(item) for item in DEFAULT_SHOP_ITEMS]


def get_shop_item(item_id: str) -> Optional[dict]:
    return next((item for item in DEFAULT_SHOP_ITEMS if item["id"] == item_id), None)


def manager_role_list() -> list:
    built_in = [
        {
            "id": f"built-in-{normalize_role_name(name).replace(' ', '-')}",
            "name": name,
            "role_id": "",
            "built_in": True,
        }
        for name in DEFAULT_MANAGER_ROLES
    ]
    custom = list(load("manager_roles").values())
    custom.sort(key=lambda role: role.get("added_at", ""), reverse=True)
    return built_in + custom

# ─── HEALTH ──────────────────────────────────────────────────────────────────
@app.get("/")
def root():
    return {"status": "online", "project": "Azure API", "version": "6.0.0"}

@app.get("/health")
def health():
    roster = load("roster")
    tryouts = load("tryouts")
    return {
        "status": "ok",
        "players": len(roster),
        "tryouts": len(tryouts),
        "pending_tryouts": sum(1 for t in tryouts.values() if t.get("status") == "pending"),
        "timestamp": now()
    }

# ─── MANAGER ROLE PERMISSIONS ────────────────────────────────────────────────
@app.get("/manager/roles")
def get_manager_roles(source: str = Depends(require_client)):
    return manager_role_list()


@app.post("/manager/roles")
async def add_manager_role(data: ManagerRoleCreate, source: str = Depends(require_client)):
    name = " ".join(data.name.split())
    role_id = data.role_id.strip()
    if not role_id.isdigit():
        raise HTTPException(status_code=422, detail="Discord Role ID must contain numbers only")

    normalized = normalize_role_name(name)
    if normalized in {normalize_role_name(value) for value in DEFAULT_MANAGER_ROLES}:
        raise HTTPException(status_code=409, detail="That role name already has built-in manager access")

    db = load("manager_roles")
    if any(role.get("role_id") == role_id for role in db.values()):
        raise HTTPException(status_code=409, detail="That Discord Role ID already has manager access")
    if any(normalize_role_name(role.get("name", "")) == normalized for role in db.values()):
        raise HTTPException(status_code=409, detail="That role name already has manager access")

    entry_id = new_id("ROLE-")
    entry = {
        "id": entry_id,
        "name": name,
        "role_id": role_id,
        "built_in": False,
        "added_at": now(),
        "source": source,
    }
    db[entry_id] = entry
    save("manager_roles", db)
    await manager.broadcast("manager_role_added", entry)
    return entry


@app.delete("/manager/roles/{entry_id}")
async def delete_manager_role(entry_id: str, source: str = Depends(require_client)):
    db = load("manager_roles")
    if entry_id not in db:
        raise HTTPException(status_code=404, detail="Manager role not found")
    removed = db.pop(entry_id)
    save("manager_roles", db)
    await manager.broadcast("manager_role_removed", {"id": entry_id, "role": removed, "source": source})
    return removed

# ─── TRYOUTS ─────────────────────────────────────────────────────────────────
@app.get("/tryouts")
def get_tryouts(status: Optional[str] = None):
    db = load("tryouts")
    apps = list(db.values())
    if status:
        apps = [a for a in apps if a.get("status") == status]
    apps = sorted(apps, key=lambda x: x.get("submitted_at", ""), reverse=True)
    return [public_tryout(app_) for app_ in apps]

@app.get("/manager/tryouts")
def get_manager_tryouts(status: Optional[str] = None, source: str = Depends(require_client)):
    db = load("tryouts")
    apps = list(db.values())
    if status:
        apps = [a for a in apps if a.get("status") == status]
    return sorted(apps, key=lambda x: x.get("submitted_at", ""), reverse=True)


@app.get("/manager/tryout-archive")
def get_manager_tryout_archive(status: Optional[str] = None, source: str = Depends(require_client)):
    """Return every saved application with its review history.

    Existing applications created before V5.5 are included from tryouts.json,
    so no old submissions disappear when the archive feature is deployed.
    """
    live = load("tryouts")
    archive = load("tryout_archive")
    rows = []
    for app_id, app_data in live.items():
        saved = archive.get(app_id, {})
        application = dict(saved.get("application") or app_data)
        application["archive_history"] = list(saved.get("history") or [])
        application["archive_updated_at"] = saved.get("updated_at") or application.get("reviewed_at") or application.get("submitted_at")
        rows.append(application)
    if status and status != "all":
        rows = [row for row in rows if row.get("status") == status]
    return sorted(rows, key=lambda row: row.get("submitted_at", ""), reverse=True)

@app.get("/tryouts/player/{discord_id}")
def get_player_tryout(discord_id: str, source: str = Depends(require_client)):
    db = load("tryouts")
    apps = [a for a in db.values() if a["discord_id"] == discord_id]
    if not apps:
        raise HTTPException(404, "No applications found")
    return sorted(apps, key=lambda x: x.get("submitted_at", ""))

@app.get("/tryouts/{app_id}")
def get_tryout(app_id: str, source: str = Depends(require_client)):
    db = load("tryouts")
    if app_id not in db:
        raise HTTPException(404, "Application not found")
    return db[app_id]

@app.post("/tryouts")
async def create_tryout(data: TryoutCreate, source: str = Depends(identify_tryout_source)):
    db = load("tryouts")
    for app_ in db.values():
        if app_["discord_id"] == data.discord_id and app_["status"] == "pending":
            raise HTTPException(409, "Already has a pending application")
    app_id = new_id("T")
    db[app_id] = {
        "id": app_id,
        **data.model_dump(),
        "status": "pending",
        "submitted_at": now(),
        "reviewed_by": None,
        "reviewed_at": None,
        "source": source,
    }
    save("tryouts", db)
    archive_tryout_snapshot(db[app_id], "submitted", data.discord_tag)
    await manager.broadcast("tryout_created", public_tryout(db[app_id]))
    return db[app_id]

@app.patch("/tryouts/{app_id}/review")
async def review_tryout(app_id: str, data: TryoutReview, source: str = Depends(require_client)):
    db = load("tryouts")
    if app_id not in db:
        raise HTTPException(404, "Application not found")
    valid = {"accepted", "denied", "trial"}
    if data.status not in valid:
        raise HTTPException(400, f"Status must be one of: {valid}")
    db[app_id]["status"] = data.status
    db[app_id]["reviewed_by"] = data.reviewed_by
    db[app_id]["reviewed_at"] = now()
    db[app_id]["source"] = source
    save("tryouts", db)
    archive_tryout_snapshot(db[app_id], "reviewed", data.reviewed_by)
    await manager.broadcast("tryout_reviewed", public_tryout(db[app_id]))
    return db[app_id]

# ─── ROSTER ──────────────────────────────────────────────────────────────────
@app.get("/roster")
def get_roster(status: Optional[str] = None, position: Optional[str] = None):
    db = load("roster")
    players = list(db.values())
    if status:
        players = [p for p in players if p.get("status", "").lower() == status.lower()]
    if position:
        players = [p for p in players if p.get("position", "").lower() == position.lower()]
    return sorted(players, key=lambda x: x.get("overall", 0), reverse=True)

@app.get("/roster/{discord_id}")
def get_player(discord_id: str):
    db = load("roster")
    if discord_id not in db:
        raise HTTPException(404, "Player not found")
    return db[discord_id]

@app.post("/roster")
async def add_player(data: PlayerCreate, source: str = Depends(require_client)):
    db = load("roster")
    if data.discord_id in db:
        raise HTTPException(409, "Player already on roster")
    db[data.discord_id] = {
        **data.dict(),
        "joined_at": now(),
        "source": source,
    }
    save("roster", db)
    await manager.broadcast("player_added", db[data.discord_id])
    return db[data.discord_id]

@app.patch("/roster/{discord_id}")
async def update_player(discord_id: str, data: PlayerUpdate, source: str = Depends(require_client)):
    db = load("roster")
    if discord_id not in db:
        raise HTTPException(404, "Player not found")
    for field, value in data.dict(exclude_none=True).items():
        db[discord_id][field] = value
    db[discord_id]["updated_at"] = now()
    db[discord_id]["source"] = source
    save("roster", db)
    await manager.broadcast("player_updated", db[discord_id])
    return db[discord_id]

@app.delete("/roster/{discord_id}")
async def remove_player(discord_id: str, source: str = Depends(require_client)):
    db = load("roster")
    if discord_id not in db:
        raise HTTPException(404, "Player not found")
    player = db.pop(discord_id)
    save("roster", db)
    await manager.broadcast("player_removed", {"discord_id": discord_id, "player": player, "source": source})
    return {"removed": True, "player": player}

# ─── STATS + AUTOMATIC POINTS ────────────────────────────────────────────────
@app.get("/stats")
def get_all_stats(status: Optional[str] = "approved"):
    """Returns match stat records. Public requests default to approved only."""
    db = load("stats")
    all_stats = []
    for player_id, matches in db.items():
        for match_id, record in matches.items():
            record_status = record.get("status", "approved")
            if status and record_status != status:
                continue
            all_stats.append({**record, "player_discord_id": player_id})
    return sorted(all_stats, key=lambda x: x.get("submitted_at", ""), reverse=True)

@app.get("/manager/stats")
def get_manager_stats(status: Optional[str] = None, source: str = Depends(require_client)):
    return get_all_stats(status=status)

@app.get("/stats/leaderboard")
def get_leaderboard():
    db = load("stats")
    roster = load("roster")
    tally = {}
    for player_id, matches in db.items():
        approved = [m for m in matches.values() if approved_match(m)]
        if not approved:
            continue
        pinfo = roster.get(player_id, {})
        username = pinfo.get("username", approved[0].get("player_username") or player_id)
        tally[player_id] = {
            "discord_id": player_id,
            "username": username,
            "position": pinfo.get("position", "—"),
            "overall": pinfo.get("overall", 0),
            "goals": sum(m.get("goals", 0) for m in approved),
            "assists": sum(m.get("assists", 0) for m in approved),
            "saves": sum(m.get("saves", 0) for m in approved),
            "shots": sum(m.get("shots", 0) for m in approved),
            "passes": sum(m.get("passes", 0) for m in approved),
            "tackles": sum(m.get("tackles", 0) for m in approved),
            "interceptions": sum(m.get("interceptions", 0) for m in approved),
            "matches": len(approved),
        }
    return sorted(tally.values(), key=lambda x: (x["goals"], x["assists"], x["saves"]), reverse=True)

@app.get("/stats/player/{discord_id}")
def get_player_stats(discord_id: str):
    db = load("stats")
    if discord_id not in db:
        raise HTTPException(404, "No stats found")
    approved = {match_id: record for match_id, record in db[discord_id].items() if approved_match(record)}
    if not approved:
        raise HTTPException(404, "No approved stats found")
    return approved

@app.get("/stats/match/{match_id}")
def get_match_stats(match_id: str):
    db = load("stats")
    records = []
    for player_id, matches in db.items():
        if match_id in matches and approved_match(matches[match_id]):
            records.append({**matches[match_id], "player_discord_id": player_id})
    if not records:
        raise HTTPException(404, "Match not found")
    return records

@app.post("/stats")
async def submit_stats(data: StatsCreate, source: str = Depends(require_client)):
    db = load("stats")
    pid = data.discord_id
    if pid not in db:
        db[pid] = {}
    existing = db[pid].get(data.match_id)
    if existing and existing.get("status", "approved") != "denied":
        raise HTTPException(409, "Stats for this player and Match ID already exist")
    roster_player = load("roster").get(pid, {})
    record = {
        **data.model_dump(),
        "player_username": data.player_username or roster_player.get("username") or data.discord_tag,
        "status": "pending",
        "submitted_at": now(),
        "reviewed_at": None,
        "reviewed_by": None,
        "points_awarded": 0,
        "points_breakdown": [],
        "source": source,
    }
    db[pid][data.match_id] = record
    save("stats", db)
    await manager.broadcast("stats_submitted", {**record, "player_discord_id": pid})
    return record

@app.patch("/stats/{discord_id}/{match_id}/review")
async def review_stats(discord_id: str, match_id: str, data: StatsReview, source: str = Depends(require_client)):
    db = load("stats")
    if discord_id not in db or match_id not in db[discord_id]:
        raise HTTPException(404, "Match report not found")
    record = db[discord_id][match_id]
    current = record.get("status", "approved")
    if current == "approved" and data.status == "denied":
        raise HTTPException(409, "Approved reports cannot be denied; use a manual points correction if needed")

    record["status"] = data.status
    record["reviewed_by"] = data.reviewed_by
    record["reviewed_at"] = now()
    record["source"] = source

    if data.status == "approved":
        total, breakdown = calculate_match_points(record)
        award = add_points(
            discord_id,
            record.get("player_username") or record.get("discord_tag") or discord_id,
            total,
            f"Approved match report vs {record.get('opponent', 'opponent')} ({match_id})",
            data.reviewed_by,
            category="match",
            reference_id=f"stats:{discord_id}:{match_id}",
        )
        record["points_awarded"] = total
        record["points_breakdown"] = breakdown
        record["points_balance"] = award["profile"]["balance"]
    else:
        record["points_awarded"] = 0
        record["points_breakdown"] = []

    db[discord_id][match_id] = record
    save("stats", db)
    payload = {**record, "player_discord_id": discord_id}
    await manager.broadcast("stats_reviewed", payload)
    return payload

# ─── POINTS ──────────────────────────────────────────────────────────────────
@app.get("/points/leaderboard")
def points_leaderboard():
    profiles = list(load("points").values())
    profiles.sort(key=lambda entry: int(entry.get("balance", 0)), reverse=True)
    return [{"discord_id": p.get("discord_id"), "username": p.get("username"), "balance": p.get("balance", 0)} for p in profiles]

@app.get("/points/{discord_id}")
def get_points(discord_id: str):
    profile = points_profile(discord_id, load("roster").get(discord_id, {}).get("username", ""))
    return {"discord_id": discord_id, "username": profile.get("username", discord_id), "balance": profile.get("balance", 0)}

@app.get("/points/{discord_id}/history")
def get_points_history(discord_id: str, source: str = Depends(require_client)):
    profile = points_profile(discord_id, load("roster").get(discord_id, {}).get("username", ""))
    return profile.get("history", [])

@app.post("/manager/points/adjust")
async def adjust_points(data: PointsAdjust, source: str = Depends(require_client)):
    result = add_points(data.discord_id, data.username, data.amount, data.reason, data.actor, category="manual")
    await manager.broadcast("points_updated", {**result["profile"], "source": source})
    return result

@app.post("/manager/points/set")
async def set_points(data: PointsSet, source: str = Depends(require_client)):
    current = points_profile(data.discord_id, data.username)
    difference = data.balance - int(current.get("balance", 0))
    result = add_points(data.discord_id, data.username, difference, data.reason, data.actor, category="manual-set")
    await manager.broadcast("points_updated", {**result["profile"], "source": source})
    return result

# ─── SHOP ────────────────────────────────────────────────────────────────────
@app.get("/shop")
def list_shop():
    return shop_catalog()

@app.get("/shop/inventory/{discord_id}")
def player_inventory(discord_id: str, source: str = Depends(require_client)):
    inventory = load("inventory").get(discord_id, [])
    return sorted(inventory, key=lambda item: item.get("fulfilled_at", ""), reverse=True)

@app.get("/shop/orders/player/{discord_id}")
def player_orders(discord_id: str, source: str = Depends(require_client)):
    orders = [order for order in load("shop_orders").values() if order.get("discord_id") == discord_id]
    return sorted(orders, key=lambda order: order.get("created_at", ""), reverse=True)

@app.get("/manager/shop/orders")
def manager_shop_orders(status: Optional[str] = None, source: str = Depends(require_client)):
    orders = list(load("shop_orders").values())
    if status:
        orders = [order for order in orders if order.get("status") == status]
    return sorted(orders, key=lambda order: order.get("created_at", ""), reverse=True)

@app.post("/shop/purchase")
async def purchase_shop_item(data: ShopPurchase, source: str = Depends(require_client)):
    item = get_shop_item(data.item_id)
    if not item:
        raise HTTPException(404, "Shop item not found")
    profile = points_profile(data.discord_id, data.username)
    if int(profile.get("balance", 0)) < int(item["price"]):
        raise HTTPException(400, f"You need {item['price']} points but only have {profile.get('balance', 0)}")
    order_id = new_id("ORDER-")
    deduction = add_points(
        data.discord_id,
        data.username,
        -int(item["price"]),
        f"Purchased {item['name']}",
        data.username,
        category="shop",
        reference_id=f"shop-purchase:{order_id}",
    )
    orders = load("shop_orders")
    order = {
        "id": order_id,
        "discord_id": data.discord_id,
        "username": data.username,
        "item_id": item["id"],
        "item_name": item["name"],
        "price": item["price"],
        "description": item["description"],
        "status": "pending",
        "created_at": now(),
        "reviewed_at": None,
        "reviewed_by": None,
        "manager_note": "",
        "source": source,
        "balance_after": deduction["profile"]["balance"],
    }
    orders[order_id] = order
    save("shop_orders", orders)
    await manager.broadcast("shop_order_created", order)
    return order

@app.patch("/manager/shop/orders/{order_id}")
async def review_shop_order(order_id: str, data: ShopOrderReview, source: str = Depends(require_client)):
    orders = load("shop_orders")
    if order_id not in orders:
        raise HTTPException(404, "Shop order not found")
    order = orders[order_id]
    if order.get("status") != "pending":
        raise HTTPException(409, "This order has already been reviewed")
    order["status"] = data.status
    order["reviewed_by"] = data.reviewed_by
    order["reviewed_at"] = now()
    order["manager_note"] = data.manager_note
    order["source"] = source
    if data.status == "fulfilled":
        inventory = load("inventory")
        items = inventory.setdefault(order["discord_id"], [])
        if not any(entry.get("order_id") == order_id for entry in items):
            items.append({
                "order_id": order_id,
                "item_id": order["item_id"],
                "item_name": order["item_name"],
                "price": order["price"],
                "fulfilled_at": now(),
            })
        save("inventory", inventory)
    else:
        refund = add_points(
            order["discord_id"], order["username"], int(order["price"]),
            f"Refund for rejected shop order: {order['item_name']}", data.reviewed_by,
            category="shop-refund", reference_id=f"shop-refund:{order_id}",
        )
        order["refund_balance"] = refund["profile"]["balance"]
    orders[order_id] = order
    save("shop_orders", orders)
    await manager.broadcast("shop_order_updated", order)
    return order

# ─── SUGGESTIONS + COMPLAINTS ────────────────────────────────────────────────
@app.post("/suggestions")
async def create_suggestion(data: SuggestionCreate, source: str = Depends(require_client)):
    db = load("suggestions")
    entry_id = new_id("SUG-")
    entry = {"id": entry_id, **data.model_dump(), "status": "pending", "reply": "", "private_note": "", "submitted_at": now(), "reviewed_at": None, "reviewed_by": None, "source": source}
    db[entry_id] = entry
    save("suggestions", db)
    await manager.broadcast("suggestion_created", entry)
    return entry

@app.get("/suggestions/player/{discord_id}")
def player_suggestions(discord_id: str, source: str = Depends(require_client)):
    entries = [entry for entry in load("suggestions").values() if entry.get("discord_id") == discord_id]
    return sorted(entries, key=lambda entry: entry.get("submitted_at", ""), reverse=True)

@app.get("/manager/suggestions")
def manager_suggestions(status: Optional[str] = None, source: str = Depends(require_client)):
    entries = list(load("suggestions").values())
    if status:
        entries = [entry for entry in entries if entry.get("status") == status]
    return sorted(entries, key=lambda entry: entry.get("submitted_at", ""), reverse=True)

@app.patch("/manager/suggestions/{entry_id}")
async def review_suggestion(entry_id: str, data: FeedbackReview, source: str = Depends(require_client)):
    valid = {"pending", "planned", "accepted", "declined", "implemented"}
    if data.status not in valid:
        raise HTTPException(400, f"Suggestion status must be one of: {sorted(valid)}")
    db = load("suggestions")
    if entry_id not in db:
        raise HTTPException(404, "Suggestion not found")
    entry = db[entry_id]
    entry.update({"status": data.status, "reviewed_by": data.reviewed_by, "reviewed_at": now(), "reply": data.reply, "private_note": data.private_note, "source": source})
    db[entry_id] = entry
    save("suggestions", db)
    await manager.broadcast("suggestion_updated", entry)
    return entry

@app.post("/complaints")
async def create_complaint(data: ComplaintCreate, source: str = Depends(require_client)):
    db = load("complaints")
    entry_id = new_id("CMP-")
    entry = {"id": entry_id, **data.model_dump(), "status": "pending", "reply": "", "private_note": "", "submitted_at": now(), "reviewed_at": None, "reviewed_by": None, "source": source}
    db[entry_id] = entry
    save("complaints", db)
    await manager.broadcast("complaint_created", entry)
    return entry

@app.get("/complaints/player/{discord_id}")
def player_complaints(discord_id: str, source: str = Depends(require_client)):
    entries = [entry for entry in load("complaints").values() if entry.get("discord_id") == discord_id]
    return sorted(entries, key=lambda entry: entry.get("submitted_at", ""), reverse=True)

@app.get("/manager/complaints")
def manager_complaints(status: Optional[str] = None, source: str = Depends(require_client)):
    entries = list(load("complaints").values())
    if status:
        entries = [entry for entry in entries if entry.get("status") == status]
    return sorted(entries, key=lambda entry: entry.get("submitted_at", ""), reverse=True)

@app.patch("/manager/complaints/{entry_id}")
async def review_complaint(entry_id: str, data: FeedbackReview, source: str = Depends(require_client)):
    valid = {"pending", "reviewing", "resolved", "dismissed"}
    if data.status not in valid:
        raise HTTPException(400, f"Complaint status must be one of: {sorted(valid)}")
    db = load("complaints")
    if entry_id not in db:
        raise HTTPException(404, "Complaint not found")
    entry = db[entry_id]
    entry.update({"status": data.status, "reviewed_by": data.reviewed_by, "reviewed_at": now(), "reply": data.reply, "private_note": data.private_note, "source": source})
    db[entry_id] = entry
    save("complaints", db)
    await manager.broadcast("complaint_updated", entry)
    return entry

# ─── PLAYER PORTAL ───────────────────────────────────────────────────────────
def _owned_entries(name: str, discord_id: str, time_key: str) -> list:
    entries = [entry for entry in load(name).values() if str(entry.get("discord_id")) == str(discord_id)]
    return sorted(entries, key=lambda entry: entry.get(time_key, ""), reverse=True)


def _player_scrim_view(scrim: dict, discord_id: str) -> dict:
    status = "missing"
    note = ""
    for key in ("going", "maybe", "cant"):
        raw = scrim.get(key, {}).get(discord_id)
        if raw is not None:
            status = key
            if isinstance(raw, dict):
                note = raw.get("note", "")
            break
    return {**scrim, "my_status": status, "my_note": note}


@app.get("/player/me")
def player_me(player: dict = Depends(require_player)):
    return {"discord_id": player["discord_id"], "username": player["username"]}


def _portal_match_result(scrim: dict) -> str:
    broadcast = scrim.get("broadcast") or {}
    home = int(broadcast.get("home_score", 0) or 0)
    away = int(broadcast.get("away_score", 0) or 0)
    if home > away:
        prefix = "W"
    elif home < away:
        prefix = "L"
    else:
        prefix = "D"
    return f"{prefix} {home}-{away}"


def _player_match_eligible(scrim: dict, discord_id: str) -> bool:
    """Use a published lineup when one exists; otherwise roster membership is enough.

    Manager approval remains the final guard for stats, so older matches that did not
    have a V5 lineup can still be reported without typing or copying a Match ID.
    """
    discord_id = str(discord_id)
    lineup = scrim.get("lineup_v2") or {}
    players = lineup.get("players") or []
    official = [p for p in players if p.get("slot") != "reserve"]
    if lineup.get("published") and official:
        return any(str(p.get("discord_id", "")) == discord_id for p in official)
    return discord_id in load("roster")


def _player_portal_match_rows(discord_id: str) -> list[dict]:
    stats_db = load("stats").get(str(discord_id), {})
    rows = []
    for scrim in get_scrims():
        if str(scrim.get("status", "")).lower() != "finished":
            continue
        if not _player_match_eligible(scrim, discord_id):
            continue
        report = stats_db.get(str(scrim.get("id")))
        rows.append({
            "id": str(scrim.get("id", "")),
            "opponent": scrim.get("opponent", "Opponent"),
            "match_type": scrim.get("match_type", "Match"),
            "match_time": scrim.get("match_time", ""),
            "result": _portal_match_result(scrim),
            "final_score": scrim.get("final_score") or f"{int((scrim.get('broadcast') or {}).get('home_score',0) or 0)}-{int((scrim.get('broadcast') or {}).get('away_score',0) or 0)}",
            "report": report,
            "can_submit": not report or report.get("status") == "denied",
        })
    return rows[:20]


def _player_portal_motm(discord_id: str) -> list[dict]:
    discord_id = str(discord_id)
    if discord_id not in load("roster"):
        return []
    rows = []
    for poll in get_motm_polls(active=True):
        voters = poll.get("voters") or {}
        rows.append({
            "id": poll.get("id"),
            "match_id": poll.get("match_id"),
            "opponent": poll.get("opponent", "Opponent"),
            "nominees": poll.get("nominees") or [],
            "my_vote": voters.get(discord_id),
            "can_vote": discord_id not in voters,
            "started_at": poll.get("started_at"),
        })
    return rows


def _player_pending_actions(discord_id: str) -> list[dict]:
    discord_id = str(discord_id)
    actions = []
    for scrim in get_scrims():
        status = str(scrim.get("status", "scheduled")).lower()
        if status in {"scheduled", "live"}:
            responded = any(discord_id in (scrim.get(key) or {}) for key in ("going", "maybe", "cant"))
            if not responded:
                actions.append({
                    "type": "availability", "priority": 1, "panel": "player-availability",
                    "title": f"Set availability vs {scrim.get('opponent','Opponent')}",
                    "detail": scrim.get("match_time") or "Match time TBD", "match_id": scrim.get("id"),
                })
    for row in _player_portal_match_rows(discord_id):
        if row.get("can_submit"):
            actions.append({
                "type": "stats", "priority": 2, "panel": "player-match-stats",
                "title": f"Submit stats vs {row.get('opponent','Opponent')}",
                "detail": row.get("result", "Finished match"), "match_id": row.get("id"),
            })
    for poll in _player_portal_motm(discord_id):
        if poll.get("can_vote"):
            actions.append({
                "type": "motm", "priority": 3, "panel": "player-motm",
                "title": f"Vote MOTM vs {poll.get('opponent','Opponent')}",
                "detail": "Voting is open", "match_id": poll.get("match_id"), "poll_id": poll.get("id"),
            })
    return sorted(actions, key=lambda a: (a.get("priority", 99), a.get("title", "")))


@app.get("/player/dashboard")
def player_dashboard(player: dict = Depends(require_player)):
    discord_id = str(player["discord_id"])
    roster = load("roster").get(discord_id, {})
    try:
        matches = list(get_player_stats(discord_id).values())
    except HTTPException:
        matches = []
    matches = sorted(matches, key=lambda match: match.get("submitted_at", ""), reverse=True)
    for match in matches:
        match.setdefault("card_rating_change", 0)
    points = points_profile(discord_id, roster.get("username") or player["username"])
    inventory = sorted(load("inventory").get(discord_id, []), key=lambda item: item.get("fulfilled_at", ""), reverse=True)
    orders = _owned_entries("shop_orders", discord_id, "created_at")
    return {
        "account": {"discord_id": discord_id, "username": player["username"]},
        "profile": roster,
        "points": {"balance": points.get("balance", 0), "history": points.get("history", [])[:30]},
        "matches": matches,
        "inventory": inventory,
        "orders": orders,
        "requests": _owned_entries("player_requests", discord_id, "created_at"),
        "conversations": _owned_entries("conversations", discord_id, "updated_at"),
        "suggestions": _owned_entries("suggestions", discord_id, "submitted_at"),
        "complaints": _owned_entries("complaints", discord_id, "submitted_at"),
        "scrims": [_player_scrim_view(scrim, discord_id) for scrim in get_scrims()],
        "shop": shop_catalog(),
        "pending_actions": _player_pending_actions(discord_id),
        "stat_matches": _player_portal_match_rows(discord_id),
        "motm_polls": _player_portal_motm(discord_id),
    }


@app.post("/player/stats")
async def player_submit_match_stats(data: PlayerPortalStatsSubmit, player: dict = Depends(require_player)):
    scrims = load("scrims")
    scrim = scrims.get(data.match_id)
    if not scrim:
        raise HTTPException(404, "Finished match not found")
    if str(scrim.get("status", "")).lower() != "finished":
        raise HTTPException(400, "Stats can only be submitted after the match is finished")
    discord_id = str(player["discord_id"])
    if not _player_match_eligible(scrim, discord_id):
        raise HTTPException(403, "You are not listed as a player for this match")
    roster_player = load("roster").get(discord_id, {})
    payload = StatsCreate(
        discord_id=discord_id,
        discord_tag=player.get("username", "Player"),
        player_username=roster_player.get("username") or player.get("username", "Player"),
        match_id=data.match_id,
        opponent=scrim.get("opponent", "Opponent"),
        result=_portal_match_result(scrim),
        goals=data.goals, assists=data.assists, saves=data.saves, shots=data.shots,
        passes=data.passes, tackles=data.tackles, interceptions=data.interceptions,
    )
    return await submit_stats(payload, source="player-portal")


def _record_motm_vote(poll_id: str, voter_id: str, voter_tag: str, nominee: str, source: str) -> dict:
    db = load("motm")
    if poll_id not in db:
        raise HTTPException(404, "Poll not found")
    poll = db[poll_id]
    if not poll.get("active"):
        raise HTTPException(400, "Voting has ended")
    voters = poll.setdefault("voters", {})
    nominees = poll.setdefault("nominees", list((poll.get("votes") or {}).keys()))
    votes = poll.setdefault("votes", {name: 0 for name in nominees})
    if voter_id in voters:
        raise HTTPException(409, "You already voted in this match")
    if nominee not in nominees:
        raise HTTPException(400, "Invalid nominee")
    votes[nominee] = votes.get(nominee, 0) + 1
    voters[voter_id] = nominee
    poll["source"] = source
    db[poll_id] = poll
    save("motm", db)
    return poll


@app.get("/player/motm")
def player_motm_polls(player: dict = Depends(require_player)):
    return _player_portal_motm(str(player["discord_id"]))


@app.post("/player/motm/{poll_id}/vote")
async def player_cast_motm_vote(poll_id: str, data: PlayerPortalMOTMVote, player: dict = Depends(require_player)):
    discord_id = str(player["discord_id"])
    if discord_id not in load("roster"):
        raise HTTPException(403, "Only rostered Project Azure players can vote")
    poll = _record_motm_vote(poll_id, discord_id, player.get("username", "Player"), data.nominee, "player-portal")
    await manager.broadcast("motm_vote_cast", poll)
    return {"ok": True, "my_vote": data.nominee, "poll_id": poll_id}


@app.get("/player/actions")
def player_actions(player: dict = Depends(require_player)):
    return _player_pending_actions(str(player["discord_id"]))


@app.get("/manager/action-center")
def manager_action_center(source: str = Depends(require_client)):
    roster = load("roster")
    pending_reports = get_all_stats(status="pending")
    active_polls = get_motm_polls(active=True)
    upcoming = []
    for scrim in get_scrims():
        if str(scrim.get("status", "scheduled")).lower() not in {"scheduled", "live"}:
            continue
        responded = set()
        for key in ("going", "maybe", "cant"):
            responded.update(str(x) for x in (scrim.get(key) or {}).keys())
        missing = [p for pid,p in roster.items() if str(pid) not in responded]
        upcoming.append({"id":scrim.get("id"),"opponent":scrim.get("opponent"),"match_time":scrim.get("match_time"),"missing":missing})
    return {
        "pending_reports": pending_reports,
        "active_motm": active_polls,
        "upcoming": upcoming,
        "counts": {
            "pending_reports": len(pending_reports),
            "active_motm": len(active_polls),
            "missing_availability": sum(len(x["missing"]) for x in upcoming),
        },
    }


@app.post("/player/shop/purchase")
async def player_shop_purchase(data: PlayerShopPurchase, player: dict = Depends(require_player)):
    return await purchase_shop_item(
        ShopPurchase(discord_id=str(player["discord_id"]), username=player["username"], item_id=data.item_id),
        source="player-portal",
    )


@app.post("/player/suggestions")
async def player_create_suggestion(data: PlayerSuggestionCreate, player: dict = Depends(require_player)):
    return await create_suggestion(
        SuggestionCreate(discord_id=str(player["discord_id"]), username=player["username"], category=data.category, message=data.message),
        source="player-portal",
    )


@app.post("/player/complaints")
async def player_create_complaint(data: PlayerComplaintCreate, player: dict = Depends(require_player)):
    return await create_complaint(
        ComplaintCreate(discord_id=str(player["discord_id"]), username=player["username"], category=data.category, message=data.message, attachment_url=data.attachment_url),
        source="player-portal",
    )


# ── Private talk-to-manager conversations ────────────────────────────────────
@app.get("/player/conversations")
def player_conversations(player: dict = Depends(require_player)):
    return _owned_entries("conversations", str(player["discord_id"]), "updated_at")


@app.post("/player/conversations")
async def create_player_conversation(data: PlayerConversationCreate, player: dict = Depends(require_player)):
    db = load("conversations")
    conversation_id = new_id("CHAT-")
    message = {
        "id": new_id("MSG-"), "sender_type": "player", "sender_name": player["username"],
        "message": data.message, "attachment_url": data.attachment_url, "created_at": now(),
    }
    conversation = {
        "id": conversation_id, "discord_id": str(player["discord_id"]), "username": player["username"],
        "subject": data.subject, "category": data.category, "status": "open", "assigned_to": "",
        "messages": [message], "created_at": now(), "updated_at": now(), "source": "player-portal",
    }
    db[conversation_id] = conversation
    save("conversations", db)
    await manager.broadcast("conversation_created", conversation)
    return conversation


@app.post("/conversations")
async def bot_create_conversation(data: BotConversationCreate, source: str = Depends(require_client)):
    return await create_player_conversation(
        PlayerConversationCreate(subject=data.subject, category=data.category, message=data.message, attachment_url=data.attachment_url),
        player={"discord_id": data.discord_id, "username": data.username},
    )


@app.get("/conversations/player/{discord_id}")
def bot_player_conversations(discord_id: str, source: str = Depends(require_client)):
    return _owned_entries("conversations", discord_id, "updated_at")


@app.get("/player/conversations/{conversation_id}")
def get_player_conversation(conversation_id: str, player: dict = Depends(require_player)):
    conversation = load("conversations").get(conversation_id)
    if not conversation or str(conversation.get("discord_id")) != str(player["discord_id"]):
        raise HTTPException(404, "Conversation not found")
    return conversation


@app.post("/player/conversations/{conversation_id}/messages")
async def player_conversation_message(conversation_id: str, data: ConversationMessageCreate, player: dict = Depends(require_player)):
    db = load("conversations")
    conversation = db.get(conversation_id)
    if not conversation or str(conversation.get("discord_id")) != str(player["discord_id"]):
        raise HTTPException(404, "Conversation not found")
    if conversation.get("status") == "closed":
        raise HTTPException(409, "This conversation is closed")
    message = {
        "id": new_id("MSG-"), "sender_type": "player", "sender_name": player["username"],
        "message": data.message, "attachment_url": data.attachment_url, "created_at": now(),
    }
    conversation.setdefault("messages", []).append(message)
    conversation["status"] = "open"
    conversation["updated_at"] = now()
    conversation["source"] = "player-portal"
    db[conversation_id] = conversation
    save("conversations", db)
    await manager.broadcast("conversation_message", {**conversation, "latest_message": message})
    return conversation


@app.get("/manager/conversations")
def manager_conversations(status: Optional[str] = None, source: str = Depends(require_client)):
    entries = list(load("conversations").values())
    if status:
        entries = [entry for entry in entries if entry.get("status") == status]
    return sorted(entries, key=lambda entry: entry.get("updated_at", ""), reverse=True)


@app.patch("/manager/conversations/{conversation_id}")
async def manager_update_conversation(conversation_id: str, data: ManagerConversationUpdate, source: str = Depends(require_client)):
    db = load("conversations")
    if conversation_id not in db:
        raise HTTPException(404, "Conversation not found")
    conversation = db[conversation_id]
    conversation["status"] = data.status
    conversation["assigned_to"] = data.assigned_to
    if data.reply.strip():
        message = {
            "id": new_id("MSG-"), "sender_type": "manager", "sender_name": data.manager_name,
            "message": data.reply.strip(), "attachment_url": "", "created_at": now(),
        }
        conversation.setdefault("messages", []).append(message)
        conversation["latest_message"] = message
    conversation["updated_at"] = now()
    conversation["source"] = source
    db[conversation_id] = conversation
    save("conversations", db)
    await manager.broadcast("conversation_updated", conversation)
    return conversation


# ── Request center ────────────────────────────────────────────────────────────
@app.get("/player/requests")
def player_requests(player: dict = Depends(require_player)):
    return _owned_entries("player_requests", str(player["discord_id"]), "created_at")


@app.post("/player/requests")
async def create_player_request(data: PlayerRequestCreate, player: dict = Depends(require_player)):
    db = load("player_requests")
    request_id = new_id("REQ-")
    entry = {
        "id": request_id, "discord_id": str(player["discord_id"]), "username": player["username"],
        "request_type": data.request_type, "details": data.details, "attachment_url": data.attachment_url,
        "status": "pending", "reply": "", "private_note": "", "created_at": now(),
        "reviewed_at": None, "reviewed_by": None, "source": "player-portal",
    }
    db[request_id] = entry
    save("player_requests", db)
    await manager.broadcast("player_request_created", entry)
    return entry


@app.post("/requests")
async def bot_create_request(data: BotRequestCreate, source: str = Depends(require_client)):
    return await create_player_request(
        PlayerRequestCreate(request_type=data.request_type, details=data.details, attachment_url=data.attachment_url),
        player={"discord_id": data.discord_id, "username": data.username},
    )


@app.get("/requests/player/{discord_id}")
def bot_player_requests(discord_id: str, source: str = Depends(require_client)):
    return _owned_entries("player_requests", discord_id, "created_at")


@app.get("/manager/requests")
def manager_requests(status: Optional[str] = None, source: str = Depends(require_client)):
    entries = list(load("player_requests").values())
    if status:
        entries = [entry for entry in entries if entry.get("status") == status]
    return sorted(entries, key=lambda entry: entry.get("created_at", ""), reverse=True)


@app.patch("/manager/requests/{request_id}")
async def manager_update_request(request_id: str, data: ManagerRequestUpdate, source: str = Depends(require_client)):
    db = load("player_requests")
    if request_id not in db:
        raise HTTPException(404, "Request not found")
    entry = db[request_id]
    entry.update({
        "status": data.status, "reviewed_by": data.reviewed_by, "reviewed_at": now(),
        "reply": data.reply, "private_note": data.private_note, "source": source,
    })
    db[request_id] = entry
    save("player_requests", db)
    await manager.broadcast("player_request_updated", entry)
    return entry


# ── Availability center / lineup ─────────────────────────────────────────────
@app.get("/player/availability")
def player_availability(player: dict = Depends(require_player)):
    return [_player_scrim_view(scrim, str(player["discord_id"])) for scrim in get_scrims()]


@app.post("/player/availability")
async def set_player_availability(data: PlayerAvailabilitySet, player: dict = Depends(require_player)):
    return await rsvp_scrim(
        data.scrim_id,
        ScrimRSVP(discord_id=str(player["discord_id"]), username=player["username"], status=data.status, note=data.note),
        x_client="website",
    )


@app.get("/manager/availability")
def manager_availability(source: str = Depends(require_client)):
    roster = list(load("roster").values())
    output = []
    for scrim in get_scrims():
        responded = set()
        groups = {}
        for status in ("going", "maybe", "cant"):
            groups[status] = []
            for discord_id, raw in scrim.get(status, {}).items():
                responded.add(str(discord_id))
                if isinstance(raw, dict):
                    groups[status].append({"discord_id": str(discord_id), "username": raw.get("username", discord_id), "note": raw.get("note", "")})
                else:
                    groups[status].append({"discord_id": str(discord_id), "username": raw, "note": ""})
        missing = [player for player in roster if str(player.get("discord_id")) not in responded]
        output.append({**scrim, "availability": groups, "missing": missing})
    return output


@app.patch("/manager/scrims/{scrim_id}/lineup")
async def manager_save_lineup(scrim_id: str, data: ManagerLineupUpdate, source: str = Depends(require_client)):
    db = load("scrims")
    if scrim_id not in db:
        raise HTTPException(404, "Match not found")
    scrim = db[scrim_id]
    scrim["lineup"] = data.lineup
    scrim["lineup_notes"] = data.notes
    scrim["lineup_updated_by"] = data.updated_by
    scrim["lineup_updated_at"] = now()
    scrim["source"] = source
    db[scrim_id] = scrim
    save("scrims", db)
    await manager.broadcast("lineup_updated", scrim)
    return scrim


@app.post("/manager/scrims/{scrim_id}/remind")
async def manager_remind_missing_availability(scrim_id: str, source: str = Depends(require_client)):
    db = load("scrims")
    if scrim_id not in db:
        raise HTTPException(404, "Match not found")
    scrim = db[scrim_id]
    responded = set()
    for status in ("going", "maybe", "cant"):
        responded.update(str(player_id) for player_id in scrim.get(status, {}).keys())
    missing = [
        {"discord_id": str(player.get("discord_id", "")), "username": player.get("username", "Player")}
        for player in load("roster").values()
        if str(player.get("discord_id", "")) not in responded and str(player.get("discord_id", "")).isdigit()
    ]
    payload = {**scrim, "missing": missing, "source": source}
    await manager.broadcast("availability_reminder_requested", payload)
    return {"sent_to": len(missing), "missing": missing}


def _scrim_participants(scrim_id: str) -> list[dict]:
    """Return only rostered players tied to this match through approved stats or its saved lineup.

    Existing JSON records are read as-is; this function does not migrate or rewrite them.
    """
    scrims = load("scrims")
    if scrim_id not in scrims:
        raise HTTPException(404, "Scrim not found")
    scrim = scrims[scrim_id]
    roster = load("roster")
    found: dict[str, dict] = {}

    # Approved match reports are the strongest proof that someone played.
    for discord_id, matches in load("stats").items():
        record = matches.get(scrim_id)
        if record and approved_match(record):
            roster_player = roster.get(discord_id, {})
            found[discord_id] = {
                "discord_id": discord_id,
                "username": roster_player.get("username") or record.get("player_username") or record.get("discord_tag") or discord_id,
                "position": roster_player.get("position", "Player"),
                "source": "approved_stats",
            }

    # The published/saved match lineup is also an official participant source.
    lineup = (scrim.get("lineup_v2") or {}).get("players") or []
    for player in lineup:
        discord_id = str(player.get("discord_id", "")).strip()
        if not discord_id or player.get("slot") == "reserve":
            continue
        roster_player = roster.get(discord_id, {})
        found.setdefault(discord_id, {
            "discord_id": discord_id,
            "username": roster_player.get("username") or player.get("username") or discord_id,
            "position": roster_player.get("position") or player.get("position") or "Player",
            "source": "lineup",
        })

    return sorted(found.values(), key=lambda player: str(player.get("username", "")).casefold())


# ─── MOTM ────────────────────────────────────────────────────────────────────
@app.get("/motm")
def get_motm_polls(active: Optional[bool] = None):
    db = load("motm")
    polls = list(db.values())
    if active is not None:
        polls = [p for p in polls if p.get("active") == active]
    return sorted(polls, key=lambda x: x.get("started_at", ""), reverse=True)

@app.get("/motm/{poll_id}")
def get_poll(poll_id: str):
    db = load("motm")
    if poll_id not in db:
        raise HTTPException(404, "Poll not found")
    return db[poll_id]

@app.post("/motm")
async def create_motm(data: MOTMCreate, source: str = Depends(require_client)):
    scrims = load("scrims")
    if data.match_id not in scrims:
        raise HTTPException(404, "Finished match not found")
    scrim = scrims[data.match_id]
    if str(scrim.get("status", "")).lower() != "finished":
        raise HTTPException(400, "MOTM voting can only start after the match is finished")

    participants = _scrim_participants(data.match_id)
    participant_by_name = {str(player["username"]).casefold(): player for player in participants}
    canonical_nominees = []
    nominee_ids = {}
    seen = set()
    for raw_name in data.nominees:
        key = str(raw_name).strip().casefold()
        player = participant_by_name.get(key)
        if not player:
            raise HTTPException(400, f"{raw_name} is not a saved participant for this match")
        name = str(player["username"]).strip()
        if name.casefold() in seen:
            continue
        seen.add(name.casefold())
        canonical_nominees.append(name)
        nominee_ids[name] = str(player["discord_id"])

    if len(canonical_nominees) < 2:
        raise HTTPException(400, "At least two match participants are required for MOTM voting")
    if len(canonical_nominees) > 25:
        raise HTTPException(400, "Discord MOTM voting supports up to 25 match participants")

    db = load("motm")
    if any(poll.get("active") and str(poll.get("match_id")) == data.match_id for poll in db.values()):
        raise HTTPException(409, "An active MOTM vote already exists for this match")

    poll_id = new_id("MOTM")
    db[poll_id] = {
        "id": poll_id,
        "match_id": data.match_id,
        "opponent": scrim.get("opponent") or data.opponent,
        "nominees": canonical_nominees,
        "nominee_ids": nominee_ids,
        "votes": {name: 0 for name in canonical_nominees},
        "voters": {},
        "active": True,
        "started_by": data.started_by,
        "started_at": now(),
        "winner": None,
        "source": source,
    }
    save("motm", db)
    await manager.broadcast("motm_started", db[poll_id])
    return db[poll_id]


@app.post("/motm/{poll_id}/vote")
async def cast_vote(poll_id: str, data: MOTMVote, x_client: str = Header(None)):
    # V6 Portal-First: browser/Discord player voting moved to authenticated /player/motm.
    raise HTTPException(status_code=410, detail="MOTM voting has moved to the secure Player Portal")

@app.post("/motm/{poll_id}/close")
async def close_motm(poll_id: str, source: str = Depends(require_client)):
    db = load("motm")
    if poll_id not in db:
        raise HTTPException(404, "Poll not found")
    poll = db[poll_id]
    was_active = bool(poll.get("active"))
    poll["active"] = False
    if poll["votes"] and sum(poll["votes"].values()) > 0:
        winner = max(poll["votes"], key=lambda k: poll["votes"][k])
        poll["winner"] = winner
        winner_id = str((poll.get("nominee_ids") or {}).get(winner, ""))
        roster_player = load("roster").get(winner_id) if winner_id else find_roster_player_by_username(winner)
        if roster_player:
            player_id = winner_id or roster_player["discord_id"]
            award = add_points(
                player_id, roster_player.get("username", winner), POINT_RULES["motm"],
                f"Man of the Match vs {poll.get('opponent', 'opponent')}", poll.get("started_by", "Management"),
                category="motm", reference_id=f"motm:{poll_id}",
            )
            poll["motm_points_awarded"] = POINT_RULES["motm"]
            poll["winner_discord_id"] = player_id
            poll["winner_points_balance"] = award["profile"]["balance"]
    poll["source"] = source
    db[poll_id] = poll
    save("motm", db)
    if was_active:
        await manager.broadcast("motm_closed", poll)
    return poll

# ─── SCRIMS ──────────────────────────────────────────────────────────────────
@app.get("/scrims")
def get_scrims():
    db = load("scrims")
    return sorted(db.values(), key=lambda x: x.get("created_at", ""), reverse=True)

@app.get("/scrims/{scrim_id}")
def get_scrim(scrim_id: str):
    db = load("scrims")
    if scrim_id not in db:
        raise HTTPException(404, "Scrim not found")
    return db[scrim_id]

@app.get("/scrims/{scrim_id}/participants")
def get_scrim_participants(scrim_id: str):
    return _scrim_participants(scrim_id)

@app.post("/scrims")
async def create_scrim(data: ScrimCreate, source: str = Depends(require_client)):
    db = load("scrims")
    scrim_id = new_id("SC")
    try:
        match_type = normalize_match_type(data.match_type)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    payload = data.model_dump()
    payload["match_type"] = match_type

    # Website posts must have their matching Discord route configured first.
    # This prevents the portal from claiming a post succeeded when there is
    # nowhere approved to send it.
    if source == "website":
        settings_rows = list(load("scrim_channels").values())
        channel_key = "friendly_channel_id" if match_type == "Friendly" else "league_channel_id"
        route_ready = any(str(row.get(channel_key, "")).strip().isdigit() for row in settings_rows)
        if not route_ready:
            expected = "friendly-ticks" if match_type == "Friendly" else "league-ticks"
            raise HTTPException(400, f"The {expected} channel is not configured yet. Set the scrim channels in Discord first.")

    db[scrim_id] = {
        "id": scrim_id,
        **payload,
        "going": {},
        "maybe": {},
        "cant": {},
        "status": "scheduled",
        "lineup_v2": {"players": [], "tactics": LineupTactics().model_dump(), "notes": "", "published": False},
        "broadcast": {"active": False, "phase": "pre_match", "home_score": 0, "away_score": 0, "events": []},
        "discord_channel_id": "",
        "discord_message_id": "",
        "created_at": now(),
        "source": source,
    }
    save("scrims", db)
    await manager.broadcast("scrim_created", db[scrim_id])
    return db[scrim_id]

@app.post("/scrims/{scrim_id}/rsvp")
async def rsvp_scrim(scrim_id: str, data: ScrimRSVP, x_client: str = Header(None)):
    db = load("scrims")
    if scrim_id not in db:
        raise HTTPException(404, "Scrim not found")
    scrim = db[scrim_id]
    valid = {"going", "maybe", "cant"}
    if data.status not in valid:
        raise HTTPException(400, f"Status must be one of: {valid}")
    for key in valid:
        scrim.setdefault(key, {}).pop(data.discord_id, None)
    scrim[data.status][data.discord_id] = {"username": data.username, "note": data.note, "updated_at": now()}
    scrim["updated_at"] = now()
    scrim["source"] = "bot" if x_client == "bot" else "website"
    db[scrim_id] = scrim
    save("scrims", db)
    await manager.broadcast("scrim_rsvp", scrim)
    return scrim

@app.delete("/scrims/{scrim_id}")
async def delete_scrim(scrim_id: str, source: str = Depends(require_client)):
    db = load("scrims")
    if scrim_id not in db:
        raise HTTPException(404, "Scrim not found")
    db.pop(scrim_id)
    save("scrims", db)
    await manager.broadcast("scrim_deleted", {"id": scrim_id, "source": source})
    return {"deleted": True}


@app.get("/scrims/settings/{guild_id}")
def get_scrim_channel_settings(guild_id: str, source: str = Depends(require_client)):
    if not re.fullmatch(r"\d{15,22}", guild_id):
        raise HTTPException(400, "Invalid Discord server ID")
    db = load("scrim_channels")
    return db.get(guild_id, {
        "guild_id": guild_id,
        "league_channel_id": "",
        "friendly_channel_id": "",
        "league_channel_name": "league-ticks",
        "friendly_channel_name": "friendly-ticks",
        "configured": False,
    })


@app.put("/scrims/settings/{guild_id}")
def set_scrim_channel_settings(
    guild_id: str,
    data: ScrimChannelSettingsUpdate,
    source: str = Depends(require_client),
):
    if not re.fullmatch(r"\d{15,22}", guild_id):
        raise HTTPException(400, "Invalid Discord server ID")
    db = load("scrim_channels")
    record = {
        "guild_id": guild_id,
        **data.dict(),
        "configured": True,
        "updated_at": now(),
        "source": source,
    }
    db[guild_id] = record
    save("scrim_channels", db)
    return record

# ─── ANNOUNCEMENTS ───────────────────────────────────────────────────────────
@app.get("/announcements")
def get_announcements():
    db = load("announcements")
    return sorted(db.values(), key=lambda x: x.get("posted_at", ""), reverse=True)[:20]

@app.post("/announcements")
async def post_announcement(data: AnnouncementCreate, source: str = Depends(require_client)):
    db = load("announcements")
    ann_id = new_id("ANN")
    db[ann_id] = {
        "id": ann_id,
        **data.dict(),
        "posted_at": now(),
        "source": source,
    }
    save("announcements", db)
    await manager.broadcast("announcement_posted", db[ann_id])
    return db[ann_id]

# ─── CHANNEL REGISTRY (so the website's announce form can list real channels)
@app.get("/announcements/channels")
def list_channel_targets():
    """Channel name -> id map, last reported by the bot on startup/guild join."""
    return load("channels")

@app.put("/announcements/channels")
def set_channel_targets(channels: dict, source: str = Depends(require_client)):
    save("channels", channels)
    return {"saved": True, "count": len(channels)}

# ─── ACTIVITY REVIEW / KICK WAVE ─────────────────────────────────────────────
class ActivityMessageRecord(BaseModel):
    guild_id: str = Field(pattern=r"^\d{15,22}$")
    discord_id: str = Field(pattern=r"^\d{15,22}$")
    username: str = Field(min_length=1, max_length=100)
    occurred_at: str = Field(default="", max_length=80)


class ActivityMemberSnapshot(BaseModel):
    discord_id: str = Field(pattern=r"^\d{15,22}$")
    username: str = Field(min_length=1, max_length=100)
    display_name: str = Field(default="", max_length=100)
    joined_at: str = Field(default="", max_length=80)
    role_names: List[str] = Field(default_factory=list)
    role_ids: List[str] = Field(default_factory=list)
    administrator: bool = False
    owner: bool = False
    bot: bool = False


class ActivityMemberSync(BaseModel):
    guild_id: str = Field(pattern=r"^\d{15,22}$")
    guild_name: str = Field(default="Discord Server", max_length=120)
    members: List[ActivityMemberSnapshot]


class ActivityActionCreate(BaseModel):
    guild_id: str = Field(pattern=r"^\d{15,22}$")
    discord_id: str = Field(pattern=r"^\d{15,22}$")
    username: str = Field(min_length=1, max_length=100)
    action: str = Field(pattern=r"^(warn|kick|skip|protect|unprotect)$")
    manager_name: str = Field(min_length=1, max_length=100)
    reason: str = Field(default="", max_length=500)


class ActivityActionComplete(BaseModel):
    status: str = Field(pattern=r"^(completed|failed)$")
    detail: str = Field(default="", max_length=500)


def _parse_iso(value: str) -> Optional[datetime]:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return None


def _last_match_times() -> dict:
    output = {}
    for discord_id, records in load("stats").items():
        for record in records.values():
            if not approved_match(record):
                continue
            stamp = record.get("reviewed_at") or record.get("submitted_at") or ""
            if stamp and stamp > output.get(str(discord_id), ""):
                output[str(discord_id)] = stamp
    return output


def _last_availability_times() -> dict:
    output = {}
    for scrim in load("scrims").values():
        for status in ("going", "maybe", "cant"):
            for discord_id, raw in scrim.get(status, {}).items():
                stamp = raw.get("updated_at", "") if isinstance(raw, dict) else ""
                stamp = stamp or scrim.get("updated_at") or scrim.get("created_at") or ""
                if stamp and stamp > output.get(str(discord_id), ""):
                    output[str(discord_id)] = stamp
    return output


def _is_manager_member(member: dict) -> bool:
    if member.get("owner") or member.get("administrator"):
        return True
    role_names = {normalize_role_name(name) for name in member.get("role_names", [])}
    if {normalize_role_name(name) for name in DEFAULT_MANAGER_ROLES} & role_names:
        return True
    configured_ids = {str(role.get("role_id", "")) for role in load("manager_roles").values()}
    return bool(configured_ids & {str(role_id) for role_id in member.get("role_ids", [])})


@app.post("/activity/message")
def record_message_activity(data: ActivityMessageRecord, source: str = Depends(require_client)):
    db = load("activity")
    key = f"{data.guild_id}:{data.discord_id}"
    entry = db.get(key, {"guild_id": data.guild_id, "discord_id": data.discord_id, "message_count": 0})
    entry.update({
        "username": data.username,
        "last_message_at": data.occurred_at or now(),
        "updated_at": now(),
    })
    entry["message_count"] = int(entry.get("message_count", 0)) + 1
    db[key] = entry
    save("activity", db)
    return entry


@app.post("/activity/members/sync")
def sync_activity_members(data: ActivityMemberSync, source: str = Depends(require_client)):
    db = load("activity_members")
    seen = set()
    for member in data.members:
        raw = member.model_dump()
        key = f"{data.guild_id}:{member.discord_id}"
        seen.add(key)
        db[key] = {
            **db.get(key, {}), **raw,
            "guild_id": data.guild_id, "guild_name": data.guild_name,
            "synced_at": now(),
        }
    # Remove people no longer in this guild so the website does not show stale members.
    for key in [key for key, value in db.items() if value.get("guild_id") == data.guild_id and key not in seen]:
        db.pop(key, None)
    save("activity_members", db)
    return {"synced": len(data.members)}


@app.get("/manager/activity/guilds")
def activity_guilds(source: str = Depends(require_client)):
    guilds = {}
    for member in load("activity_members").values():
        gid = str(member.get("guild_id", ""))
        if gid:
            guilds[gid] = member.get("guild_name") or gid
    return [{"guild_id": gid, "guild_name": name} for gid, name in sorted(guilds.items(), key=lambda item: item[1].casefold())]


@app.get("/manager/activity/candidates")
def activity_candidates(guild_id: str, inactivity_days: int = 30, source: str = Depends(require_client)):
    inactivity_days = max(7, min(int(inactivity_days), 365))
    current = datetime.now(timezone.utc)
    cutoff = current.timestamp() - inactivity_days * 86400
    grace_cutoff = current.timestamp() - 14 * 86400
    activity = load("activity")
    protected = load("activity_protected")
    actions = load("activity_actions")
    last_matches = _last_match_times()
    last_availability = _last_availability_times()
    candidates = []

    for key, member in load("activity_members").items():
        if str(member.get("guild_id")) != str(guild_id):
            continue
        discord_id = str(member.get("discord_id", ""))
        if member.get("bot") or _is_manager_member(member) or f"{guild_id}:{discord_id}" in protected:
            continue
        joined = _parse_iso(member.get("joined_at", ""))
        if joined and joined.timestamp() > grace_cutoff:
            continue
        record = activity.get(f"{guild_id}:{discord_id}", {})
        stamps = [
            member.get("joined_at", ""), record.get("last_message_at", ""),
            last_matches.get(discord_id, ""), last_availability.get(discord_id, ""),
        ]
        parsed = [value for value in (_parse_iso(stamp) for stamp in stamps) if value]
        last_active = max(parsed) if parsed else None
        if last_active and last_active.timestamp() > cutoff:
            continue
        warnings = [a for a in actions.values() if a.get("guild_id") == guild_id and a.get("discord_id") == discord_id and a.get("action") == "warn" and a.get("status") == "completed"]
        candidates.append({
            **member,
            "last_message_at": record.get("last_message_at", ""),
            "last_match_at": last_matches.get(discord_id, ""),
            "last_availability_at": last_availability.get(discord_id, ""),
            "last_active_at": last_active.isoformat() if last_active else "",
            "inactive_days": int((current - last_active).total_seconds() // 86400) if last_active else None,
            "warning_count": len(warnings),
            "last_warning_at": max((a.get("created_at", "") for a in warnings), default=""),
        })
    candidates.sort(key=lambda item: item.get("last_active_at") or "")
    return candidates


@app.get("/manager/activity/actions")
def activity_actions(guild_id: Optional[str] = None, action: Optional[str] = None, source: str = Depends(require_client)):
    entries = list(load("activity_actions").values())
    if guild_id:
        entries = [entry for entry in entries if entry.get("guild_id") == guild_id]
    if action:
        entries = [entry for entry in entries if entry.get("action") == action]
    return sorted(entries, key=lambda entry: entry.get("created_at", ""), reverse=True)


@app.get("/manager/activity/protected")
def activity_protected(guild_id: str, source: str = Depends(require_client)):
    return sorted(
        [entry for entry in load("activity_protected").values() if entry.get("guild_id") == guild_id],
        key=lambda entry: entry.get("protected_at", ""), reverse=True,
    )


@app.post("/manager/activity/protect")
def protect_activity_member(data: ActivityActionCreate, source: str = Depends(require_client)):
    db = load("activity_protected")
    key = f"{data.guild_id}:{data.discord_id}"
    db[key] = {
        "guild_id": data.guild_id, "discord_id": data.discord_id, "username": data.username,
        "protected_by": data.manager_name, "reason": data.reason, "protected_at": now(),
    }
    save("activity_protected", db)
    return db[key]


@app.delete("/manager/activity/protect/{guild_id}/{discord_id}")
def unprotect_activity_member(guild_id: str, discord_id: str, source: str = Depends(require_client)):
    db = load("activity_protected")
    removed = db.pop(f"{guild_id}:{discord_id}", None)
    save("activity_protected", db)
    return {"removed": bool(removed)}


@app.post("/manager/activity/action")
async def request_activity_action(data: ActivityActionCreate, source: str = Depends(require_client)):
    if data.action not in {"warn", "kick"}:
        raise HTTPException(400, "Website actions may only request warn or kick")
    db = load("activity_actions")
    action_id = new_id("ACT-")
    entry = {
        "id": action_id, **data.model_dump(), "status": "pending", "detail": "",
        "created_at": now(), "source": source,
    }
    db[action_id] = entry
    save("activity_actions", db)
    await manager.broadcast("activity_action_requested", entry)
    return entry


@app.post("/activity/action/log")
def log_activity_action(data: ActivityActionCreate, source: str = Depends(require_client)):
    db = load("activity_actions")
    action_id = new_id("ACT-")
    entry = {
        "id": action_id, **data.model_dump(), "status": "completed", "detail": data.reason,
        "created_at": now(), "completed_at": now(), "source": source,
    }
    db[action_id] = entry
    save("activity_actions", db)
    return entry


@app.patch("/activity/action/{action_id}/complete")
def complete_activity_action(action_id: str, data: ActivityActionComplete, source: str = Depends(require_client)):
    db = load("activity_actions")
    if action_id not in db:
        raise HTTPException(404, "Activity action not found")
    db[action_id]["status"] = data.status
    db[action_id]["detail"] = data.detail
    db[action_id]["completed_at"] = now()
    save("activity_actions", db)
    return db[action_id]


# ─── WELCOMER CONFIGURATION ──────────────────────────────────────────────────
class WelcomeConfigUpdate(BaseModel):
    enabled: bool = True
    welcome_channel_id: str = Field(default="", max_length=22)
    welcome_message: str = Field(default="Welcome {user} to {server}! You are member #{member_count}.", max_length=1500)
    image_enabled: bool = True
    dm_enabled: bool = False
    dm_message: str = Field(default="Welcome to {server}! Use /portal login to access your dashboard.", max_length=1500)
    auto_role_ids: List[str] = Field(default_factory=list)
    goodbye_enabled: bool = False
    goodbye_channel_id: str = Field(default="", max_length=22)
    goodbye_message: str = Field(default="{username} has left {server}.", max_length=1500)
    rules_url: str = Field(default="", max_length=1000)
    portal_url: str = Field(default="", max_length=1000)


class WelcomeTestRequest(BaseModel):
    user_id: str = Field(pattern=r"^\d{15,22}$")


def default_welcome_config(guild_id: str) -> dict:
    return {
        "guild_id": guild_id, "enabled": False, "welcome_channel_id": "",
        "welcome_message": "Welcome {user} to {server}! You are member #{member_count}.",
        "image_enabled": True, "dm_enabled": False,
        "dm_message": "Welcome to {server}! Use /portal login to access your dashboard.",
        "auto_role_ids": [], "goodbye_enabled": False, "goodbye_channel_id": "",
        "goodbye_message": "{username} has left {server}.", "rules_url": "", "portal_url": "",
    }


@app.get("/manager/welcome/{guild_id}")
def get_welcome_config(guild_id: str, source: str = Depends(require_client)):
    return {**default_welcome_config(guild_id), **load("welcome_config").get(guild_id, {})}


@app.put("/manager/welcome/{guild_id}")
def update_welcome_config(guild_id: str, data: WelcomeConfigUpdate, source: str = Depends(require_client)):
    db = load("welcome_config")
    entry = {"guild_id": guild_id, **data.model_dump(), "updated_at": now(), "source": source}
    entry["auto_role_ids"] = [role_id.strip() for role_id in entry.get("auto_role_ids", []) if str(role_id).strip().isdigit()]
    db[guild_id] = entry
    save("welcome_config", db)
    return entry


@app.post("/manager/welcome/{guild_id}/test")
async def request_welcome_test(guild_id: str, data: WelcomeTestRequest, source: str = Depends(require_client)):
    payload = {"guild_id": guild_id, "user_id": data.user_id, "source": source}
    await manager.broadcast("welcome_test_requested", payload)
    return {"requested": True, **payload}


# ─── V5 CLUB, LINEUP, BROADCAST, AND PUBLIC PROFILE API ─────────────────────
def _result_tuple(result: str) -> Optional[tuple[int, int]]:
    match = re.search(r"(\d+)\s*[-:]\s*(\d+)", str(result or ""))
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def _result_code(result: str) -> str:
    text = str(result or "").strip().upper()
    if text.startswith("W"):
        return "W"
    if text.startswith("D"):
        return "D"
    if text.startswith("L"):
        return "L"
    score = _result_tuple(text)
    if not score:
        return "—"
    return "W" if score[0] > score[1] else "L" if score[0] < score[1] else "D"


def _approved_team_matches() -> list[dict]:
    """One team match per match_id, even when several players submitted stats."""
    seen: dict[str, dict] = {}
    for discord_id, matches in load("stats").items():
        for match_id, record in matches.items():
            if not approved_match(record):
                continue
            key = str(record.get("match_id") or match_id)
            current = seen.get(key)
            candidate = {**record, "match_id": key, "player_discord_id": discord_id}
            if current is None or str(candidate.get("reviewed_at", "")) < str(current.get("reviewed_at", "")):
                seen[key] = candidate
    return sorted(seen.values(), key=lambda m: m.get("reviewed_at") or m.get("submitted_at") or "")


def _wdl_payload(matches: Optional[list[dict]] = None) -> dict:
    matches = matches if matches is not None else _approved_team_matches()
    wins = draws = losses = goals_for = goals_against = 0
    form = []
    for match in matches:
        code = _result_code(match.get("result", ""))
        if code == "W": wins += 1
        elif code == "D": draws += 1
        elif code == "L": losses += 1
        form.append(code)
        score = _result_tuple(match.get("result", ""))
        if score:
            goals_for += score[0]
            goals_against += score[1]
    total = wins + draws + losses
    return {
        "wins": wins, "draws": draws, "losses": losses, "matches": total,
        "win_percentage": round((wins / total) * 100, 1) if total else 0,
        "goals_for": goals_for, "goals_against": goals_against,
        "goal_difference": goals_for - goals_against,
        "form": form[-5:],
    }


def _profile_key(discord_id: str) -> str:
    return hmac.new(MANAGER_SESSION_SECRET.encode("utf-8"), f"profile:{discord_id}".encode("utf-8"), hashlib.sha256).hexdigest()[:20]


def _player_public_profile(discord_id: str) -> dict:
    roster = load("roster")
    if discord_id not in roster:
        raise HTTPException(404, "Player not found on roster")
    player = dict(roster[discord_id])
    records = [r for r in load("stats").get(discord_id, {}).values() if approved_match(r)]
    records.sort(key=lambda r: r.get("reviewed_at") or r.get("submitted_at") or "", reverse=True)
    totals = {
        "matches": len(records),
        "goals": sum(int(r.get("goals", 0)) for r in records),
        "assists": sum(int(r.get("assists", 0)) for r in records),
        "saves": sum(int(r.get("saves", 0)) for r in records),
        "shots": sum(int(r.get("shots", 0)) for r in records),
        "passes": sum(int(r.get("passes", 0)) for r in records),
        "tackles": sum(int(r.get("tackles", 0)) for r in records),
        "interceptions": sum(int(r.get("interceptions", 0)) for r in records),
        "clean_sheets": sum(1 for r in records if (_result_tuple(r.get("result", "")) or (None, None))[1] == 0),
    }
    points = points_profile(discord_id, player.get("username", ""))
    point_history = points.get("history", [])
    totals["motm"] = sum(1 for h in point_history if h.get("category") == "motm" and int(h.get("amount", 0)) > 0)
    inventory = [o for o in load("shop_orders").values() if str(o.get("discord_id")) == discord_id and o.get("status") == "fulfilled"]
    awards = [a for a in load("awards").values() if str(a.get("discord_id", "")) == discord_id or str(a.get("winner", "")).casefold() == str(player.get("username", "")).casefold()]
    career = [e for e in load("career_events").values() if str(e.get("discord_id", "")) == discord_id]
    safe_player = {k: player.get(k) for k in ("discord_tag", "username", "position", "overall", "status", "joined_at", "title", "bio", "emoji")}
    safe_player["profile_key"] = _profile_key(discord_id)
    return {
        "player": safe_player,
        "totals": totals,
        "points": int(points.get("balance", 0)),
        "recent_form": [_result_code(r.get("result", "")) for r in reversed(records[:5])],
        "recent_matches": records[:10],
        "inventory": [{"item_id": x.get("item_id"), "item_name": x.get("item_name"), "fulfilled_at": x.get("reviewed_at")} for x in inventory],
        "awards": sorted(awards, key=lambda x: x.get("awarded_at", ""), reverse=True),
        "career": sorted(career, key=lambda x: x.get("created_at", ""), reverse=True),
    }


def _next_match() -> Optional[dict]:
    scrims = [s for s in load("scrims").values() if s.get("status", "scheduled") in {"scheduled", "live"}]
    # Match time is free text, so created_at is the stable fallback ordering.
    scrims.sort(key=lambda x: (0 if x.get("status") == "live" else 1, x.get("created_at", "")))
    return scrims[0] if scrims else None


def _club_records() -> dict:
    leaderboard = get_leaderboard()
    matches = _approved_team_matches()
    wdl = _wdl_payload(matches)
    longest = current = 0
    biggest = None
    for match in matches:
        if _result_code(match.get("result", "")) == "W":
            current += 1
            longest = max(longest, current)
        else:
            current = 0
        score = _result_tuple(match.get("result", ""))
        if score and score[0] > score[1]:
            margin = score[0] - score[1]
            if biggest is None or margin > biggest[0]:
                biggest = (margin, match)
    return {
        "wdl": wdl,
        "top_scorer": leaderboard[0] if leaderboard else None,
        "top_assist": max(leaderboard, key=lambda x: x.get("assists", 0)) if leaderboard else None,
        "most_appearances": max(leaderboard, key=lambda x: x.get("matches", 0)) if leaderboard else None,
        "longest_win_streak": longest,
        "biggest_win": biggest[1] if biggest else None,
    }


@app.get("/storage/status")
def storage_status(source: str = Depends(require_client)):
    test_path = DATA_DIR / ".pja-write-test"
    try:
        test_path.write_text(now())
        writable = test_path.exists()
        test_path.unlink(missing_ok=True)
    except Exception as exc:
        return {"path": str(DATA_DIR), "writable": False, "error": str(exc), "files": []}
    return {
        "path": str(DATA_DIR), "writable": writable,
        "files": sorted([p.name for p in DATA_DIR.glob("*.json")]),
        "roster_exists": (DATA_DIR / "roster.json").exists(),
    }


@app.get("/public/roster")
def public_roster():
    output = []
    for discord_id, player in load("roster").items():
        output.append({
            "profile_key": _profile_key(str(discord_id)),
            "username": player.get("username", "Player"),
            "discord_tag": player.get("discord_tag", ""),
            "position": player.get("position", "Player"),
            "overall": player.get("overall", 0),
            "status": player.get("status", "Active"),
            "joined_at": player.get("joined_at", ""),
            "title": player.get("title", ""),
            "emoji": player.get("emoji", ""),
        })
    return output


@app.get("/public/profiles/{profile_key}")
def public_profile_by_key(profile_key: str):
    for discord_id in load("roster").keys():
        if hmac.compare_digest(_profile_key(str(discord_id)), profile_key):
            return _player_public_profile(str(discord_id))
    raise HTTPException(404, "Player profile not found")


@app.get("/public/players/{discord_id}")
def public_player_profile(discord_id: str, source: str = Depends(require_client)):
    return _player_public_profile(discord_id)


@app.get("/team/wdl")
def team_wdl():
    return _wdl_payload()


@app.get("/team/next-match")
def team_next_match():
    match = _next_match()
    return {"match": match}


@app.get("/team/dynasty")
def team_dynasty():
    return {
        "active_season": next((s for s in load("seasons").values() if s.get("status") == "active"), None),
        "seasons": sorted(load("seasons").values(), key=lambda x: x.get("started_at", ""), reverse=True),
        "trophies": sorted(load("trophies").values(), key=lambda x: x.get("added_at", ""), reverse=True),
        "awards": sorted(load("awards").values(), key=lambda x: x.get("awarded_at", ""), reverse=True),
        "records": _club_records(),
    }


@app.get("/team/rivalry/{opponent}")
def team_rivalry(opponent: str):
    matches = [m for m in _approved_team_matches() if str(m.get("opponent", "")).casefold() == opponent.casefold()]
    return {"opponent": opponent, "record": _wdl_payload(matches), "matches": list(reversed(matches))}


@app.get("/team/career/{discord_id}")
def team_career(discord_id: str, source: str = Depends(require_client)):
    return _player_public_profile(discord_id)


@app.get("/lineup/next")
def next_published_lineup():
    match = _next_match()
    if not match:
        return {"status": "no_match", "match": None, "lineup": None}
    lineup = match.get("lineup_v2") or {}
    if not lineup.get("published"):
        return {"status": "not_published", "match": match, "lineup": None}
    return {"status": "published", "match": match, "lineup": lineup}


@app.patch("/manager/scrims/{scrim_id}/lineup-v2")
async def save_lineup_v2(scrim_id: str, data: LineupV2Update, source: str = Depends(require_client)):
    db = load("scrims")
    if scrim_id not in db:
        raise HTTPException(404, "Match not found")
    ids = [p.discord_id for p in data.players]
    if len(ids) != len(set(ids)):
        raise HTTPException(400, "A player cannot appear twice in one lineup")
    starters = [p for p in data.players if p.slot == "starter"]
    if len(starters) > 11:
        raise HTTPException(400, "A lineup may have at most 11 starters")
    lineup = {
        "players": [p.model_dump() for p in data.players],
        "tactics": data.tactics.model_dump(),
        "notes": data.notes,
        "published": data.published,
        "updated_by": data.updated_by,
        "updated_at": now(),
    }
    db[scrim_id]["lineup_v2"] = lineup
    db[scrim_id]["lineup"] = "\n".join(f"{p.username} — {p.position}" for p in starters)
    db[scrim_id]["lineup_updated_at"] = lineup["updated_at"]
    db[scrim_id]["source"] = source
    save("scrims", db)
    await manager.broadcast("lineup_updated", {**db[scrim_id], "source": source})
    return db[scrim_id]


@app.delete("/manager/scrims/{scrim_id}/lineup-v2")
async def unpublish_lineup_v2(scrim_id: str, source: str = Depends(require_client)):
    db = load("scrims")
    if scrim_id not in db:
        raise HTTPException(404, "Match not found")
    lineup = db[scrim_id].get("lineup_v2") or {"players": [], "tactics": LineupTactics().model_dump(), "notes": ""}
    lineup["published"] = False
    lineup["updated_at"] = now()
    db[scrim_id]["lineup_v2"] = lineup
    db[scrim_id]["source"] = source
    save("scrims", db)
    await manager.broadcast("lineup_updated", {**db[scrim_id], "source": source})
    return db[scrim_id]


@app.patch("/manager/scrims/{scrim_id}")
async def edit_scrim_v5(scrim_id: str, data: ScrimEdit, source: str = Depends(require_client)):
    db = load("scrims")
    if scrim_id not in db:
        raise HTTPException(404, "Scrim not found")
    updates = data.model_dump(exclude_none=True)
    if "match_type" in updates:
        try:
            updates["match_type"] = normalize_match_type(updates["match_type"])
        except ValueError as exc:
            raise HTTPException(400, str(exc))
    for key, value in updates.items():
        db[scrim_id][key] = value
    db[scrim_id]["updated_at"] = now()
    db[scrim_id]["source"] = source
    save("scrims", db)
    await manager.broadcast("scrim_updated", db[scrim_id])
    return db[scrim_id]


@app.patch("/manager/scrims/{scrim_id}/discord-message")
def save_scrim_discord_message(scrim_id: str, channel_id: str, message_id: str, source: str = Depends(require_client)):
    db = load("scrims")
    if scrim_id not in db:
        raise HTTPException(404, "Scrim not found")
    db[scrim_id]["discord_channel_id"] = channel_id
    db[scrim_id]["discord_message_id"] = message_id
    save("scrims", db)
    return db[scrim_id]


@app.get("/broadcasts")
def list_broadcasts():
    rows = []
    for scrim in load("scrims").values():
        if (scrim.get("broadcast") or {}).get("started_at"):
            rows.append(scrim)
    return sorted(rows, key=lambda x: (x.get("broadcast") or {}).get("started_at", ""), reverse=True)


@app.post("/manager/scrims/{scrim_id}/broadcast/start")
async def start_broadcast(scrim_id: str, data: BroadcastStart, source: str = Depends(require_client)):
    db = load("scrims")
    if scrim_id not in db:
        raise HTTPException(404, "Scrim not found")
    broadcast = db[scrim_id].get("broadcast") or {}
    broadcast.update({
        "active": True, "phase": "first_half", "home_score": int(broadcast.get("home_score", 0)),
        "away_score": int(broadcast.get("away_score", 0)), "events": broadcast.get("events", []),
        "started_at": broadcast.get("started_at") or now(), "started_by": data.started_by,
        "channel_id": data.channel_id or broadcast.get("channel_id", ""),
        "message_id": data.message_id or broadcast.get("message_id", ""),
    })
    db[scrim_id]["broadcast"] = broadcast
    db[scrim_id]["status"] = "live"
    db[scrim_id]["source"] = source
    save("scrims", db)
    await manager.broadcast("broadcast_updated", db[scrim_id])
    return db[scrim_id]


@app.post("/manager/scrims/{scrim_id}/broadcast/event")
async def add_broadcast_event(scrim_id: str, data: BroadcastEventCreate, source: str = Depends(require_client)):
    db = load("scrims")
    if scrim_id not in db:
        raise HTTPException(404, "Scrim not found")
    broadcast = db[scrim_id].get("broadcast") or {"active": True, "phase": "first_half", "home_score": 0, "away_score": 0, "events": []}
    before_home = int(broadcast.get("home_score", 0))
    before_away = int(broadcast.get("away_score", 0))

    # Explicit score values remain supported for older Discord controls. The
    # website's easier event picker leaves them blank and goals update the
    # correct side automatically.
    if data.home_score is not None:
        broadcast["home_score"] = data.home_score
    if data.away_score is not None:
        broadcast["away_score"] = data.away_score
    if data.event_type == "goal" and data.home_score is None and data.away_score is None:
        if data.team == "opponent":
            broadcast["away_score"] = before_away + 1
        else:
            broadcast["home_score"] = before_home + 1

    event_data = data.model_dump()
    if data.team == "opponent" and not event_data.get("player"):
        event_data["player"] = "Opponent"
    event = {
        "id": new_id("EV-"),
        **event_data,
        "score_before": {"home": before_home, "away": before_away},
        "created_at": now(),
    }
    broadcast.setdefault("events", []).append(event)
    broadcast["active"] = True
    db[scrim_id]["broadcast"] = broadcast
    db[scrim_id]["status"] = "live"
    db[scrim_id]["source"] = source
    save("scrims", db)
    await manager.broadcast("broadcast_updated", db[scrim_id])
    return db[scrim_id]


@app.delete("/manager/scrims/{scrim_id}/broadcast/event/last")
async def undo_last_broadcast_event(scrim_id: str, source: str = Depends(require_client)):
    db = load("scrims")
    if scrim_id not in db:
        raise HTTPException(404, "Scrim not found")
    broadcast = db[scrim_id].get("broadcast") or {}
    events = broadcast.get("events") or []
    if not events:
        raise HTTPException(400, "There is no broadcast event to undo")
    removed = events.pop()
    score_before = removed.get("score_before") or {}
    if "home" in score_before:
        broadcast["home_score"] = int(score_before["home"])
    if "away" in score_before:
        broadcast["away_score"] = int(score_before["away"])
    broadcast["events"] = events
    broadcast["updated_at"] = now()
    db[scrim_id]["broadcast"] = broadcast
    db[scrim_id]["source"] = source
    save("scrims", db)
    await manager.broadcast("broadcast_updated", db[scrim_id])
    return {"scrim": db[scrim_id], "removed_event": removed}


@app.post("/manager/scrims/{scrim_id}/broadcast/halftime")
async def halftime_broadcast(scrim_id: str, source: str = Depends(require_client)):
    db = load("scrims")
    if scrim_id not in db:
        raise HTTPException(404, "Scrim not found")
    broadcast = db[scrim_id].get("broadcast") or {}
    broadcast["phase"] = "halftime"
    broadcast["halftime_at"] = now()
    db[scrim_id]["broadcast"] = broadcast
    db[scrim_id]["source"] = source
    save("scrims", db)
    await manager.broadcast("broadcast_updated", db[scrim_id])
    return db[scrim_id]


@app.post("/manager/scrims/{scrim_id}/broadcast/finish")
async def finish_broadcast(scrim_id: str, data: BroadcastFinish, source: str = Depends(require_client)):
    db = load("scrims")
    if scrim_id not in db:
        raise HTTPException(404, "Scrim not found")
    broadcast = db[scrim_id].get("broadcast") or {}
    broadcast.update({
        "active": False, "phase": "full_time", "home_score": data.home_score, "away_score": data.away_score,
        "motm": data.motm, "summary": data.summary, "finished_by": data.finished_by, "finished_at": now(),
    })
    db[scrim_id]["broadcast"] = broadcast
    db[scrim_id]["status"] = "finished"
    db[scrim_id]["final_score"] = f"{data.home_score}-{data.away_score}"
    db[scrim_id]["source"] = source
    save("scrims", db)
    await manager.broadcast("broadcast_finished", db[scrim_id])
    return db[scrim_id]


@app.post("/manager/seasons/start")
async def start_season(data: SeasonStart, source: str = Depends(require_client)):
    db = load("seasons")
    if any(s.get("status") == "active" for s in db.values()):
        raise HTTPException(409, "Finish the active season first")
    season_id = new_id("SEA-")
    entry = {"id": season_id, "name": data.name, "status": "active", "started_by": data.started_by, "started_at": now(), "starting_record": _wdl_payload(), "source": source}
    db[season_id] = entry
    save("seasons", db)
    await manager.broadcast("season_updated", entry)
    return entry


@app.post("/manager/seasons/{season_id}/finish")
async def finish_season(season_id: str, data: SeasonFinish, source: str = Depends(require_client)):
    db = load("seasons")
    if season_id not in db:
        raise HTTPException(404, "Season not found")
    db[season_id].update({"status": "finished", "finished_by": data.finished_by, "finished_at": now(), "notes": data.notes, "final_record": _wdl_payload(), "records": _club_records(), "source": source})
    save("seasons", db)
    await manager.broadcast("season_updated", db[season_id])
    return db[season_id]


@app.post("/manager/awards")
async def add_award(data: AwardCreate, source: str = Depends(require_client)):
    db = load("awards")
    award_id = new_id("AWD-")
    db[award_id] = {"id": award_id, **data.model_dump(), "awarded_at": now(), "source": source}
    save("awards", db)
    await manager.broadcast("dynasty_updated", db[award_id])
    return db[award_id]


@app.post("/manager/trophies")
async def add_trophy(data: TrophyCreate, source: str = Depends(require_client)):
    db = load("trophies")
    trophy_id = new_id("TRP-")
    db[trophy_id] = {"id": trophy_id, **data.model_dump(), "added_at": now(), "source": source}
    save("trophies", db)
    await manager.broadcast("dynasty_updated", db[trophy_id])
    return db[trophy_id]
