import discord
from discord.ext import commands
from discord import app_commands
import json
import os
import asyncio
import aiohttp
from pathlib import Path
import sys
import dotenv

dotenv.load_dotenv(Path(__file__).parent.parent / ".env")

sys.path.insert(0, os.path.dirname(__file__))
from utils.helpers import api, WS_URL, pja_embed, BLUE, YELLOW, GREEN, RED, APIError

intents = discord.Intents.default()
intents.message_content = True
intents.members = True

COGS = [
    "cogs.tryouts",
    "cogs.roster",
    "cogs.stats",
    "cogs.motm",
    "cogs.announcements",
    "cogs.scrims",
    "cogs.points",
    "cogs.shop",
    "cogs.feedback",
    "cogs.cards",
    "cogs.portal",
    "cogs.activity",
    "cogs.welcome",
    "cogs.automod",
    "cogs.lineups",
    "cogs.broadcast",
    "cogs.club",
]


class PJABot(commands.Bot):
    def __init__(self):
        super().__init__(command_prefix="!", intents=intents)
        self.ws_task: asyncio.Task | None = None

    async def setup_hook(self):
        for cog in COGS:
            try:
                await self.load_extension(cog)
                print(f"Loaded {cog}")
            except Exception as e:
                print(f"Failed to load {cog}: {e}")

        try:
            synced = await self.tree.sync()
            print(f"Synced {len(synced)} slash commands globally")
        except Exception as e:
            print(f"Sync failed: {e}")

        self.ws_task = asyncio.create_task(ws_listener(), name="pja-backend-websocket")

    async def close(self):
        if self.ws_task:
            self.ws_task.cancel()
            try:
                await self.ws_task
            except asyncio.CancelledError:
                pass
        await api.close()
        await super().close()


bot = PJABot()

# Channel names the bot looks for when it needs to post something that
# originated from the website (a tryout submitted there, a scrim posted
# there, etc). These mirror the lookups already used inside the cogs.
REVIEW_CHANNEL_NAMES = ["tryout-reviews", "manager-lounge"]
STATS_CHANNEL_NAME = "match-stats"
ANNOUNCE_FALLBACK_CHANNEL_NAME = "announcements"


def find_channel(guild: discord.Guild, names: list[str]) -> discord.TextChannel | None:
    for name in names:
        ch = discord.utils.get(guild.text_channels, name=name)
        if ch:
            return ch
    return None


def build_commands_embed() -> discord.Embed:
    embed = pja_embed(
        "Project Azure — Command List",
        "Use these slash commands in Discord. Manager-only commands are marked with a lock.",
        BLUE,
    )

    sections = {
        "Tryouts": [
            "/tryout apply - Submit a tryout application",
            "/tryout status - Check your application status",
            "/tryout list - View pending applications 🔒",
        ],
        "Roster & Cards": [
            "/roster view - View the full team roster",
            "/roster add, remove, update - Manage the roster 🔒",
            "/card view - Generate a PJA player card and open the full website profile",
        ],
        "Stats": [
            "/stats submit - Open Match Stats in the Player Portal",
            "/stats view - View approved season stats",
            "/stats leaderboard - View the team leaderboard",
        ],
        "Points": [
            "/points view - Open your points in the Player Portal",
            "/points leaderboard - View the points leaderboard",
            "/points history - Open point history in the Player Portal",
            "/points give, remove, set - Manage balances 🔒",
        ],
        "Shop": [
            "/shop view - Open the Player Portal shop",
            "/shop buy - Purchase rewards in the Player Portal",
            "/inventory - Open your Player Portal inventory",
        ],
        "Player Portal": [
            "/portal login - Create a secure one-use website login code",
            "/talk manager - Open private manager chat in the Player Portal",
            "/request submit - Open Player Requests in the Player Portal",
            "/request status - Open request updates in the Player Portal",
            "/availability set - Open Availability in the Player Portal",
            "/availability view - Open upcoming availability in the Player Portal",
            "/history - Open card and match history in the Player Portal",
        ],
        "Activity Review": [
            "/kickwave start - Review inactive members one at a time 🔒",
            "/kickwave warnings - View recent inactivity warnings 🔒",
            "/kickwave protected - View protected members 🔒",
            "/kickwave unprotect - Remove inactivity protection 🔒",
        ],
        "Welcomer": [
            "/welcome test - Preview the current welcome design 🔒",
            "/welcome status - View welcomer settings 🔒",
            "/welcome enable - Turn welcomes on 🔒",
            "/welcome disable - Turn welcomes off 🔒",
        ],
        "Suggestions & Complaints": [
            "/suggest submit - Open suggestions in the Player Portal",
            "/suggest status - Open suggestion updates in the Player Portal",
            "/complaint submit - Open private complaints in the Player Portal",
            "/complaint status - Open complaint updates in the Player Portal",
        ],
        "MOTM": [
            "/motm start - Start a MOTM vote 🔒",
            "/motm results - End voting and award MOTM points 🔒",
        ],
        "Lineups & Scrims": [
            "/lineup - Show the published lineup for the next match",
            "/scrim setup - Choose league-ticks and friendly-ticks 🔒",
            "/scrim announce - Route a league or friendly to its configured channel 🔒",
            "/scrim list - View current scrims",
        ],
        "PJA TV": [
            "/broadcast start - Start a live match broadcast 🔒",
            "/broadcast event - Add goals, saves, cards, and substitutions 🔒",
            "/broadcast halftime - Mark the broadcast as half-time 🔒",
            "/broadcast finish - Publish full-time and the result graphic 🔒",
        ],
        "Club History": [
            "/wdl - Show wins, draws, losses, goals, and recent form",
            "/records - Show all-time Project Azure records",
            "/rivalry - Show the record against one opponent",
            "/career - Show a player's PJA career totals",
            "/awards - Show club awards",
            "/trophies - Show the trophy cabinet",
            "/season start - Begin a new season without deleting old history 🔒",
            "/season finish - Archive the active season 🔒",
        ],
        "Announcements": [
            "/announce send - Send a team announcement 🔒",
            "/announce roster-update - Post a roster update 🔒",
        ],
    }

    for title, lines in sections.items():
        embed.add_field(name=title, value="\n".join(lines), inline=False)

    return embed


@bot.tree.error
async def on_app_command_error(interaction: discord.Interaction, error: discord.app_commands.AppCommandError):
    if isinstance(error, discord.app_commands.CheckFailure):
        return
    raise error

@bot.tree.command(name="commands", description="Show all available slash commands")
async def commands_help(interaction: discord.Interaction):
    await interaction.response.send_message(embed=build_commands_embed(), ephemeral=True)


async def ws_listener():
    """
    Background task: stays connected to the backend's /ws endpoint for the
    life of the bot process. Reacts only to events whose `source` is NOT
    "bot" — i.e. things that happened on the website — since bot-originated
    actions already post their own Discord messages synchronously inside
    the slash command that triggered them. Reconnects with backoff if the
    backend restarts or the connection drops.
    """
    await bot.wait_until_ready()
    backoff = 2
    while not bot.is_closed():
        try:
            async with aiohttp.ClientSession() as session:
                async with session.ws_connect(WS_URL, heartbeat=30) as ws:
                    print(f"[sync] Connected to backend WebSocket at {WS_URL}")
                    backoff = 2  # reset on successful connect
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            try:
                                payload = json.loads(msg.data)
                                await handle_ws_event(payload)
                            except Exception as e:
                                print(f"[sync] Error handling event: {e}")
                        elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            break
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"[sync] WebSocket connection failed: {e}")
        if not bot.is_closed():
            print(f"[sync] Reconnecting in {backoff}s...")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)


async def handle_ws_event(payload: dict):
    event = payload.get("event")
    data = payload.get("data", {})

    # Skip events the bot itself caused — those commands already post their
    # own Discord message inline. Only react to website-originated changes.
    if data.get("source") == "bot":
        return

    if event == "tryout_created":
        await on_website_tryout(data)
    elif event == "tryout_reviewed":
        await on_website_tryout_review(data)
    elif event == "automod_updated":
        cog = bot.get_cog("AutoModCog")
        if cog:
            cog.set_config(data)
    elif event == "motm_started":
        await on_website_motm_started(data)
    elif event == "motm_closed":
        await on_website_motm_closed(data)
    elif event == "scrim_created":
        await on_website_scrim_created(data)
    elif event == "announcement_posted":
        await on_website_announcement(data)
    elif event == "stats_reviewed":
        await on_website_stats_reviewed(data)
    elif event == "shop_order_updated":
        await on_website_shop_order_updated(data)
    elif event == "suggestion_updated":
        await on_website_feedback_updated(data, "Suggestion")
    elif event == "complaint_updated":
        await on_website_feedback_updated(data, "Complaint")
    elif event in ("conversation_created", "conversation_message"):
        await on_player_conversation_activity(data)
    elif event == "conversation_updated":
        await on_manager_conversation_updated(data)
    elif event == "player_request_created":
        await on_player_request_created(data)
    elif event == "player_request_updated":
        await on_player_request_updated(data)
    elif event == "availability_reminder_requested":
        await on_availability_reminder_requested(data)
    elif event == "activity_action_requested":
        cog = bot.get_cog("ActivityCog")
        if cog:
            await cog.handle_remote_action(data)
    elif event == "welcome_test_requested":
        cog = bot.get_cog("WelcomeCog")
        if cog:
            await cog.handle_remote_test(data)
    elif event == "broadcast_updated":
        cog = bot.get_cog("BroadcastCog")
        if cog:
            await cog.handle_remote_update(data, finished=False)
    elif event == "broadcast_finished":
        cog = bot.get_cog("BroadcastCog")
        if cog:
            await cog.handle_remote_update(data, finished=True)
    elif event in ("lineup_updated", "scrim_updated", "season_updated", "dynasty_updated"):
        return


async def on_website_tryout(app: dict):
    """A tryout application came in from the website portal — post the
    same Accept/Trial/Deny review card the bot posts for /tryout apply."""
    from cogs.tryouts import TryoutReviewView  # local import avoids circular import at module load
    try:
        app = await api.get_tryout(app["id"])
    except (APIError, KeyError) as e:
        print(f"[sync] Could not load website tryout details: {e}")
        return
    for guild in bot.guilds:
        channel = find_channel(guild, REVIEW_CHANNEL_NAMES)
        if not channel:
            continue
        embed = pja_embed(
            f"New Tryout Application — #{app['id']} (via Website)",
            "Submitted through the player portal and awaiting review.",
            YELLOW
        )
        embed.add_field(name="Username", value=app["username"], inline=True)
        embed.add_field(name="Position", value=app["position"], inline=True)
        embed.add_field(name="Overall", value=app["overall"], inline=True)
        embed.add_field(name="Availability", value=app.get("availability", "—"), inline=True)
        embed.add_field(name="Discord", value=app.get("discord_tag", "—"), inline=True)
        embed.add_field(name="Experience", value=app.get("experience", "—"), inline=False)
        embed.add_field(name="Why PJA?", value=app.get("reason", "—"), inline=False)
        view = TryoutReviewView(app["id"])
        await channel.send(embed=embed, view=view)


async def on_website_tryout_review(app: dict):
    """A manager reviewed an application from the website dashboard instead
    of clicking a Discord button — the applicant still needs their DM."""
    try:
        app = await api.get_tryout(app["id"])
    except (APIError, KeyError) as e:
        print(f"[sync] Could not load reviewed tryout details: {e}")
        return
    status = app.get("status")
    if status not in ("accepted", "denied", "trial"):
        return
    outcome_text = {
        "accepted": "accepted into Project Azure",
        "trial": "placed on trial for Project Azure",
        "denied": "not selected at this time",
    }[status]
    color = {"accepted": GREEN, "trial": BLUE, "denied": RED}[status]

    discord_id = app.get("discord_id")
    if not discord_id:
        return
    if not str(discord_id).isdigit():
        return
    for guild in bot.guilds:
        member = guild.get_member(int(discord_id))
        if member:
            try:
                dm_embed = pja_embed(
                    "Project Azure — Application Update",
                    f"Your tryout application has been reviewed. You have been **{outcome_text}**.",
                    color
                )
                dm_embed.add_field(name="Reviewed by", value=app.get("reviewed_by", "Management"), inline=True)
                dm_embed.set_footer(text="Project Azure • VRFS — reviewed via player portal")
                await member.send(embed=dm_embed)
            except discord.Forbidden:
                pass
            break


async def on_website_motm_started(poll: dict):
    from cogs.motm import MOTMVoteView
    for guild in bot.guilds:
        channel = find_channel(guild, [STATS_CHANNEL_NAME, "general"])
        if not channel:
            continue
        nominee_pairs = [(n, n) for n in poll["nominees"]]
        embed = pja_embed(
            f"⭐ Man of the Match — vs {poll['opponent']} (via Website)",
            f"Vote for your Player of the Match! Match ID: `{poll['match_id']}`\n\nVoting is open on both Discord and the player portal.",
            YELLOW
        )
        embed.add_field(name="Nominees", value="\n".join([f"• {n}" for n in poll["nominees"]]), inline=False)
        view = MOTMVoteView(nominees=nominee_pairs, match_id=poll["id"])
        await channel.send(embed=embed, view=view)


async def on_website_motm_closed(poll: dict):
    for guild in bot.guilds:
        channel = find_channel(guild, [STATS_CHANNEL_NAME, "general"])
        if not channel:
            continue
        votes = poll.get("votes", {})
        total = sum(votes.values())
        if not total:
            continue
        winner = poll.get("winner")
        embed = pja_embed(
            f"⭐ MOTM Results — vs {poll['opponent']}",
            f"**{winner}** wins Man of the Match with **{votes.get(winner, 0)}/{total}** votes!",
            YELLOW
        )
        for name, count in sorted(votes.items(), key=lambda x: x[1], reverse=True):
            pct = round((count / total) * 100) if total else 0
            bar = "█" * (pct // 10) + "░" * (10 - pct // 10)
            embed.add_field(name=f"{'🏆 ' if name == winner else ''}{name}", value=f"`{bar}` {count} vote(s) ({pct}%)", inline=False)
        await channel.send(embed=embed)


async def on_website_scrim_created(scrim: dict):
    from cogs.scrims import ScrimRSVPView, configured_channel_for
    for guild in bot.guilds:
        try:
            settings = await api.get_scrim_channels(str(guild.id))
        except APIError as e:
            print(f"[sync] Could not load scrim channels for {guild.name}: {e}")
            continue
        channel = configured_channel_for(guild, settings, scrim.get("match_type", "League"))
        if not channel:
            print(
                f"[sync] Website scrim {scrim.get('id')} was not posted: "
                f"run /scrim setup in {guild.name}. No General fallback is used."
            )
            continue
        embed = pja_embed(
            f"⚽ {scrim['match_type']} vs {scrim['opponent']} (via Website)",
            f"**{scrim['match_time']}**\n{scrim.get('notes') or 'Use the buttons below to RSVP.'}",
            BLUE,
        )
        embed.add_field(name="✅ Going (0)", value="—", inline=True)
        embed.add_field(name="🟡 Maybe (0)", value="—", inline=True)
        embed.add_field(name="❌ Can't Go (0)", value="—", inline=True)
        view = ScrimRSVPView(scrim_id=scrim["id"])
        try:
            posted = await channel.send(embed=embed, view=view)
            try:
                await api.save_scrim_message(scrim.get("id", ""), str(channel.id), str(posted.id))
            except APIError as save_error:
                print(f"[sync] Could not save website scrim message metadata: {save_error}")
        except discord.Forbidden:
            print(f"[sync] Missing permission to post website scrim in #{channel.name}")


def find_member(discord_id: str) -> discord.Member | None:
    if not str(discord_id).isdigit():
        return None
    user_id = int(discord_id)
    for guild in bot.guilds:
        member = guild.get_member(user_id)
        if member:
            return member
    return None


async def on_website_stats_reviewed(record: dict):
    member = find_member(record.get("player_discord_id", ""))
    status = record.get("status")
    if member:
        try:
            if status == "approved":
                breakdown = record.get("points_breakdown", [])
                lines = [f"• {item.get('label')}: **+{item.get('amount', 0)}**" for item in breakdown]
                embed = pja_embed(
                    "Match Report Approved",
                    f"Your report vs **{record.get('opponent', 'opponent')}** was approved.",
                    GREEN,
                )
                embed.add_field(name="Points Earned", value="\n".join(lines) or f"+{record.get('points_awarded', 0)}", inline=False)
                embed.add_field(name="New Balance", value=f"{record.get('points_balance', 0):,} points", inline=True)
            else:
                embed = pja_embed(
                    "Match Report Denied",
                    f"Your report vs **{record.get('opponent', 'opponent')}** was not approved. Contact management if you need clarification.",
                    RED,
                )
            await member.send(embed=embed)
        except discord.Forbidden:
            pass

    if status == "approved":
        for guild in bot.guilds:
            channel = find_channel(guild, [STATS_CHANNEL_NAME])
            if not channel:
                continue
            embed = pja_embed(
                f"Approved Match Report — vs {record.get('opponent', 'Opponent')}",
                f"**{record.get('player_username') or record.get('discord_tag', 'Player')}** earned **{record.get('points_awarded', 0)} points**.",
                GREEN,
            )
            embed.add_field(name="Result", value=record.get("result", "—"), inline=True)
            embed.add_field(name="Goals", value=record.get("goals", 0), inline=True)
            embed.add_field(name="Assists", value=record.get("assists", 0), inline=True)
            embed.add_field(name="Saves", value=record.get("saves", 0), inline=True)
            embed.add_field(name="Match ID", value=f"`{record.get('match_id', '—')}`", inline=True)
            await channel.send(embed=embed)


async def on_website_shop_order_updated(order: dict):
    member = find_member(order.get("discord_id", ""))
    if not member:
        return
    fulfilled = order.get("status") == "fulfilled"
    description = (
        f"Your purchase **{order.get('item_name')}** was fulfilled. It is now in your inventory."
        if fulfilled else
        f"Your purchase **{order.get('item_name')}** was rejected and the points were refunded."
    )
    embed = pja_embed("Shop Order Updated", description, GREEN if fulfilled else YELLOW)
    if order.get("manager_note"):
        embed.add_field(name="Manager Note", value=order["manager_note"], inline=False)
    try:
        await member.send(embed=embed)
    except discord.Forbidden:
        pass


async def on_website_feedback_updated(entry: dict, kind: str):
    member = find_member(entry.get("discord_id", ""))
    if not member:
        return
    embed = pja_embed(
        f"{kind} Update",
        f"Your {kind.lower()} `{entry.get('id')}` is now **{str(entry.get('status', 'pending')).title()}**.",
        BLUE,
    )
    if entry.get("reply"):
        embed.add_field(name="Manager Reply", value=entry["reply"], inline=False)
    try:
        await member.send(embed=embed)
    except discord.Forbidden:
        pass


async def on_player_conversation_activity(conversation: dict):
    latest = conversation.get("latest_message") or (conversation.get("messages") or [{}])[-1]
    if latest.get("sender_type") == "manager":
        return
    for guild in bot.guilds:
        channel = find_channel(guild, ["manager-lounge", "talk-to-manager", "staff-chat"])
        if not channel:
            continue
        embed = pja_embed(
            f"Private Player Message — {conversation.get('username', 'Player')}",
            latest.get("message", "New private conversation")[:3500],
            YELLOW,
        )
        embed.add_field(name="Subject", value=conversation.get("subject", "General"), inline=True)
        embed.add_field(name="Category", value=conversation.get("category", "General"), inline=True)
        embed.add_field(name="Conversation ID", value=f"`{conversation.get('id', '—')}`", inline=True)
        embed.set_footer(text="Project Azure • Reply from the Manager website → Conversations")
        await channel.send(embed=embed)


async def on_manager_conversation_updated(conversation: dict):
    latest = conversation.get("latest_message") or (conversation.get("messages") or [{}])[-1]
    if latest.get("sender_type") != "manager":
        return
    member = find_member(conversation.get("discord_id", ""))
    if not member:
        return
    embed = pja_embed(
        "Management Replied",
        latest.get("message", "Your private conversation was updated."),
        BLUE,
    )
    embed.add_field(name="Subject", value=conversation.get("subject", "General"), inline=True)
    embed.add_field(name="Status", value=str(conversation.get("status", "open")).replace("_", " ").title(), inline=True)
    embed.add_field(name="Conversation ID", value=f"`{conversation.get('id', '—')}`", inline=True)
    try:
        await member.send(embed=embed)
    except discord.Forbidden:
        pass


async def on_player_request_created(entry: dict):
    for guild in bot.guilds:
        channel = find_channel(guild, ["manager-lounge", "player-requests", "staff-chat"])
        if not channel:
            continue
        embed = pja_embed(
            f"New Player Request — {entry.get('username', 'Player')}",
            entry.get("details", "")[:3500],
            YELLOW,
        )
        embed.add_field(name="Type", value=entry.get("request_type", "Other"), inline=True)
        embed.add_field(name="Request ID", value=f"`{entry.get('id', '—')}`", inline=True)
        embed.set_footer(text="Project Azure • Review from the Manager website → Requests")
        await channel.send(embed=embed)


async def on_player_request_updated(entry: dict):
    member = find_member(entry.get("discord_id", ""))
    if not member:
        return
    embed = pja_embed(
        "Player Request Updated",
        f"Your request `{entry.get('id', '—')}` is now **{str(entry.get('status', 'pending')).replace('_', ' ').title()}**.",
        BLUE,
    )
    if entry.get("reply"):
        embed.add_field(name="Manager Reply", value=entry["reply"], inline=False)
    try:
        await member.send(embed=embed)
    except discord.Forbidden:
        pass


async def on_availability_reminder_requested(scrim: dict):
    for player in scrim.get("missing", []):
        member = find_member(player.get("discord_id", ""))
        if not member:
            continue
        embed = pja_embed(
            "Match Availability Needed",
            f"Please respond for **{scrim.get('match_type', 'Match')} vs {scrim.get('opponent', 'Opponent')}**.\n"
            f"Time: **{scrim.get('match_time', 'TBD')}**\nMatch ID: `{scrim.get('id', '—')}`",
            YELLOW,
        )
        embed.add_field(name="How to respond", value="Open the Player Portal and set your availability there. Use `/portal login` if you need a fresh one-use login code.", inline=False)
        try:
            await member.send(embed=embed)
        except discord.Forbidden:
            pass


async def on_website_announcement(ann: dict):
    """The actual delivery mechanism for website-posted announcements —
    the backend only stores the record, this is what makes it real."""
    channel_id = ann.get("channel_id")
    if not channel_id:
        print(f"[sync] Announcement '{ann.get('title')}' has no channel_id, skipping Discord delivery")
        return
    channel = bot.get_channel(int(channel_id))
    if not channel:
        return

    color_hex = ann.get("color", "#3B82F6").lstrip("#")
    color_int = int(color_hex, 16) if color_hex else BLUE

    embed = discord.Embed(title=f"📢 {ann['title']}", description=ann["message"], color=color_int)
    embed.set_footer(text="Project Azure • VRFS — posted via player portal")
    embed.timestamp = discord.utils.utcnow()
    if ann.get("image_url"):
        embed.set_image(url=ann["image_url"])

    view = None
    if ann.get("link_label") and ann.get("link_url"):
        view = discord.ui.View()
        view.add_item(discord.ui.Button(label=ann["link_label"], url=ann["link_url"], style=discord.ButtonStyle.link))

    content = None
    ping = ann.get("ping")
    if ping:
        if ping in ("@everyone", "@here"):
            content = ping
        else:
            role = discord.utils.get(channel.guild.roles, name=ping.replace("@", ""))
            if role:
                content = role.mention

    await channel.send(content=content, embed=embed, view=view)


@bot.event
async def on_ready():
    print(f"Project Azure Bot is online as {bot.user}")
    # Report this guild's text channels to the backend so the website's
    # announcement form can offer a real channel picker instead of asking
    # someone to type a channel ID by hand.
    for guild in bot.guilds:
        try:
            channels = {ch.name: str(ch.id) for ch in guild.text_channels}
            await api.set_channels(channels)

            # Automatically keep the two approved scrim routes current. This
            # repairs deleted/recreated channel IDs without sending anything
            # to General and avoids requiring another setup command when the
            # channels already use the standard names.
            league_channel = discord.utils.find(lambda ch: ch.name.casefold() == "league-ticks", guild.text_channels)
            friendly_channel = discord.utils.find(lambda ch: ch.name.casefold() == "friendly-ticks", guild.text_channels)
            if league_channel and friendly_channel:
                await api.set_scrim_channels(
                    guild_id=str(guild.id),
                    league_channel_id=str(league_channel.id),
                    friendly_channel_id=str(friendly_channel.id),
                    league_channel_name=league_channel.name,
                    friendly_channel_name=friendly_channel.name,
                    updated_by="Automatic channel sync",
                )
            else:
                missing = []
                if not league_channel:
                    missing.append("league-ticks")
                if not friendly_channel:
                    missing.append("friendly-ticks")
                print(f"[sync] Scrim routing not auto-configured in {guild.name}; missing: {', '.join(missing)}")
        except Exception as e:
            print(f"[sync] Failed to report channels: {e}")

def main():
    token = os.environ.get("DISCORD_TOKEN", "").strip()
    if not token:
        raise RuntimeError("Missing required environment variable: DISCORD_TOKEN")
    bot.run(token)


if __name__ == "__main__":
    main()
