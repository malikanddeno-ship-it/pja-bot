import re
import time

import discord
from discord.ext import commands

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from utils.helpers import api, APIError, member_has_manager_access

INVITE_RE = re.compile(
    r"(?i)(?:https?://)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com/invite)/[A-Za-z0-9-]+"
)


class AutoModCog(commands.Cog):
    """Small PJA-specific AutoMod. No commands: managers control it from the portal."""

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._cache: dict[int, tuple[float, dict]] = {}
        self.cache_seconds = 30

    def set_config(self, data: dict) -> None:
        try:
            guild_id = int(data.get("guild_id", 0))
        except (TypeError, ValueError):
            return
        if guild_id:
            self._cache[guild_id] = (time.monotonic(), data)

    async def config_for(self, guild_id: int) -> dict:
        cached = self._cache.get(guild_id)
        if cached and time.monotonic() - cached[0] < self.cache_seconds:
            return cached[1]
        try:
            data = await api.get_automod_settings(str(guild_id))
        except APIError:
            # Safe default: never delete messages if the backend is unavailable.
            data = {"guild_id": str(guild_id), "discord_links_enabled": True}
        self._cache[guild_id] = (time.monotonic(), data)
        return data

    @commands.Cog.listener()
    async def on_ready(self):
        for guild in self.bot.guilds:
            await self.config_for(guild.id)

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if not message.guild or message.author.bot or not message.content:
            return
        if not INVITE_RE.search(message.content):
            return

        # Staff are intentionally exempt so official invites can still be posted.
        if isinstance(message.author, discord.Member) and await member_has_manager_access(message.author):
            return

        config = await self.config_for(message.guild.id)
        if config.get("discord_links_enabled", True):
            return

        deleted = False
        try:
            await message.delete(reason="PJA AutoMod: Discord invite links are disabled")
            deleted = True
        except (discord.Forbidden, discord.HTTPException):
            pass

        warning_text = (
            f"{message.author.mention} Discord invite links are currently **disabled** in this server. "
            + ("Your invite was removed." if deleted else "I couldn't remove it because I need **Manage Messages** permission.")
        )
        try:
            warning = await message.channel.send(
                warning_text,
                allowed_mentions=discord.AllowedMentions(users=True, roles=False, everyone=False),
            )
            try:
                await warning.delete(delay=10)
            except discord.HTTPException:
                pass
        except (discord.Forbidden, discord.HTTPException):
            try:
                await message.author.send("Project Azure AutoMod: Discord invite links are currently disabled in the server.")
            except discord.HTTPException:
                pass


async def setup(bot):
    await bot.add_cog(AutoModCog(bot))
