import asyncio
import io
import os
import sys
from typing import Any

import discord
from discord.ext import commands
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from utils.helpers import api, api_error_embed, pja_embed, BLUE, DARK, PUBLIC_PORTAL_URL, APIError

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def _font(size: int, bold: bool = False):
    try:
        return ImageFont.truetype(FONT_BOLD if bold else FONT, size)
    except OSError:
        return ImageFont.load_default()


def _fit(text: str, max_size: int, min_size: int, width: int):
    for size in range(max_size, min_size - 1, -2):
        f = _font(size, True)
        if f.getbbox(text)[2] <= width:
            return f
    return _font(min_size, True)


def render_lineup_image(match: dict[str, Any], lineup: dict[str, Any]) -> io.BytesIO:
    width, height = 1400, 1000
    image = Image.new("RGB", (width, height), (5, 14, 28))
    draw = ImageDraw.Draw(image)

    # Header
    draw.rounded_rectangle((35, 25, width - 35, 150), radius=28, fill=(10, 30, 57), outline=(59, 130, 246), width=3)
    header_text = "PROJECT AZURE — STARTING LINEUP"
    draw.text((70, 48), header_text, font=_fit(header_text, 46, 34, 880), fill=(240, 248, 255))
    title = f"{match.get('match_type', 'Match')} vs {match.get('opponent', 'Opponent')}"
    draw.text((70, 108), title, font=_fit(title, 36, 18, 870), fill=(128, 211, 255))
    draw.text((width - 70, 70), str(match.get("match_time", "TBD")), anchor="ra", font=_font(29, True), fill=(210, 225, 243))
    formation = str((lineup.get("tactics") or {}).get("formation", "Custom"))
    draw.text((width - 70, 112), formation, anchor="ra", font=_font(34, True), fill=(250, 204, 70))

    # Real pitch
    px1, py1, px2, py2 = 55, 180, 1015, 945
    draw.rounded_rectangle((px1, py1, px2, py2), radius=18, fill=(20, 103, 57), outline=(226, 255, 234), width=5)
    stripe_h = (py2 - py1) / 10
    for i in range(10):
        if i % 2 == 0:
            draw.rectangle((px1 + 4, int(py1 + i * stripe_h), px2 - 4, int(py1 + (i + 1) * stripe_h)), fill=(24, 113, 63))
    cx, cy = (px1 + px2) // 2, (py1 + py2) // 2
    draw.line((cx, py1, cx, py2), fill=(230, 255, 235), width=4)
    draw.ellipse((cx - 95, cy - 95, cx + 95, cy + 95), outline=(230, 255, 235), width=4)
    draw.ellipse((cx - 5, cy - 5, cx + 5, cy + 5), fill=(230, 255, 235))
    draw.rectangle((px1, cy - 170, px1 + 130, cy + 170), outline=(230, 255, 235), width=4)
    draw.rectangle((px2 - 130, cy - 170, px2, cy + 170), outline=(230, 255, 235), width=4)
    draw.rectangle((px1, cy - 72, px1 + 45, cy + 72), outline=(230, 255, 235), width=4)
    draw.rectangle((px2 - 45, cy - 72, px2, cy + 72), outline=(230, 255, 235), width=4)

    starters = [p for p in lineup.get("players", []) if p.get("slot") == "starter"]
    bench = [p for p in lineup.get("players", []) if p.get("slot") == "bench"]
    reserves = [p for p in lineup.get("players", []) if p.get("slot") == "reserve"]
    tactics = lineup.get("tactics") or {}

    for p in starters:
        x = px1 + int(float(p.get("x", 50)) / 100 * (px2 - px1))
        y = py1 + int(float(p.get("y", 50)) / 100 * (py2 - py1))
        draw.ellipse((x - 42, y - 42, x + 42, y + 42), fill=(8, 22, 43), outline=(94, 220, 255), width=4)
        initials = "".join(part[:1] for part in str(p.get("username", "P")).split()[:2]).upper() or "P"
        draw.text((x, y - 2), initials, anchor="mm", font=_font(34, True), fill=(255, 255, 255))
        name = str(p.get("username", "Player"))
        draw.rounded_rectangle((x - 96, y + 46, x + 96, y + 92), radius=10, fill=(4, 16, 31))
        draw.text((x, y + 69), name, anchor="mm", font=_fit(name, 24, 15, 178), fill=(242, 249, 255))
        role = str(p.get("role", ""))
        if role:
            draw.text((x, y + 108), role, anchor="mm", font=_font(18, True), fill=(255, 216, 91))

    # Bench and tactics panel
    sx1, sx2 = 1045, width - 35
    draw.rounded_rectangle((sx1, 180, sx2, 945), radius=20, fill=(9, 25, 47), outline=(35, 70, 110), width=2)
    draw.text((sx1 + 24, 205), "BENCH", font=_font(34, True), fill=(128, 211, 255))
    y = 258
    shown_bench = bench[:6]
    for index, p in enumerate(shown_bench, start=1):
        full_name = f"{index}. {p.get('username', 'Player')}"
        draw.text((sx1 + 28, y), full_name, font=_fit(full_name, 25, 17, 300), fill=(239, 246, 255))
        y += 48
    if len(bench) > len(shown_bench):
        draw.text((sx1 + 28, y), f"+{len(bench) - len(shown_bench)} more on bench", font=_font(20, True), fill=(143, 190, 220))
        y += 38
    if not bench:
        draw.text((sx1 + 28, y), "No substitutes listed", font=_font(22), fill=(143, 160, 183))
        y += 48

    if reserves:
        draw.text((sx1 + 24, y + 10), "RESERVES", font=_font(28, True), fill=(250, 204, 70))
        y += 54
        shown_reserves = reserves[:3]
        for p in shown_reserves:
            reserve_name = f"• {p.get('username', 'Player')}"
            draw.text((sx1 + 28, y), reserve_name, font=_fit(reserve_name, 22, 16, 300), fill=(215, 225, 239))
            y += 38
        if len(reserves) > len(shown_reserves):
            draw.text((sx1 + 28, y), f"+{len(reserves) - len(shown_reserves)} more reserves", font=_font(19, True), fill=(184, 197, 215))
            y += 34

    y = max(y + 14, 620)
    draw.line((sx1 + 24, y, sx2 - 24, y), fill=(45, 76, 111), width=3)
    y += 22
    draw.text((sx1 + 24, y), "TACTICS", font=_font(30, True), fill=(128, 211, 255)); y += 46
    rows = [
        ("Attack", tactics.get("attacking_style", "Balanced")),
        ("Passing", tactics.get("passing_style", "Mixed")),
        ("Tempo", tactics.get("tempo", "Balanced")),
        ("Pressing", tactics.get("pressing", "Balanced")),
        ("Def. line", tactics.get("defensive_line", "Balanced")),
        ("Marking", tactics.get("marking", "Zonal")),
    ]
    for label, value in rows:
        draw.text((sx1 + 28, y), f"{label}:", font=_font(20, True), fill=(154, 174, 199))
        draw.text((sx1 + 155, y), str(value), font=_fit(str(value), 20, 14, 175), fill=(240, 246, 255))
        y += 36
    captain_id = str(tactics.get("captain_id", ""))
    captain = next((p.get("username") for p in lineup.get("players", []) if str(p.get("discord_id")) == captain_id), "—")
    captain_text = f"Captain: {captain}"
    draw.text((sx1 + 28, y + 8), captain_text, font=_fit(captain_text, 23, 16, 305), fill=(255, 216, 91))

    draw.text((width - 45, height - 18), "Project Azure • VRFS", anchor="rb", font=_font(22, True), fill=(130, 154, 183))
    output = io.BytesIO()
    image.save(output, "PNG", optimize=True)
    output.seek(0)
    return output


class LineupsCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    @discord.app_commands.command(name="lineup", description="Show the published lineup for the next Project Azure match")
    async def lineup(self, interaction: discord.Interaction):
        await interaction.response.defer()
        try:
            payload = await api.get_next_lineup()
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return

        if payload.get("status") == "no_match":
            await interaction.followup.send(embed=pja_embed("No Upcoming Match", "No upcoming match is currently scheduled.", DARK))
            return
        if payload.get("status") != "published":
            match = payload.get("match") or {}
            await interaction.followup.send(
                embed=pja_embed(
                    "Lineup Not Published",
                    f"The lineup for **{match.get('match_type', 'Match')} vs {match.get('opponent', 'Opponent')}** has not been published yet.",
                    BLUE,
                )
            )
            return

        match = payload["match"]
        lineup = payload["lineup"]
        image = await asyncio.to_thread(render_lineup_image, match, lineup)
        view = None
        if PUBLIC_PORTAL_URL:
            view = discord.ui.View()
            view.add_item(discord.ui.Button(label="Open Scrims Page", url=f"{PUBLIC_PORTAL_URL}?page=scrims", emoji="🌐"))
        await interaction.followup.send(
            content=f"**Next Match: {match.get('match_type', 'Match')} vs {match.get('opponent', 'Opponent')}**",
            file=discord.File(image, filename=f"pja-lineup-{match.get('id', 'next')}.png"),
            view=view,
        )


async def setup(bot):
    await bot.add_cog(LineupsCog(bot))
