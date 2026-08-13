import asyncio
import io
import os
import sys

import discord
from discord import app_commands
from discord.ext import commands
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from utils.helpers import *

FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_CONDENSED = "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf"


def get_font(path: str, size: int):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def fit_font(text: str, path: str, max_size: int, min_size: int, max_width: int):
    for size in range(max_size, min_size - 1, -2):
        candidate = get_font(path, size)
        box = candidate.getbbox(text)
        if box[2] - box[0] <= max_width:
            return candidate
    return get_font(path, min_size)


def format_template(template: str, member: discord.Member) -> str:
    return str(template).replace("{user}", member.mention).replace("{username}", member.display_name).replace(
        "{server}", member.guild.name
    ).replace("{member_count}", str(member.guild.member_count or len(member.guild.members)))


def render_welcome_image(avatar_bytes: bytes, member_name: str, server_name: str, member_count: int) -> io.BytesIO:
    # High-resolution 2.5:1 banner. Text intentionally fills more of the
    # canvas so it remains readable after Discord scales it down on mobile.
    width, height = 1800, 720
    base = Image.new("RGBA", (width, height), (5, 12, 27, 255))

    # Soft Azure atmosphere.
    glow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-320, -300, 1050, 1050), fill=(32, 126, 255, 125))
    gd.ellipse((1040, -340, 2200, 820), fill=(0, 220, 255, 78))
    glow = glow.filter(ImageFilter.GaussianBlur(115))
    base.alpha_composite(glow)

    # Main glass panel.
    panel = Image.new("RGBA", base.size, (0, 0, 0, 0))
    pd = ImageDraw.Draw(panel)
    pd.rounded_rectangle(
        (38, 38, width - 38, height - 38),
        radius=82,
        fill=(8, 20, 42, 230),
        outline=(103, 216, 255, 220),
        width=6,
    )
    for x in range(48, width, 26):
        y = 555 + int(32 * __import__("math").sin(x / 105))
        pd.ellipse((x, y, x + 5, y + 5), fill=(87, 211, 255, 100))
    base.alpha_composite(panel)

    # Large avatar and glow.
    avatar_size = 430
    avatar_x, avatar_y = 92, 145
    avatar = Image.open(io.BytesIO(avatar_bytes)).convert("RGBA")
    avatar = ImageOps.fit(avatar, (avatar_size, avatar_size), method=Image.Resampling.LANCZOS)
    mask = Image.new("L", avatar.size, 0)
    ImageDraw.Draw(mask).ellipse((5, 5, avatar_size - 5, avatar_size - 5), fill=255)
    avatar.putalpha(mask)

    halo = Image.new("RGBA", base.size, (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    hd.ellipse(
        (avatar_x - 35, avatar_y - 35, avatar_x + avatar_size + 35, avatar_y + avatar_size + 35),
        fill=(50, 180, 255, 145),
    )
    halo = halo.filter(ImageFilter.GaussianBlur(34))
    base.alpha_composite(halo)
    base.alpha_composite(avatar, (avatar_x, avatar_y))

    draw = ImageDraw.Draw(base)
    draw.ellipse(
        (avatar_x, avatar_y, avatar_x + avatar_size, avatar_y + avatar_size),
        outline=(184, 242, 255, 255),
        width=11,
    )
    draw.ellipse(
        (avatar_x + 18, avatar_y + 18, avatar_x + avatar_size - 18, avatar_y + avatar_size - 18),
        outline=(46, 151, 255, 210),
        width=4,
    )

    text_x = 590
    text_width = width - text_x - 88

    def emphasized_text(position, value, font, fill, stroke_width=3, stroke_fill=(2, 8, 18, 255)):
        x, y = position
        draw.text(
            (x + 5, y + 6),
            value,
            font=font,
            fill=(0, 0, 0, 185),
            stroke_width=stroke_width + 1,
            stroke_fill=(0, 0, 0, 185),
        )
        draw.text(
            position,
            value,
            font=font,
            fill=fill,
            stroke_width=stroke_width,
            stroke_fill=stroke_fill,
        )

    # Large heading and server name.
    emphasized_text(
        (text_x, 65),
        "WELCOME TO",
        get_font(FONT_BOLD, 70),
        (101, 215, 255, 255),
        stroke_width=2,
    )
    server_text = server_name.upper()
    server_font = fit_font(server_text, FONT_CONDENSED, 128, 40, text_width)
    display_server_text = server_text
    if server_font.getbbox(display_server_text)[2] - server_font.getbbox(display_server_text)[0] > text_width:
        for keep in range(len(server_text) - 1, 4, -1):
            candidate = server_text[:keep].rstrip() + "…"
            if server_font.getbbox(candidate)[2] - server_font.getbbox(candidate)[0] <= text_width:
                display_server_text = candidate
                break
    emphasized_text(
        (text_x, 140),
        display_server_text,
        server_font,
        (250, 253, 255, 255),
        stroke_width=4,
    )

    # Divider gives the username its own clear section.
    draw.rounded_rectangle(
        (text_x, 292, width - 88, 300),
        radius=4,
        fill=(77, 190, 255, 170),
    )

    # Member name is deliberately the largest text on the banner.
    safe_member_name = member_name.strip() or "New Member"
    # Discord display names can be long. Use the condensed face for longer
    # names and keep shrinking until the complete name fits the banner.
    name_font_path = FONT_CONDENSED if len(safe_member_name) > 18 else FONT_BOLD
    name_font = fit_font(safe_member_name, name_font_path, 152, 48, text_width)
    display_member_name = safe_member_name
    if name_font.getbbox(display_member_name)[2] - name_font.getbbox(display_member_name)[0] > text_width:
        for keep in range(len(safe_member_name) - 1, 2, -1):
            candidate = safe_member_name[:keep].rstrip() + "…"
            box = name_font.getbbox(candidate)
            if box[2] - box[0] <= text_width:
                display_member_name = candidate
                break
    emphasized_text(
        (text_x, 316),
        display_member_name,
        name_font,
        (226, 244, 255, 255),
        stroke_width=5,
    )

    # Large member-count badge.
    meta_text = f"MEMBER #{member_count:,}   •   PROJECT AZURE"
    meta_font = fit_font(meta_text, FONT_BOLD, 50, 34, text_width - 42)
    meta_box = (text_x, 510, width - 88, 582)
    draw.rounded_rectangle(
        meta_box,
        radius=28,
        fill=(19, 60, 101, 210),
        outline=(104, 211, 255, 190),
        width=3,
    )
    emphasized_text(
        (text_x + 24, 516),
        meta_text,
        meta_font,
        (185, 228, 255, 255),
        stroke_width=2,
    )

    footer_text = "Check the rules, meet the team, and use /portal login."
    footer_font = fit_font(footer_text, FONT_REGULAR, 42, 30, text_width)
    emphasized_text(
        (text_x, 607),
        footer_text,
        footer_font,
        (207, 228, 246, 255),
        stroke_width=2,
    )

    output = io.BytesIO()
    base.convert("RGB").save(output, "PNG", optimize=True)
    output.seek(0)
    return output


class WelcomeLinks(discord.ui.View):
    def __init__(self, rules_url: str = "", portal_url: str = ""):
        super().__init__(timeout=None)
        if rules_url.startswith(("http://", "https://")):
            self.add_item(discord.ui.Button(label="Rules", emoji="📜", url=rules_url))
        if portal_url.startswith(("http://", "https://")):
            self.add_item(discord.ui.Button(label="Player Portal", emoji="⚡", url=portal_url))


class WelcomeCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    welcome = app_commands.Group(name="welcome", description="Project Azure welcomer settings")

    async def _send_welcome(self, member: discord.Member, config: dict, channel: discord.abc.Messageable | None = None, test: bool = False):
        if channel is None:
            channel_id = str(config.get("welcome_channel_id", ""))
            channel = member.guild.get_channel(int(channel_id)) if channel_id.isdigit() else None
        if channel is None:
            return False

        message = format_template(config.get("welcome_message") or "Welcome {user} to {server}!", member)
        if test:
            message = "**WELCOME PREVIEW**\n" + message
        view = WelcomeLinks(config.get("rules_url", ""), config.get("portal_url", ""))

        if config.get("image_enabled", True):
            avatar_bytes = await member.display_avatar.with_size(512).read()
            image = await asyncio.to_thread(
                render_welcome_image,
                avatar_bytes,
                member.display_name,
                member.guild.name,
                member.guild.member_count or len(member.guild.members),
            )
            filename = f"pja-welcome-{member.id}.png"
            embed = pja_embed("Welcome to Project Azure", message, BLUE)
            embed.set_image(url=f"attachment://{filename}")
            await channel.send(embed=embed, file=discord.File(image, filename=filename), view=view)
        else:
            await channel.send(embed=pja_embed("Welcome to Project Azure", message, BLUE), view=view)
        return True

    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member):
        try:
            config = await api.get_welcome_config(str(member.guild.id))
        except APIError:
            return
        if not config.get("enabled"):
            return

        role_ids = [str(role_id) for role_id in config.get("auto_role_ids", [])]
        roles = [member.guild.get_role(int(role_id)) for role_id in role_ids if role_id.isdigit()]
        roles = [role for role in roles if role and role < member.guild.me.top_role]
        if roles:
            try:
                await member.add_roles(*roles, reason="Project Azure automatic welcome roles")
            except discord.Forbidden:
                pass

        try:
            await self._send_welcome(member, config)
        except discord.HTTPException as error:
            print(f"[welcome] channel message failed: {error}")

        if config.get("dm_enabled"):
            try:
                dm_text = format_template(config.get("dm_message") or "Welcome to {server}!", member)
                await member.send(embed=pja_embed("Welcome to Project Azure", dm_text, BLUE), view=WelcomeLinks(config.get("rules_url", ""), config.get("portal_url", "")))
            except discord.HTTPException:
                pass

    @commands.Cog.listener()
    async def on_member_remove(self, member: discord.Member):
        try:
            config = await api.get_welcome_config(str(member.guild.id))
        except APIError:
            return
        if not config.get("goodbye_enabled"):
            return
        channel_id = str(config.get("goodbye_channel_id") or config.get("welcome_channel_id") or "")
        channel = member.guild.get_channel(int(channel_id)) if channel_id.isdigit() else None
        if channel:
            text = format_template(config.get("goodbye_message") or "{username} has left {server}.", member)
            try:
                await channel.send(embed=pja_embed("Member Left", text, DARK))
            except discord.HTTPException:
                pass

    @welcome.command(name="test", description="Preview the current welcome setup")
    @is_manager()
    async def test(self, interaction: discord.Interaction, member: discord.Member = None):
        target = member or interaction.user
        await interaction.response.defer(ephemeral=True)
        try:
            config = await api.get_welcome_config(str(interaction.guild.id))
            avatar_bytes = await target.display_avatar.with_size(512).read()
            image = await asyncio.to_thread(
                render_welcome_image, avatar_bytes, target.display_name, interaction.guild.name,
                interaction.guild.member_count or len(interaction.guild.members),
            )
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return
        filename = f"pja-welcome-preview-{target.id}.png"
        text = format_template(config.get("welcome_message") or "Welcome {user} to {server}!", target)
        embed = pja_embed("Welcome Preview", text, BLUE)
        embed.set_image(url=f"attachment://{filename}")
        await interaction.followup.send(embed=embed, file=discord.File(image, filename=filename), view=WelcomeLinks(config.get("rules_url", ""), config.get("portal_url", "")), ephemeral=True)

    @welcome.command(name="status", description="Show the current welcomer configuration")
    @is_manager()
    async def status(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            config = await api.get_welcome_config(str(interaction.guild.id))
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return
        embed = pja_embed("Welcomer Status", "Current settings for this server.", GREEN if config.get("enabled") else DARK)
        embed.add_field(name="Welcome", value="Enabled" if config.get("enabled") else "Disabled", inline=True)
        embed.add_field(name="Welcome Channel", value=f"<#{config['welcome_channel_id']}>" if config.get("welcome_channel_id") else "Not set", inline=True)
        embed.add_field(name="Welcome Image", value="On" if config.get("image_enabled") else "Off", inline=True)
        embed.add_field(name="Private DM", value="On" if config.get("dm_enabled") else "Off", inline=True)
        embed.add_field(name="Auto Roles", value=str(len(config.get("auto_role_ids", []))), inline=True)
        embed.add_field(name="Goodbye", value="On" if config.get("goodbye_enabled") else "Off", inline=True)
        await interaction.followup.send(embed=embed, ephemeral=True)

    async def _set_enabled(self, interaction: discord.Interaction, enabled: bool):
        await interaction.response.defer(ephemeral=True)
        try:
            config = await api.get_welcome_config(str(interaction.guild.id))
            allowed = {
                key: config.get(key) for key in (
                    "welcome_channel_id", "welcome_message", "image_enabled", "dm_enabled", "dm_message",
                    "auto_role_ids", "goodbye_enabled", "goodbye_channel_id", "goodbye_message", "rules_url", "portal_url"
                )
            }
            updated = await api.update_welcome_config(str(interaction.guild.id), enabled=enabled, **allowed)
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return
        await interaction.followup.send(
            embed=pja_embed("Welcomer Updated", f"Welcomer is now **{'enabled' if updated.get('enabled') else 'disabled'}**.", GREEN if enabled else DARK),
            ephemeral=True,
        )

    @welcome.command(name="enable", description="Enable the configured welcome system")
    @is_manager()
    async def enable(self, interaction: discord.Interaction):
        await self._set_enabled(interaction, True)

    @welcome.command(name="disable", description="Disable welcome messages without deleting settings")
    @is_manager()
    async def disable(self, interaction: discord.Interaction):
        await self._set_enabled(interaction, False)

    async def handle_remote_test(self, data: dict):
        guild = self.bot.get_guild(int(data.get("guild_id", 0)))
        member = guild.get_member(int(data.get("user_id", 0))) if guild else None
        if not guild or not member:
            return
        try:
            config = await api.get_welcome_config(str(guild.id))
            await self._send_welcome(member, config, test=True)
        except (APIError, discord.HTTPException) as error:
            print(f"[welcome] remote test failed: {error}")


async def setup(bot):
    await bot.add_cog(WelcomeCog(bot))
