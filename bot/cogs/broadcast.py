import asyncio
import io
import os
import sys
from typing import Optional

import discord
from discord import app_commands
from discord.ext import commands
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from utils.helpers import api, APIError, api_error_embed, is_manager, pja_embed, BLUE, GREEN, RED, YELLOW, PUBLIC_PORTAL_URL

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def _font(size: int, bold: bool = False):
    try:
        return ImageFont.truetype(FONT_BOLD if bold else FONT, size)
    except OSError:
        return ImageFont.load_default()


def phase_label(phase: str) -> str:
    return {"pre_match": "PRE-MATCH", "first_half": "LIVE", "halftime": "HALF-TIME", "second_half": "LIVE", "full_time": "FULL-TIME"}.get(phase, phase.replace("_", " ").upper())


def event_line(event: dict) -> str:
    icons = {"goal": "⚽", "assist": "🎯", "save": "🧤", "substitution": "🔄", "yellow": "🟨", "red": "🟥", "note": "📣"}
    minute = f"{event.get('minute')}′ " if event.get("minute") else ""
    team = event.get("team", "pja")
    player = event.get("player") or ("Opponent" if team == "opponent" else "Team update")
    second = f" → {event.get('secondary_player')}" if event.get("secondary_player") else ""
    detail = f" — {event.get('detail')}" if event.get("detail") else ""
    side = "Opponent · " if team == "opponent" else ""
    return f"{icons.get(event.get('event_type'), '•')} **{minute}{side}{player}{second}**{detail}"


def broadcast_embed(scrim: dict) -> discord.Embed:
    broadcast = scrim.get("broadcast") or {}
    home = int(broadcast.get("home_score", 0))
    away = int(broadcast.get("away_score", 0))
    phase = phase_label(str(broadcast.get("phase", "pre_match")))
    color = GREEN if phase == "FULL-TIME" else YELLOW if phase == "HALF-TIME" else BLUE
    embed = pja_embed(
        f"📺 PJA TV — {phase}",
        f"## Project Azure  **{home} — {away}**  {scrim.get('opponent', 'Opponent')}\n"
        f"**{scrim.get('match_type', 'Match')}** · {scrim.get('match_time', 'TBD')}",
        color,
    )
    events = (broadcast.get("events") or [])[-10:]
    embed.add_field(name="Live Timeline", value="\n".join(event_line(e) for e in events) if events else "The broadcast is live. Match events will appear here.", inline=False)
    lineup = scrim.get("lineup_v2") or {}
    if lineup.get("published"):
        starters = [p.get("username", "Player") for p in lineup.get("players", []) if p.get("slot") == "starter"]
        embed.add_field(name="Starting Lineup", value=" · ".join(starters[:11]) or "—", inline=False)
    if broadcast.get("motm"):
        embed.add_field(name="⭐ Player of the Match", value=broadcast["motm"], inline=True)
    if broadcast.get("summary"):
        embed.add_field(name="Match Report", value=str(broadcast["summary"])[:1000], inline=False)
    embed.set_footer(text="Project Azure • PJA TV • Live data from the manager controls")
    return embed


def result_graphic(scrim: dict) -> io.BytesIO:
    """Create a high-resolution, mobile-readable full-time graphic."""
    width, height = 1800, 1080
    image = Image.new("RGB", (width, height), (4, 10, 22))
    draw = ImageDraw.Draw(image)
    broadcast = scrim.get("broadcast") or {}
    home, away = int(broadcast.get("home_score", 0)), int(broadcast.get("away_score", 0))

    def fit_font(text: str, max_width: int, start_size: int, min_size: int = 24, bold: bool = True):
        size = start_size
        while size > min_size and draw.textbbox((0, 0), text, font=_font(size, bold))[2] > max_width:
            size -= 2
        return _font(size, bold)

    def ellipsize(text: str, max_width: int, font) -> str:
        value = str(text)
        if draw.textbbox((0, 0), value, font=font)[2] <= max_width:
            return value
        while value and draw.textbbox((0, 0), value + "…", font=font)[2] > max_width:
            value = value[:-1]
        return value.rstrip() + "…"

    def wrap_items(items: list[str], max_width: int, font, max_lines: int = 2) -> list[str]:
        lines: list[str] = []
        current = ""
        for item in items:
            candidate = item if not current else f"{current}  •  {item}"
            if draw.textbbox((0, 0), candidate, font=font)[2] <= max_width:
                current = candidate
            else:
                if current:
                    lines.append(current)
                current = item
                if len(lines) == max_lines - 1:
                    break
        if current and len(lines) < max_lines:
            lines.append(ellipsize(current, max_width, font))
        return lines[:max_lines]

    def wrap_pixels(text: str, max_width: int, font, max_lines: int = 3) -> list[str]:
        words = str(text).split()
        if not words:
            return []
        lines: list[str] = []
        current = words[0]
        for word in words[1:]:
            candidate = f"{current} {word}"
            if draw.textbbox((0, 0), candidate, font=font)[2] <= max_width:
                current = candidate
            else:
                lines.append(current)
                current = word
                if len(lines) == max_lines - 1:
                    break
        if len(lines) < max_lines:
            remaining_start = sum(len(line.split()) for line in lines)
            remaining = words[remaining_start:]
            current = " ".join(remaining) if remaining else current
            while current and draw.textbbox((0, 0), current, font=font)[2] > max_width:
                current = current[:-2].rstrip() + "…"
            if current:
                lines.append(current)
        return lines[:max_lines]

    for y in range(height):
        t = y / height
        draw.line((0, y, width, y), fill=(int(5 + 12*t), int(15 + 45*t), int(35 + 80*t)))

    draw.rounded_rectangle((70, 50, width - 70, height - 50), radius=48, fill=(5, 17, 36), outline=(67, 199, 255), width=6)
    draw.text(
        (width // 2, 130), "PJA TV • FULL-TIME", anchor="mm",
        font=_font(82, True), fill=(112, 220, 255), stroke_width=2, stroke_fill=(2, 8, 18),
    )

    opponent = str(scrim.get("opponent", "OPPONENT")).upper()
    home_name = "PROJECT AZURE"
    home_font = fit_font(home_name, 650, 88, 40)
    away_font = fit_font(opponent, 650, 88, 40)
    home_label = ellipsize(home_name, 650, home_font)
    away_label = ellipsize(opponent, 650, away_font)
    draw.text((450, 335), home_label, anchor="mm", font=home_font, fill=(245, 250, 255), stroke_width=3, stroke_fill=(2, 8, 18))
    draw.text((1350, 335), away_label, anchor="mm", font=away_font, fill=(245, 250, 255), stroke_width=3, stroke_fill=(2, 8, 18))

    draw.text(
        (width // 2, 440), f"{home}  —  {away}", anchor="mm",
        font=_font(250, True), fill=(255, 211, 78), stroke_width=4, stroke_fill=(2, 8, 18),
    )

    scorers = [e for e in broadcast.get("events", []) if e.get("event_type") == "goal"]
    if scorers:
        scorer_parts = []
        for event in scorers[-8:]:
            side = "OPP " if event.get("team") == "opponent" else ""
            minute = f" {event.get('minute')}′" if event.get("minute") else ""
            scorer_parts.append(f"{side}{event.get('player', 'Player')}{minute}")
        scorer_font = _font(46, True)
        scorer_lines = wrap_items(scorer_parts, 1480, scorer_font, max_lines=2)
        scorer_y = 595 if len(scorer_lines) > 1 else 625
        for index, line in enumerate(scorer_lines):
            draw.text((width // 2, scorer_y + index * 62), line, anchor="mm", font=scorer_font, fill=(222, 235, 248), stroke_width=2, stroke_fill=(2, 8, 18))
    else:
        draw.text((width // 2, 630), "NO GOAL SCORERS RECORDED", anchor="mm", font=_font(44, True), fill=(150, 174, 204))

    if broadcast.get("motm"):
        draw.rounded_rectangle((380, 690, 1420, 845), radius=30, fill=(17, 43, 72), outline=(255, 211, 78), width=5)
        draw.text((width // 2, 738), "PLAYER OF THE MATCH", anchor="mm", font=_font(44, True), fill=(255, 211, 78), stroke_width=2, stroke_fill=(2, 8, 18))
        motm = str(broadcast["motm"])
        draw.text((width // 2, 805), motm, anchor="mm", font=fit_font(motm, 850, 70, 42), fill=(255, 255, 255), stroke_width=2, stroke_fill=(2, 8, 18))

    summary = str(broadcast.get("summary") or "Project Azure match complete.")
    summary_font = _font(46, True)
    summary_lines = wrap_pixels(summary, 1500, summary_font, max_lines=3)
    summary_y = 875 if broadcast.get("motm") else 735
    for index, line in enumerate(summary_lines):
        draw.text((width // 2, summary_y + index * 58), line, anchor="mm", font=summary_font, fill=(190, 211, 235), stroke_width=2, stroke_fill=(2, 8, 18))

    draw.text((width - 105, height - 55), "PROJECT AZURE", anchor="rb", font=_font(38, True), fill=(112, 220, 255), stroke_width=1, stroke_fill=(2, 8, 18))
    out = io.BytesIO()
    image.save(out, "PNG", optimize=True)
    out.seek(0)
    return out


async def resolve_scrim(scrim_id: Optional[str]) -> dict:
    if scrim_id:
        return await api.get_scrim(scrim_id)
    payload = await api.get_next_match()
    scrim = payload.get("match")
    if not scrim:
        raise APIError(404, "No upcoming match is currently scheduled")
    return scrim


async def update_broadcast_message(bot: commands.Bot, scrim: dict, fallback_channel: Optional[discord.abc.Messageable] = None):
    broadcast = scrim.get("broadcast") or {}
    channel_id = str(broadcast.get("channel_id") or scrim.get("discord_channel_id") or "")
    message_id = str(broadcast.get("message_id") or "")
    channel = bot.get_channel(int(channel_id)) if channel_id.isdigit() else None
    if channel and message_id.isdigit():
        try:
            message = await channel.fetch_message(int(message_id))
            await message.edit(embed=broadcast_embed(scrim))
            return message
        except (discord.NotFound, discord.Forbidden, discord.HTTPException):
            pass
    if fallback_channel:
        view = None
        if PUBLIC_PORTAL_URL:
            view = discord.ui.View()
            view.add_item(discord.ui.Button(label="Open PJA TV", url=f"{PUBLIC_PORTAL_URL}?page=tv", emoji="📺"))
        return await fallback_channel.send(embed=broadcast_embed(scrim), view=view)
    return None


class BroadcastCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    async def handle_remote_update(self, scrim: dict, finished: bool = False):
        """Mirror website PJA TV controls into Discord without duplicate posts."""
        from cogs.scrims import configured_channel_for
        target_channel = None
        broadcast = scrim.get("broadcast") or {}
        channel_id = str(broadcast.get("channel_id") or scrim.get("discord_channel_id") or "")
        if channel_id.isdigit():
            target_channel = self.bot.get_channel(int(channel_id))
        if target_channel is None:
            for guild in self.bot.guilds:
                try:
                    settings = await api.get_scrim_channels(str(guild.id))
                except APIError:
                    continue
                target_channel = configured_channel_for(guild, settings, scrim.get("match_type", "League"))
                if target_channel:
                    break
        if target_channel is None:
            print(f"[PJA TV] No configured channel for website broadcast {scrim.get('id')}")
            return
        message = await update_broadcast_message(self.bot, scrim, target_channel)
        if message and not broadcast.get("message_id") and not finished:
            try:
                await api.start_broadcast(scrim["id"], str(scrim.get("source", "Website")), str(message.channel.id), str(message.id))
            except APIError as error:
                print(f"[PJA TV] Could not save broadcast message: {error}")
        if finished:
            graphic = await asyncio.to_thread(result_graphic, scrim)
            await target_channel.send(file=discord.File(graphic, filename=f"pja-result-{scrim.get('id','match')}.png"))

    group = app_commands.Group(name="broadcast", description="PJA TV live match broadcast controls")

    @group.command(name="start", description="Start PJA TV for an upcoming match")
    @is_manager()
    @app_commands.describe(scrim_id="Scrim ID; leave blank to use the next match")
    async def start(self, interaction: discord.Interaction, scrim_id: str = ""):
        await interaction.response.defer(ephemeral=True)
        try:
            scrim = await resolve_scrim(scrim_id or None)
            initial = await api.start_broadcast(scrim["id"], str(interaction.user))
            configured = self.bot.get_channel(int(str(scrim.get("discord_channel_id")))) if str(scrim.get("discord_channel_id", "")).isdigit() else None
            message = await update_broadcast_message(self.bot, initial, configured or interaction.channel)
            if message:
                scrim = await api.start_broadcast(scrim["id"], str(interaction.user), str(message.channel.id), str(message.id))
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True); return
        await interaction.followup.send(embed=pja_embed("PJA TV Is Live", f"Broadcast started for **Project Azure vs {scrim.get('opponent')}**.", GREEN), ephemeral=True)

    @group.command(name="event", description="Add a live match event and update the PJA TV scoreboard")
    @is_manager()
    @app_commands.choices(event_type=[
        app_commands.Choice(name="Goal", value="goal"), app_commands.Choice(name="Assist", value="assist"),
        app_commands.Choice(name="Big Save", value="save"), app_commands.Choice(name="Substitution", value="substitution"),
        app_commands.Choice(name="Yellow Card", value="yellow"), app_commands.Choice(name="Red Card", value="red"),
        app_commands.Choice(name="Match Note", value="note"),
    ])
    async def event(self, interaction: discord.Interaction, event_type: str, player: str = "", minute: str = "", detail: str = "", secondary_player: str = "", home_score: int = None, away_score: int = None, scrim_id: str = ""):
        await interaction.response.defer(ephemeral=True)
        try:
            scrim = await resolve_scrim(scrim_id or None)
            updated = await api.add_broadcast_event(
                scrim["id"], event_type=event_type, player=player, secondary_player=secondary_player,
                minute=minute, detail=detail, home_score=home_score, away_score=away_score, actor=str(interaction.user),
            )
            await update_broadcast_message(self.bot, updated, interaction.channel)
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True); return
        await interaction.followup.send(embed=pja_embed("Broadcast Updated", "The PJA TV scoreboard and timeline were updated.", GREEN), ephemeral=True)

    @group.command(name="halftime", description="Mark the current PJA TV broadcast as half-time")
    @is_manager()
    async def halftime(self, interaction: discord.Interaction, scrim_id: str = ""):
        await interaction.response.defer(ephemeral=True)
        try:
            scrim = await resolve_scrim(scrim_id or None)
            updated = await api.halftime_broadcast(scrim["id"])
            await update_broadcast_message(self.bot, updated, interaction.channel)
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True); return
        await interaction.followup.send(embed=pja_embed("Half-Time", "PJA TV now shows half-time.", YELLOW), ephemeral=True)

    @group.command(name="finish", description="Finish a PJA TV broadcast and create the full-time graphic")
    @is_manager()
    async def finish(self, interaction: discord.Interaction, home_score: int, away_score: int, motm: str = "", summary: str = "", scrim_id: str = ""):
        await interaction.response.defer(ephemeral=True)
        try:
            scrim = await resolve_scrim(scrim_id or None)
            updated = await api.finish_broadcast(scrim["id"], home_score, away_score, motm, summary, str(interaction.user))
            message = await update_broadcast_message(self.bot, updated, interaction.channel)
            graphic = await asyncio.to_thread(result_graphic, updated)
            target = message.channel if message else interaction.channel
            await target.send(file=discord.File(graphic, filename=f"pja-result-{scrim['id']}.png"))
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True); return
        await interaction.followup.send(embed=pja_embed("Full-Time Published", "The broadcast was finished and the result graphic was posted.", GREEN), ephemeral=True)


async def setup(bot):
    await bot.add_cog(BroadcastCog(bot))
