import asyncio
import io
import math
import os
import random
import re
import sys
from typing import Iterable

import discord
from discord import app_commands
from discord.ext import commands
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from utils.helpers import *

FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_CONDENSED = "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf"

THEMES = {
    "azure": {
        "top": (4, 23, 57), "bottom": (13, 83, 188), "accent": (69, 211, 255),
        "edge": (155, 231, 255), "text": (248, 252, 255), "muted": (190, 220, 246),
        "label": "AZURE", "foil": False,
    },
    "pro": {
        "top": (31, 8, 69), "bottom": (15, 72, 169), "accent": (222, 83, 255),
        "edge": (99, 236, 255), "text": (255, 250, 255), "muted": (223, 204, 248),
        "label": "PRO", "foil": False,
    },
    "elite": {
        "top": (12, 10, 7), "bottom": (76, 45, 5), "accent": (255, 198, 56),
        "edge": (255, 238, 168), "text": (255, 254, 239), "muted": (235, 213, 153),
        "label": "ELITE", "foil": True,
    },
}

POSITION_SHORT = {
    "Goalkeeper": "GK", "Defender": "DEF", "Midfielder": "MID",
    "Winger": "WNG", "Striker": "ST", "Sweeper": "SWP",
}


def font(path: str, size: int):
    try:
        return ImageFont.truetype(path, size=size)
    except OSError:
        return ImageFont.load_default()


def fit_font(text: str, path: str, max_size: int, min_size: int, max_width: int):
    for size in range(max_size, min_size - 1, -2):
        candidate = font(path, size)
        bbox = candidate.getbbox(text)
        if bbox[2] - bbox[0] <= max_width:
            return candidate
    return font(path, min_size)


def blend(a, b, t):
    return tuple(round(a[i] * (1 - t) + b[i] * t) for i in range(3))


def theme_from_inventory(inventory: Iterable[dict]) -> str:
    ids = {entry.get("item_id") for entry in inventory}
    if "elite-card-theme" in ids:
        return "elite"
    if "card-theme-unlock" in ids:
        return "pro"
    return "azure"


def result_code(result: str) -> str:
    text = str(result or "").strip().upper()
    if text.startswith("W") or " WIN" in f" {text}":
        return "W"
    if text.startswith("L") or " LOSS" in f" {text}":
        return "L"
    if text.startswith("D") or " DRAW" in f" {text}":
        return "D"
    match = re.search(r"(\d+)\s*[-:]\s*(\d+)", text)
    if match:
        home, away = int(match.group(1)), int(match.group(2))
        return "W" if home > away else "L" if home < away else "D"
    return "–"


def clean_sheet(result: str) -> bool:
    match = re.search(r"(\d+)\s*[-:]\s*(\d+)", str(result or ""))
    return bool(match and int(match.group(2)) == 0)


def _shield_mask(size: tuple[int, int]) -> Image.Image:
    width, height = size
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((74, 50, width - 74, height - 250), radius=145, fill=255)
    draw.polygon([
        (120, height - 470), (width - 120, height - 470),
        (width - 250, height - 80), (width // 2, height - 22), (250, height - 80),
    ], fill=255)
    return mask


def _gradient_layer(size, mask, top, bottom):
    width, height = size
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for y in range(height):
        color = blend(top, bottom, y / max(1, height - 1))
        draw.line((0, y, width, y), fill=(*color, 255))
    layer.putalpha(mask)
    return layer


def _draw_elite_foil(image: Image.Image, mask: Image.Image, theme: dict, seed: int):
    width, height = image.size
    rng = random.Random(seed)
    foil = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(foil)

    center = (width // 2, 690)
    for angle in range(0, 360, 12):
        radians = math.radians(angle)
        length = 950
        end = (center[0] + int(math.cos(radians) * length), center[1] + int(math.sin(radians) * length))
        alpha = 18 if angle % 24 else 34
        draw.line((center, end), fill=(255, 224, 128, alpha), width=10)

    for _ in range(180):
        x = rng.randint(100, width - 100)
        y = rng.randint(70, height - 100)
        radius = rng.choice((1, 2, 3, 5, 8))
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(255, 240, 174, rng.randint(22, 105)))

    # Flowing gold foil ribbons.
    for offset, alpha, width_px in ((0, 120, 14), (55, 70, 8), (-70, 60, 8)):
        points = []
        for x in range(70, width - 50, 16):
            y = 940 + offset + int(80 * math.sin((x + seed % 100) / 115))
            points.append((x, y))
        draw.line(points, fill=(*theme["accent"], alpha), width=width_px, joint="curve")

    foil = foil.filter(ImageFilter.GaussianBlur(2))
    foil.putalpha(Image.composite(foil.getchannel("A"), Image.new("L", image.size, 0), mask))
    image.alpha_composite(foil)


def render_card(avatar_bytes: bytes, player: dict, totals: dict, balance: int, inventory: list, seed: int) -> io.BytesIO:
    width, height = 1200, 1700
    theme_name = theme_from_inventory(inventory)
    theme = THEMES[theme_name]
    rng = random.Random(seed)

    image = Image.new("RGBA", (width, height), (3, 7, 15, 255))
    mask = _shield_mask(image.size)

    # Atmospheric glow surrounding the card.
    atmosphere = Image.new("RGBA", image.size, (0, 0, 0, 0))
    ad = ImageDraw.Draw(atmosphere)
    ad.ellipse((-300, -100, 1500, 1750), fill=(*theme["accent"], 65 if not theme["foil"] else 82))
    atmosphere = atmosphere.filter(ImageFilter.GaussianBlur(150))
    image.alpha_composite(atmosphere)

    card = _gradient_layer(image.size, mask, theme["top"], theme["bottom"])
    image.alpha_composite(card)

    # Organic texture, not rectangular stat boxes.
    texture = Image.new("RGBA", image.size, (0, 0, 0, 0))
    td = ImageDraw.Draw(texture)
    for _ in range(90):
        x, y = rng.randint(90, width - 90), rng.randint(80, height - 110)
        r = rng.randint(2, 10)
        td.ellipse((x-r, y-r, x+r, y+r), fill=(*theme["edge"], rng.randint(15, 75)))
    for offset, alpha in ((0, 70), (45, 38), (-55, 30)):
        pts = [(x, 1130 + offset + int(70 * math.sin((x + seed % 90) / 125))) for x in range(70, width - 50, 18)]
        td.line(pts, fill=(*theme["accent"], alpha), width=8, joint="curve")
    texture = texture.filter(ImageFilter.GaussianBlur(2))
    texture.putalpha(Image.composite(texture.getchannel("A"), Image.new("L", image.size, 0), mask))
    image.alpha_composite(texture)

    if theme["foil"]:
        _draw_elite_foil(image, mask, theme, seed)

    # Layered illuminated edge.
    outer = mask.filter(ImageFilter.GaussianBlur(16))
    inner = mask.filter(ImageFilter.GaussianBlur(2))
    edge_mask = Image.new("L", image.size, 0)
    edge_px, out_px, in_px = edge_mask.load(), outer.load(), inner.load()
    for y in range(height):
        for x in range(width):
            edge_px[x, y] = max(0, out_px[x, y] - in_px[x, y])
    edge_layer = Image.new("RGBA", image.size, (*theme["edge"], 0))
    edge_layer.putalpha(edge_mask.point(lambda value: min(240, value * (4 if theme["foil"] else 3))))
    image.alpha_composite(edge_layer)

    draw = ImageDraw.Draw(image)

    # Elite crown and premium serial.
    if theme["foil"]:
        crown_y = 96
        crown = [(520, crown_y + 36), (555, crown_y), (600, crown_y + 34), (645, crown_y), (680, crown_y + 36), (665, crown_y + 76), (535, crown_y + 76)]
        draw.polygon(crown, fill=(255, 213, 82, 245), outline=(255, 247, 190, 255))
        draw.text((600, 205), "PROJECT AZURE ELITE", anchor="mm", font=font(FONT_BOLD, 48), fill=theme["text"])
    else:
        draw.text((600, 145), "PROJECT AZURE", anchor="mm", font=font(FONT_BOLD, 52), fill=theme["text"])
        draw.text((600, 205), f"PLAYER CARD  •  {theme['label']}", anchor="mm", font=font(FONT_REGULAR, 34), fill=theme["edge"])

    # Rating and position are intentionally large for phone previews.
    overall = int(player.get("overall", 0) or 0)
    position = POSITION_SHORT.get(player.get("position", ""), str(player.get("position", "—"))[:3].upper())
    draw.text((205, 300), str(overall), anchor="mm", font=font(FONT_CONDENSED, 180), fill=theme["text"], stroke_width=3, stroke_fill=theme["top"])
    draw.text((205, 425), position, anchor="mm", font=font(FONT_BOLD, 64), fill=theme["accent"])
    draw.text((205, 482), theme["label"], anchor="mm", font=font(FONT_BOLD, 32), fill=theme["muted"])

    # PJA crest.
    draw.ellipse((910, 235, 1070, 395), fill=(4, 12, 28, 210), outline=(*theme["edge"], 255), width=7)
    draw.ellipse((929, 254, 1051, 376), outline=(*theme["accent"], 180), width=3)
    draw.text((990, 315), "PJA", anchor="mm", font=font(FONT_BOLD, 56), fill=theme["text"])

    # Portrait with a strong halo and non-boxed crop.
    avatar = Image.open(io.BytesIO(avatar_bytes)).convert("RGBA")
    avatar = ImageOps.fit(avatar, (570, 570), method=Image.Resampling.LANCZOS)
    avatar_mask = Image.new("L", avatar.size, 0)
    ImageDraw.Draw(avatar_mask).ellipse((8, 8, 562, 562), fill=255)
    avatar.putalpha(avatar_mask)
    halo = Image.new("RGBA", image.size, (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    hd.ellipse((310, 270, 890, 850), fill=(*theme["accent"], 130 if theme["foil"] else 100))
    halo = halo.filter(ImageFilter.GaussianBlur(42))
    image.alpha_composite(halo)
    image.alpha_composite(avatar, (315, 280))
    draw = ImageDraw.Draw(image)
    draw.ellipse((315, 280, 885, 850), outline=(*theme["edge"], 255), width=10)
    draw.ellipse((334, 299, 866, 831), outline=(*theme["accent"], 125), width=4)

    # Player identity - much larger than the old card.
    name = str(player.get("username") or player.get("discord_tag") or "PJA PLAYER").upper()
    name_font = fit_font(name, FONT_CONDENSED, 112, 36, 980)
    draw.text((600, 940), name, anchor="mm", font=name_font, fill=theme["text"], stroke_width=3, stroke_fill=theme["top"])
    subtitle = f"{player.get('position', 'Player')}  •  {player.get('status', 'Active')}"
    subtitle_font = fit_font(subtitle, FONT_BOLD, 44, 28, 950)
    draw.text((600, 1025), subtitle, anchor="mm", font=subtitle_font, fill=theme["muted"])

    if theme["foil"]:
        title = str(player.get("title") or "PJA ELITE MEMBER").upper()
        draw.text((600, 1085), title, anchor="mm", font=fit_font(title, FONT_BOLD, 42, 28, 900), fill=theme["accent"])

    # Six large floating stats.
    stats = [
        ("MATCHES", totals.get("matches", 0)),
        ("GOALS", totals.get("goals", 0)),
        ("ASSISTS", totals.get("assists", 0)),
        ("SAVES", totals.get("saves", 0)),
        ("TACKLES", totals.get("tackles", 0)),
        ("POINTS", balance),
    ]
    x_positions = [255, 600, 945]
    y_positions = [1200, 1410]
    for idx, (label, value) in enumerate(stats):
        x, y = x_positions[idx % 3], y_positions[idx // 3]
        # A subtle circular halo rather than a square stat box.
        stat_glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
        sg = ImageDraw.Draw(stat_glow)
        sg.ellipse((x - 125, y - 100, x + 125, y + 100), fill=(*theme["accent"], 22 if not theme["foil"] else 32))
        stat_glow = stat_glow.filter(ImageFilter.GaussianBlur(28))
        image.alpha_composite(stat_glow)
        draw = ImageDraw.Draw(image)
        value_text = f"{int(value):,}"
        value_font = fit_font(value_text, FONT_CONDENSED, 108, 58, 285)
        draw.text((x, y - 12), value_text, anchor="mm", font=value_font, fill=theme["text"])
        draw.text((x, y + 76), label, anchor="mm", font=font(FONT_BOLD, 36), fill=theme["accent"])

    # Elite-only live form and achievement badges.
    if theme["foil"]:
        form = totals.get("form", [])[-5:]
        draw.text((210, 1542), "RECENT FORM", anchor="lm", font=font(FONT_BOLD, 34), fill=theme["muted"])
        form_colors = {"W": (76, 220, 126), "D": (174, 190, 210), "L": (245, 92, 92), "–": (120, 130, 145)}
        start_x = 490
        for index, code in enumerate(form or ["–"]):
            cx = start_x + index * 68
            draw.ellipse((cx - 30, 1512, cx + 30, 1572), fill=(*form_colors.get(code, form_colors["–"]), 235), outline=(255, 244, 185, 190), width=2)
            draw.text((cx, 1542), code, anchor="mm", font=font(FONT_BOLD, 30), fill=(8, 10, 13))
        badge_text = f"MOTM ×{totals.get('motm', 0)}   •   CLEAN SHEETS ×{totals.get('clean_sheets', 0)}"
        draw.text((600, 1610), badge_text, anchor="mm", font=font(FONT_BOLD, 34), fill=theme["edge"])
        draw.text((600, 1652), f"ELITE #{seed % 100000:05d}", anchor="mm", font=font(FONT_BOLD, 28), fill=theme["muted"])
    else:
        draw.text((600, 1572), "PJA  •  VRFS", anchor="mm", font=font(FONT_BOLD, 34), fill=theme["muted"])
        draw.text((600, 1628), "BUILT FROM APPROVED MATCH STATS", anchor="mm", font=font(FONT_REGULAR, 28), fill=theme["edge"])

    output = io.BytesIO()
    image.convert("RGB").save(output, format="PNG", optimize=True, quality=96)
    output.seek(0)
    return output


class CardsCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    card_group = app_commands.Group(name="card", description="Project Azure player card commands")

    @card_group.command(name="view", description="Generate a high-resolution PJA football player card")
    @app_commands.describe(player="Player to generate; leave blank for yourself")
    async def view(self, interaction: discord.Interaction, player: discord.Member = None):
        target = player or interaction.user
        await interaction.response.defer()
        try:
            roster_player = await api.get_player(str(target.id))
            if not roster_player:
                await interaction.followup.send(embed=pja_embed("Not on Roster", f"{target.mention} must be on the PJA roster first.", RED), ephemeral=True)
                return
            stats = await api.get_player_stats(str(target.id))
            points = await api.get_points(str(target.id))
            history = await api.get_points_history(str(target.id))
            inventory = await api.get_inventory(str(target.id))
            public_profile = await api.get_public_profile(str(target.id))
        except APIError as error:
            if error.status == 404:
                stats = {}
                history = []
                try:
                    points = await api.get_points(str(target.id))
                    inventory = await api.get_inventory(str(target.id))
                    public_profile = await api.get_public_profile(str(target.id))
                except APIError as inner:
                    await interaction.followup.send(embed=api_error_embed(inner), ephemeral=True)
                    return
            else:
                await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
                return

        records = sorted(stats.values(), key=lambda record: record.get("reviewed_at") or record.get("submitted_at") or "")
        totals = {
            "matches": len(records),
            "goals": sum(record.get("goals", 0) for record in records),
            "assists": sum(record.get("assists", 0) for record in records),
            "saves": sum(record.get("saves", 0) for record in records),
            "tackles": sum(record.get("tackles", 0) for record in records),
            "clean_sheets": sum(1 for record in records if clean_sheet(record.get("result", ""))),
            "motm": sum(1 for entry in history if entry.get("category") == "motm" and int(entry.get("amount", 0)) > 0),
            "form": [result_code(record.get("result", "")) for record in records[-5:]],
        }
        avatar_bytes = await target.display_avatar.with_size(1024).read()
        card_buffer = await asyncio.to_thread(
            render_card,
            avatar_bytes,
            roster_player,
            totals,
            int(points.get("balance", 0)),
            inventory,
            target.id,
        )
        theme_name = theme_from_inventory(inventory)
        filename = f"pja-{theme_name}-card-{target.id}.png"
        view = None
        if PUBLIC_PORTAL_URL:
            view = discord.ui.View()
            view.add_item(discord.ui.Button(
                label="View Full Profile",
                url=f"{PUBLIC_PORTAL_URL}?page=profile&player={public_profile.get('player', {}).get('profile_key', '')}",
                emoji="👤",
            ))
        await interaction.followup.send(
            content=f"**{target.display_name}'s Project Azure {theme_name.title()} Card**",
            file=discord.File(card_buffer, filename=filename),
            view=view,
        )


async def setup(bot):
    await bot.add_cog(CardsCog(bot))
