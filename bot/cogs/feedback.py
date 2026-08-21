import discord
from discord.ext import commands
from discord import app_commands
import os, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from utils.helpers import *

SUGGESTION_CATEGORIES = [
    app_commands.Choice(name="Bot", value="Bot"),
    app_commands.Choice(name="Website", value="Website"),
    app_commands.Choice(name="Team", value="Team"),
    app_commands.Choice(name="Events", value="Events"),
    app_commands.Choice(name="Other", value="Other"),
]

COMPLAINT_CATEGORIES = [
    app_commands.Choice(name="Player conduct", value="Player conduct"),
    app_commands.Choice(name="Manager conduct", value="Manager conduct"),
    app_commands.Choice(name="Match issue", value="Match issue"),
    app_commands.Choice(name="Bot or website", value="Bot or website"),
    app_commands.Choice(name="Other", value="Other"),
]

STATUS_ICONS = {
    "pending": "🟡",
    "planned": "🔵",
    "accepted": "🟢",
    "declined": "🔴",
    "implemented": "✅",
    "reviewing": "🔵",
    "resolved": "✅",
    "dismissed": "⚫",
}


class FeedbackCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    suggest_group = app_commands.Group(name="suggest", description="Send ideas to Project Azure management")
    complaint_group = app_commands.Group(name="complaint", description="Private complaint commands")

    @suggest_group.command(name="submit", description="Open Suggestions in the Player Portal")
    async def suggest_submit(self, interaction: discord.Interaction):
        await send_portal_redirect(
            interaction,
            "Suggestions — Player Portal",
            "Send suggestions from your private portal and keep manager replies in one place.",
            "player-feedback",
        )

    @suggest_group.command(name="status", description="Open suggestion updates in the Player Portal")
    async def suggest_status(self, interaction: discord.Interaction):
        await send_portal_redirect(
            interaction,
            "Suggestion Updates — Player Portal",
            "Your suggestion statuses and manager replies are now in the website.",
            "player-feedback",
        )

    @complaint_group.command(name="submit", description="Open private complaints in the Player Portal")
    async def complaint_submit(self, interaction: discord.Interaction):
        await send_portal_redirect(
            interaction,
            "Private Complaints — Player Portal",
            "Submit private complaints from the secure portal. You can also include an optional attachment link.",
            "player-feedback",
        )

    @complaint_group.command(name="status", description="Open complaint updates in the Player Portal")
    async def complaint_status(self, interaction: discord.Interaction):
        await send_portal_redirect(
            interaction,
            "Complaint Updates — Player Portal",
            "Private complaint statuses and manager replies are now kept in the website.",
            "player-feedback",
        )


async def setup(bot):
    await bot.add_cog(FeedbackCog(bot))
