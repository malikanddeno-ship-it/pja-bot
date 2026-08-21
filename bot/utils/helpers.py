import discord
import aiohttp
import asyncio
import json
import os
from datetime import datetime

# ─── PJA Brand Colors ──────────────────────────────────────────────────────────
BLUE = 0x3B82F6
DARK = 0x0F172A
GREEN = 0x22C55E
RED = 0xEF4444
YELLOW = 0xEAB308
PURPLE = 0x8B5CF6
CYAN = 0x06B6D4

# ─── API CONFIG ─────────────────────────────────────────────────────────────────
API_BASE = os.environ.get("PJA_API_URL", "http://127.0.0.1:8000")
WS_URL = os.environ.get("PJA_WS_URL", API_BASE.replace("http", "ws") + "/ws")
API_SECRET = os.environ.get("PJA_API_SECRET", "").strip()
_raw_public_url = os.environ.get("PJA_PUBLIC_URL", "").strip() or os.environ.get("RAILWAY_PUBLIC_DOMAIN", "").strip()
if _raw_public_url and not _raw_public_url.startswith(("http://", "https://")):
    _raw_public_url = "https://" + _raw_public_url
PUBLIC_PORTAL_URL = (_raw_public_url.rstrip("/") + "/portal") if _raw_public_url else ""


def player_portal_view(panel: str = "", label: str = "Open Player Portal") -> discord.ui.View | None:
    """Build a safe link button into the Player Portal without duplicating URL logic in cogs."""
    if not PUBLIC_PORTAL_URL:
        return None
    url = PUBLIC_PORTAL_URL
    if panel:
        url += f"?page=player&panel={panel}"
    view = discord.ui.View(timeout=600)
    view.add_item(discord.ui.Button(label=label, url=url, emoji="🌐"))
    return view


async def send_portal_redirect(interaction: discord.Interaction, title: str, message: str, panel: str) -> None:
    embed = pja_embed(title, message + "\n\nUse `/portal login` if you need a fresh one-use login code.", BLUE)
    view = player_portal_view(panel)
    if interaction.response.is_done():
        await interaction.followup.send(embed=embed, view=view, ephemeral=True)
    else:
        await interaction.response.send_message(embed=embed, view=view, ephemeral=True)

if not API_SECRET:
    raise RuntimeError("Missing required environment variable: PJA_API_SECRET")


class APIError(Exception):
    """Raised when the backend returns a non-2xx response. Cogs catch this
    and show the person a clean embed instead of letting an aiohttp
    exception bubble up as a generic 'this interaction failed' message."""
    def __init__(self, status: int, detail: str):
        self.status = status
        self.detail = detail
        super().__init__(f"[{status}] {detail}")


class APIClient:
    """
    Thin async wrapper around the Project Azure backend.

    Every cog imports a single shared `api` instance of this class instead of
    calling load_db/save_db on local JSON. Reads (GET) don't need auth since
    the website also reads them anonymously; writes (POST/PATCH/DELETE) send
    the shared X-API-Key header that the backend's require_bot() dependency
    checks for.

    A single aiohttp.ClientSession is created lazily and reused for the life
    of the bot process rather than opened per-request, since aiohttp warns
    (correctly) against creating a new session per call.
    """

    def __init__(self, base_url: str, secret: str):
        self.base_url = base_url.rstrip("/")
        self.secret = secret
        self._session: aiohttp.ClientSession | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()

    async def _request(self, method: str, path: str, auth: bool = False, tag_as_bot: bool = False, **kwargs):
        session = await self._get_session()
        headers = kwargs.pop("headers", {})
        if auth:
            headers["X-API-Key"] = self.secret
            headers["X-Client"] = "bot"
        elif tag_as_bot:
            # Public endpoints (vote, RSVP) don't need the API key, but the
            # bot still identifies itself so the backend stamps source="bot"
            # on the record — otherwise the bot's own vote/RSVP calls would
            # get tagged "website" and the bot would needlessly re-post a
            # Discord message for an action it already handled inline.
            headers["X-Client"] = "bot"
        url = f"{self.base_url}{path}"
        try:
            async with session.request(method, url, headers=headers, **kwargs) as resp:
                if resp.status >= 400:
                    try:
                        body = await resp.json()
                        detail = body.get("detail", await resp.text())
                    except Exception:
                        detail = await resp.text()
                    raise APIError(resp.status, detail)
                if resp.status == 204:
                    return None
                return await resp.json()
        except aiohttp.ClientConnectorError:
            raise APIError(503, f"Cannot reach Project Azure API at {self.base_url} — is the backend running?")

    # ── Tryouts ──────────────────────────────────────────────────────────────
    async def list_tryouts(self, status: str = None) -> list:
        params = {"status": status} if status else {}
        return await self._request("GET", "/manager/tryouts", auth=True, params=params)

    async def get_tryout(self, app_id: str) -> dict:
        return await self._request("GET", f"/tryouts/{app_id}", auth=True)

    async def get_player_tryouts(self, discord_id: str) -> list:
        try:
            return await self._request("GET", f"/tryouts/player/{discord_id}", auth=True)
        except APIError as e:
            if e.status == 404:
                return []
            raise

    async def create_tryout(self, **data) -> dict:
        return await self._request("POST", "/tryouts", auth=True, json=data)

    async def review_tryout(self, app_id: str, status: str, reviewed_by: str) -> dict:
        return await self._request(
            "PATCH", f"/tryouts/{app_id}/review", auth=True,
            json={"status": status, "reviewed_by": reviewed_by}
        )

    # ── Roster ───────────────────────────────────────────────────────────────
    async def get_roster(self) -> list:
        return await self._request("GET", "/roster")

    async def get_player(self, discord_id: str):
        try:
            return await self._request("GET", f"/roster/{discord_id}")
        except APIError as e:
            if e.status == 404:
                return None
            raise

    async def add_player(self, **data) -> dict:
        return await self._request("POST", "/roster", auth=True, json=data)

    async def update_player(self, discord_id: str, **data) -> dict:
        return await self._request("PATCH", f"/roster/{discord_id}", auth=True, json=data)

    async def remove_player(self, discord_id: str) -> dict:
        return await self._request("DELETE", f"/roster/{discord_id}", auth=True)

    # ── Accepted tryout roster ──────────────────────────────────────────────
    async def get_trial_roster(self) -> list:
        return await self._request("GET", "/manager/trial-roster", auth=True)

    async def promote_trial_player(self, discord_id: str, added_by: str = "Manager") -> dict:
        return await self._request("POST", f"/manager/trial-roster/{discord_id}/promote", auth=True, json={"added_by": added_by})

    async def remove_trial_player(self, discord_id: str) -> dict:
        return await self._request("DELETE", f"/manager/trial-roster/{discord_id}", auth=True)

    # ── AutoMod ─────────────────────────────────────────────────────────────
    async def get_automod_settings(self, guild_id: str) -> dict:
        return await self._request("GET", f"/manager/automod/{guild_id}", auth=True)

    async def update_automod_settings(self, guild_id: str, discord_links_enabled: bool, updated_by: str = "Manager") -> dict:
        return await self._request(
            "PUT", f"/manager/automod/{guild_id}", auth=True,
            json={"discord_links_enabled": bool(discord_links_enabled), "updated_by": updated_by},
        )

    # ── Stats ────────────────────────────────────────────────────────────────
    async def submit_stats(self, **data) -> dict:
        return await self._request("POST", "/stats", auth=True, json=data)

    async def get_player_stats(self, discord_id: str) -> dict:
        try:
            return await self._request("GET", f"/stats/player/{discord_id}")
        except APIError as e:
            if e.status == 404:
                return {}
            raise

    async def get_leaderboard(self) -> list:
        return await self._request("GET", "/stats/leaderboard")

    # ── MOTM ─────────────────────────────────────────────────────────────────
    async def list_motm(self, active: bool | None = None) -> list:
        params = {"active": str(active).lower()} if active is not None else {}
        return await self._request("GET", "/motm", params=params)

    async def start_motm(self, **data) -> dict:
        return await self._request("POST", "/motm", auth=True, json=data)

    async def close_motm(self, poll_id: str) -> dict:
        return await self._request("POST", f"/motm/{poll_id}/close", auth=True)

    async def vote_motm(self, poll_id: str, voter_id: str, voter_tag: str, nominee: str) -> dict:
        return await self._request(
            "POST", f"/motm/{poll_id}/vote", tag_as_bot=True,
            json={"voter_id": voter_id, "voter_tag": voter_tag, "nominee": nominee}
        )

    # ── Scrims ───────────────────────────────────────────────────────────────
    async def create_scrim(self, **data) -> dict:
        return await self._request("POST", "/scrims", auth=True, json=data)

    async def rsvp_scrim(self, scrim_id: str, discord_id: str, username: str, status: str, note: str = "") -> dict:
        return await self._request(
            "POST", f"/scrims/{scrim_id}/rsvp", tag_as_bot=True,
            json={"discord_id": discord_id, "username": username, "status": status, "note": note}
        )

    async def get_scrim(self, scrim_id: str):
        try:
            return await self._request("GET", f"/scrims/{scrim_id}")
        except APIError as e:
            if e.status == 404:
                return None
            raise

    async def get_scrim_participants(self, scrim_id: str) -> list:
        return await self._request("GET", f"/scrims/{scrim_id}/participants")

    async def list_scrims(self) -> list:
        return await self._request("GET", "/scrims")

    async def get_scrim_channels(self, guild_id: str) -> dict:
        return await self._request("GET", f"/scrims/settings/{guild_id}", auth=True)

    async def set_scrim_channels(
        self,
        guild_id: str,
        league_channel_id: str,
        friendly_channel_id: str,
        league_channel_name: str,
        friendly_channel_name: str,
        updated_by: str,
    ) -> dict:
        return await self._request(
            "PUT", f"/scrims/settings/{guild_id}", auth=True,
            json={
                "league_channel_id": league_channel_id,
                "friendly_channel_id": friendly_channel_id,
                "league_channel_name": league_channel_name,
                "friendly_channel_name": friendly_channel_name,
                "updated_by": updated_by,
            },
        )

    # ── Announcements ────────────────────────────────────────────────────────
    async def post_announcement_record(self, **data) -> dict:
        """Logs the announcement to the backend so it shows in the website's
        history. Does NOT send the Discord message itself — the cog still
        does that with channel.send(), this just keeps the record in sync."""
        return await self._request("POST", "/announcements", auth=True, json=data)

    # ── Channel registry (lets the website's announce form list real channels)
    async def set_channels(self, channels: dict):
        return await self._request("PUT", "/announcements/channels", auth=True, json=channels)

    # ── Manager role permissions ────────────────────────────────────────────
    async def get_manager_roles(self) -> list:
        return await self._request("GET", "/manager/roles", auth=True)

    # ── Stats approval ───────────────────────────────────────────────────────
    async def list_pending_stats(self) -> list:
        return await self._request("GET", "/manager/stats", auth=True, params={"status": "pending"})

    async def review_stats(self, discord_id: str, match_id: str, status: str, reviewed_by: str) -> dict:
        return await self._request(
            "PATCH", f"/stats/{discord_id}/{match_id}/review", auth=True,
            json={"status": status, "reviewed_by": reviewed_by}
        )

    # ── Points ───────────────────────────────────────────────────────────────
    async def get_points(self, discord_id: str) -> dict:
        return await self._request("GET", f"/points/{discord_id}")

    async def get_points_history(self, discord_id: str) -> list:
        return await self._request("GET", f"/points/{discord_id}/history", auth=True)

    async def get_points_leaderboard(self) -> list:
        return await self._request("GET", "/points/leaderboard")

    async def adjust_points(self, discord_id: str, username: str, amount: int, reason: str, actor: str) -> dict:
        return await self._request(
            "POST", "/manager/points/adjust", auth=True,
            json={"discord_id": discord_id, "username": username, "amount": amount, "reason": reason, "actor": actor}
        )

    async def set_points(self, discord_id: str, username: str, balance: int, reason: str, actor: str) -> dict:
        return await self._request(
            "POST", "/manager/points/set", auth=True,
            json={"discord_id": discord_id, "username": username, "balance": balance, "reason": reason, "actor": actor}
        )

    # ── Shop / inventory ─────────────────────────────────────────────────────
    async def get_shop(self) -> list:
        return await self._request("GET", "/shop")

    async def purchase_shop_item(self, discord_id: str, username: str, item_id: str) -> dict:
        return await self._request(
            "POST", "/shop/purchase", auth=True,
            json={"discord_id": discord_id, "username": username, "item_id": item_id}
        )

    async def get_inventory(self, discord_id: str) -> list:
        return await self._request("GET", f"/shop/inventory/{discord_id}", auth=True)

    async def get_player_orders(self, discord_id: str) -> list:
        return await self._request("GET", f"/shop/orders/player/{discord_id}", auth=True)

    # ── Suggestions / complaints ─────────────────────────────────────────────
    async def create_suggestion(self, discord_id: str, username: str, category: str, message: str) -> dict:
        return await self._request(
            "POST", "/suggestions", auth=True,
            json={"discord_id": discord_id, "username": username, "category": category, "message": message}
        )

    async def get_player_suggestions(self, discord_id: str) -> list:
        return await self._request("GET", f"/suggestions/player/{discord_id}", auth=True)

    async def create_complaint(self, discord_id: str, username: str, category: str, message: str, attachment_url: str = "") -> dict:
        return await self._request(
            "POST", "/complaints", auth=True,
            json={"discord_id": discord_id, "username": username, "category": category, "message": message, "attachment_url": attachment_url}
        )

    async def get_player_complaints(self, discord_id: str) -> list:
        return await self._request("GET", f"/complaints/player/{discord_id}", auth=True)

    # ── Secure player portal ─────────────────────────────────────────────────
    async def create_portal_code(self, discord_id: str, username: str) -> dict:
        return await self._request(
            "POST", "/player/auth/code", auth=True,
            json={"discord_id": discord_id, "username": username}
        )

    async def create_conversation(self, discord_id: str, username: str, subject: str, category: str, message: str, attachment_url: str = "") -> dict:
        return await self._request(
            "POST", "/conversations", auth=True,
            json={"discord_id": discord_id, "username": username, "subject": subject, "category": category, "message": message, "attachment_url": attachment_url}
        )

    async def get_player_conversations(self, discord_id: str) -> list:
        return await self._request("GET", f"/conversations/player/{discord_id}", auth=True)

    async def create_player_request(self, discord_id: str, username: str, request_type: str, details: str, attachment_url: str = "") -> dict:
        return await self._request(
            "POST", "/requests", auth=True,
            json={"discord_id": discord_id, "username": username, "request_type": request_type, "details": details, "attachment_url": attachment_url}
        )

    async def get_player_requests(self, discord_id: str) -> list:
        return await self._request("GET", f"/requests/player/{discord_id}", auth=True)


    # ── Activity review / kick wave ─────────────────────────────────────────
    async def record_message_activity(self, guild_id: str, discord_id: str, username: str, occurred_at: str = "") -> dict:
        return await self._request(
            "POST", "/activity/message", auth=True,
            json={"guild_id": guild_id, "discord_id": discord_id, "username": username, "occurred_at": occurred_at}
        )

    async def sync_activity_members(self, guild_id: str, guild_name: str, members: list[dict]) -> dict:
        return await self._request(
            "POST", "/activity/members/sync", auth=True,
            json={"guild_id": guild_id, "guild_name": guild_name, "members": members}
        )

    async def get_activity_candidates(self, guild_id: str, inactivity_days: int = 30) -> list:
        return await self._request(
            "GET", "/manager/activity/candidates", auth=True,
            params={"guild_id": guild_id, "inactivity_days": inactivity_days}
        )

    async def get_activity_actions(self, guild_id: str = "", action: str = "") -> list:
        params = {}
        if guild_id:
            params["guild_id"] = guild_id
        if action:
            params["action"] = action
        return await self._request("GET", "/manager/activity/actions", auth=True, params=params)

    async def get_activity_protected(self, guild_id: str) -> list:
        return await self._request("GET", "/manager/activity/protected", auth=True, params={"guild_id": guild_id})

    async def protect_activity_member(self, guild_id: str, member: discord.Member, manager_name: str, reason: str = "") -> dict:
        return await self._request(
            "POST", "/manager/activity/protect", auth=True,
            json={"guild_id": guild_id, "discord_id": str(member.id), "username": str(member), "action": "protect", "manager_name": manager_name, "reason": reason}
        )

    async def unprotect_activity_member(self, guild_id: str, discord_id: str) -> dict:
        return await self._request("DELETE", f"/manager/activity/protect/{guild_id}/{discord_id}", auth=True)

    async def log_activity_action(self, guild_id: str, member: discord.Member, action: str, manager_name: str, reason: str = "") -> dict:
        return await self._request(
            "POST", "/activity/action/log", auth=True,
            json={"guild_id": guild_id, "discord_id": str(member.id), "username": str(member), "action": action, "manager_name": manager_name, "reason": reason}
        )

    async def complete_activity_action(self, action_id: str, status: str, detail: str = "") -> dict:
        return await self._request(
            "PATCH", f"/activity/action/{action_id}/complete", auth=True,
            json={"status": status, "detail": detail}
        )

    # ── Welcomer ────────────────────────────────────────────────────────────
    async def get_welcome_config(self, guild_id: str) -> dict:
        return await self._request("GET", f"/manager/welcome/{guild_id}", auth=True)

    async def update_welcome_config(self, guild_id: str, **data) -> dict:
        return await self._request("PUT", f"/manager/welcome/{guild_id}", auth=True, json=data)

    async def request_welcome_test(self, guild_id: str, user_id: str) -> dict:
        return await self._request("POST", f"/manager/welcome/{guild_id}/test", auth=True, json={"user_id": user_id})

    # ── V5 lineups, profiles, broadcasts, and club history ──────────────────
    async def get_public_profile(self, discord_id: str) -> dict:
        return await self._request("GET", f"/public/players/{discord_id}", auth=True)

    async def get_wdl(self) -> dict:
        return await self._request("GET", "/team/wdl")

    async def get_next_match(self) -> dict:
        return await self._request("GET", "/team/next-match")

    async def get_next_lineup(self) -> dict:
        return await self._request("GET", "/lineup/next")

    async def save_lineup_v2(self, scrim_id: str, players: list, tactics: dict, notes: str, published: bool, updated_by: str) -> dict:
        return await self._request(
            "PATCH", f"/manager/scrims/{scrim_id}/lineup-v2", auth=True,
            json={"players": players, "tactics": tactics, "notes": notes, "published": published, "updated_by": updated_by},
        )

    async def unpublish_lineup(self, scrim_id: str) -> dict:
        return await self._request("DELETE", f"/manager/scrims/{scrim_id}/lineup-v2", auth=True)

    async def edit_scrim(self, scrim_id: str, **data) -> dict:
        return await self._request("PATCH", f"/manager/scrims/{scrim_id}", auth=True, json=data)

    async def save_scrim_message(self, scrim_id: str, channel_id: str, message_id: str) -> dict:
        return await self._request(
            "PATCH", f"/manager/scrims/{scrim_id}/discord-message", auth=True,
            params={"channel_id": channel_id, "message_id": message_id},
        )

    async def list_broadcasts(self) -> list:
        return await self._request("GET", "/broadcasts")

    async def start_broadcast(self, scrim_id: str, started_by: str, channel_id: str = "", message_id: str = "") -> dict:
        return await self._request("POST", f"/manager/scrims/{scrim_id}/broadcast/start", auth=True, json={"started_by": started_by, "channel_id": channel_id, "message_id": message_id})

    async def add_broadcast_event(self, scrim_id: str, **data) -> dict:
        return await self._request("POST", f"/manager/scrims/{scrim_id}/broadcast/event", auth=True, json=data)

    async def halftime_broadcast(self, scrim_id: str) -> dict:
        return await self._request("POST", f"/manager/scrims/{scrim_id}/broadcast/halftime", auth=True)

    async def finish_broadcast(self, scrim_id: str, home_score: int, away_score: int, motm: str, summary: str, finished_by: str) -> dict:
        return await self._request(
            "POST", f"/manager/scrims/{scrim_id}/broadcast/finish", auth=True,
            json={"home_score": home_score, "away_score": away_score, "motm": motm, "summary": summary, "finished_by": finished_by},
        )

    async def get_dynasty(self) -> dict:
        return await self._request("GET", "/team/dynasty")

    async def get_rivalry(self, opponent: str) -> dict:
        from urllib.parse import quote
        return await self._request("GET", f"/team/rivalry/{quote(opponent, safe='')}")

    async def get_career(self, discord_id: str) -> dict:
        return await self._request("GET", f"/team/career/{discord_id}", auth=True)

    async def start_season(self, name: str, started_by: str) -> dict:
        return await self._request("POST", "/manager/seasons/start", auth=True, json={"name": name, "started_by": started_by})

    async def finish_season(self, season_id: str, finished_by: str, notes: str = "") -> dict:
        return await self._request("POST", f"/manager/seasons/{season_id}/finish", auth=True, json={"finished_by": finished_by, "notes": notes})

    async def add_award(self, **data) -> dict:
        return await self._request("POST", "/manager/awards", auth=True, json=data)

    async def add_trophy(self, **data) -> dict:
        return await self._request("POST", "/manager/trophies", auth=True, json=data)

    async def storage_status(self) -> dict:
        return await self._request("GET", "/storage/status", auth=True)


# Shared singleton — every cog does `from utils.helpers import api`
api = APIClient(API_BASE, API_SECRET)


# ─── EMBED HELPERS ──────────────────────────────────────────────────────────────
def pja_embed(title: str, description: str = "", color: int = BLUE) -> discord.Embed:
    embed = discord.Embed(title=title, description=description, color=color)
    embed.set_footer(text="Project Azure • VRFS")
    embed.timestamp = datetime.utcnow()
    return embed


def normalize_role_name(name: str) -> str:
    """Case-insensitive role matching; CO-OWNER and CO OWNER are equivalent."""
    return " ".join(str(name).replace("-", " ").replace("_", " ").split()).casefold()


BUILT_IN_MANAGER_ROLE_NAMES = {
    normalize_role_name("OWNER"),
    normalize_role_name("CO OWNER"),
    normalize_role_name("TEAM MANAGER"),
}


async def has_manager_access(interaction: discord.Interaction) -> bool:
    """Allow server owner/admins, built-in role names, and portal-added role IDs."""
    guild = interaction.guild
    user = interaction.user
    if guild is None or not isinstance(user, discord.Member):
        return False

    if guild.owner_id == user.id or user.guild_permissions.administrator:
        return True

    user_roles = list(getattr(user, "roles", []))
    user_role_names = {normalize_role_name(role.name) for role in user_roles}
    if BUILT_IN_MANAGER_ROLE_NAMES & user_role_names:
        return True

    user_role_ids = {str(role.id) for role in user_roles}
    try:
        configured_roles = await api.get_manager_roles()
    except APIError as error:
        # Built-in roles and administrators still work during a backend hiccup.
        print(f"Could not load configured manager roles: {error}")
        return False

    for role in configured_roles:
        role_id = str(role.get("role_id", "")).strip()
        if role_id and role_id in user_role_ids:
            return True
    return False



async def member_has_manager_access(member: discord.Member) -> bool:
    """Manager access check for listeners and button interactions."""
    guild = member.guild
    if guild.owner_id == member.id or member.guild_permissions.administrator:
        return True
    role_names = {normalize_role_name(role.name) for role in member.roles}
    if BUILT_IN_MANAGER_ROLE_NAMES & role_names:
        return True
    role_ids = {str(role.id) for role in member.roles}
    try:
        configured_roles = await api.get_manager_roles()
    except APIError:
        return False
    return any(str(role.get("role_id", "")) in role_ids for role in configured_roles if role.get("role_id"))

def is_manager():
    async def predicate(interaction: discord.Interaction) -> bool:
        if not await has_manager_access(interaction):
            await interaction.response.send_message(
                embed=pja_embed(
                    "Access Denied",
                    "This command requires OWNER, CO OWNER, TEAM MANAGER, an approved role from the manager portal, or Administrator permission.",
                    RED
                ),
                ephemeral=True
            )
            return False
        return True
    return discord.app_commands.check(predicate)

def api_error_embed(error: "APIError") -> discord.Embed:
    """Consistent error display whenever a cog catches an APIError, instead
    of each cog rolling its own message."""
    if error.status == 503:
        return pja_embed(
            "Backend Unavailable",
            "The Project Azure server isn't responding right now. Please try again shortly, or contact a manager if this keeps happening.",
            RED
        )
    if error.status == 409:
        return pja_embed("Already Exists", str(error.detail), YELLOW)
    if error.status == 404:
        return pja_embed("Not Found", str(error.detail), RED)
    return pja_embed("Something Went Wrong", str(error.detail), RED)
