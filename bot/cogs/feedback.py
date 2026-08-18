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

    @suggest_group.command(name="submit", description="Submit a suggestion privately to management")
    @app_commands.describe(category="Suggestion category", suggestion="Your idea")
    @app_commands.choices(category=SUGGESTION_CATEGORIES)
    async def suggest_submit(self, interaction: discord.Interaction, category: app_commands.Choice[str], suggestion: str):
        await interaction.response.defer(ephemeral=True)
        try:
            entry = await api.create_suggestion(str(interaction.user.id), interaction.user.display_name, category.value, suggestion)
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return
        embed = pja_embed("Suggestion Submitted", "Your idea was sent privately to the manager website.", GREEN)
        embed.add_field(name="Suggestion ID", value=f"`{entry['id']}`", inline=True)
        embed.add_field(name="Category", value=entry["category"], inline=True)
        await interaction.followup.send(embed=embed, ephemeral=True)

    @suggest_group.command(name="status", description="View your recent suggestion statuses")
    async def suggest_status(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            entries = await api.get_player_suggestions(str(interaction.user.id))
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return
        embed = pja_embed("Your Suggestions", "Recent private submissions and manager replies.", BLUE)
        if not entries:
            embed.description = "You have not submitted any suggestions."
        for entry in entries[:8]:
            status = entry.get("status", "pending")
            value = entry.get("message", "")[:250]
            if entry.get("reply"):
                value += f"\n**Manager reply:** {entry['reply'][:250]}"
            embed.add_field(name=f"{STATUS_ICONS.get(status, '•')} {entry['id']} — {status.title()}", value=value, inline=False)
        await interaction.followup.send(embed=embed, ephemeral=True)

    @complaint_group.command(name="submit", description="Submit a private complaint to management")
    @app_commands.describe(category="Complaint category", message="Explain the issue", attachment="Optional screenshot or file")
    @app_commands.choices(category=COMPLAINT_CATEGORIES)
    async def complaint_submit(self, interaction: discord.Interaction, category: app_commands.Choice[str], message: str, attachment: discord.Attachment = None):
        await interaction.response.defer(ephemeral=True)
        try:
            entry = await api.create_complaint(
                str(interaction.user.id), interaction.user.display_name, category.value, message,
                attachment.url if attachment else "",
            )
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return
        embed = pja_embed(
            "Complaint Submitted Privately",
            "Only managers signed into the manager website can review this complaint.",
            GREEN,
        )
        embed.add_field(name="Complaint ID", value=f"`{entry['id']}`", inline=True)
        embed.add_field(name="Status", value="Pending", inline=True)
        await interaction.followup.send(embed=embed, ephemeral=True)

    @complaint_group.command(name="status", description="View your recent complaint statuses")
    async def complaint_status(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            entries = await api.get_player_complaints(str(interaction.user.id))
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return
        embed = pja_embed("Your Complaints", "Private status updates and manager replies.", BLUE)
        if not entries:
            embed.description = "You have not submitted any complaints."
        for entry in entries[:8]:
            status = entry.get("status", "pending")
            value = f"Category: {entry.get('category', 'Other')}"
            if entry.get("reply"):
                value += f"\n**Manager reply:** {entry['reply'][:400]}"
            embed.add_field(name=f"{STATUS_ICONS.get(status, '•')} {entry['id']} — {status.title()}", value=value, inline=False)
        await interaction.followup.send(embed=embed, ephemeral=True)


async def setup(bot):
    await bot.add_cog(FeedbackCog(bot))
