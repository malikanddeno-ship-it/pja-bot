import discord
from discord.ext import commands
from discord import app_commands
import os, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from utils.helpers import *


class PointsCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    points_group = app_commands.Group(name="points", description="Project Azure points commands")

    @points_group.command(name="view", description="View your points or another player's points")
    @app_commands.describe(player="Player to view; leave blank for yourself")
    async def view(self, interaction: discord.Interaction, player: discord.Member = None):
        target = player or interaction.user
        await interaction.response.defer()
        try:
            profile = await api.get_points(str(target.id))
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return

        embed = pja_embed(
            f"{target.display_name} — PJA Points",
            f"Current balance: **{profile.get('balance', 0):,} points**",
            BLUE,
        )
        embed.set_thumbnail(url=target.display_avatar.url)
        await interaction.followup.send(embed=embed)

    @points_group.command(name="leaderboard", description="View the PJA points leaderboard")
    async def leaderboard(self, interaction: discord.Interaction):
        await interaction.response.defer()
        try:
            board = await api.get_points_leaderboard()
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return

        if not board:
            await interaction.followup.send(embed=pja_embed("Points Leaderboard", "No points have been earned yet.", DARK))
            return

        lines = []
        medals = ["🥇", "🥈", "🥉"]
        for index, entry in enumerate(board[:10]):
            prefix = medals[index] if index < 3 else f"`{index + 1}.`"
            lines.append(f"{prefix} **{entry.get('username', 'Unknown')}** — {entry.get('balance', 0):,} pts")
        await interaction.followup.send(embed=pja_embed("Project Azure — Points Leaderboard", "\n".join(lines), BLUE))

    @points_group.command(name="history", description="View recent point changes")
    @app_commands.describe(player="Player to view; leave blank for yourself")
    async def history(self, interaction: discord.Interaction, player: discord.Member = None):
        target = player or interaction.user
        await interaction.response.defer(ephemeral=True)
        try:
            history = await api.get_points_history(str(target.id))
            profile = await api.get_points(str(target.id))
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return

        embed = pja_embed(
            f"{target.display_name} — Points History",
            f"Balance: **{profile.get('balance', 0):,} points**",
            BLUE,
        )
        if not history:
            embed.add_field(name="Recent changes", value="No point changes yet.", inline=False)
        else:
            for entry in history[:10]:
                amount = int(entry.get("amount", 0))
                sign = "+" if amount >= 0 else ""
                embed.add_field(
                    name=f"{sign}{amount:,} points",
                    value=f"{entry.get('reason', 'No reason')}\nBalance after: {entry.get('balance_after', 0):,}",
                    inline=False,
                )
        await interaction.followup.send(embed=embed, ephemeral=True)

    @points_group.command(name="give", description="Give points to a player")
    @is_manager()
    @app_commands.describe(player="Player receiving points", amount="Positive number of points", reason="Why the points are being given")
    async def give(self, interaction: discord.Interaction, player: discord.Member, amount: app_commands.Range[int, 1, 100000], reason: str):
        await interaction.response.defer()
        try:
            result = await api.adjust_points(str(player.id), player.display_name, amount, reason, str(interaction.user))
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return
        balance = result["profile"]["balance"]
        embed = pja_embed("Points Added", f"Gave **{amount:,} points** to {player.mention}.", GREEN)
        embed.add_field(name="Reason", value=reason, inline=False)
        embed.add_field(name="New Balance", value=f"{balance:,} points", inline=True)
        await interaction.followup.send(embed=embed)

    @points_group.command(name="remove", description="Remove points from a player")
    @is_manager()
    @app_commands.describe(player="Player losing points", amount="Positive number of points to remove", reason="Why the points are being removed")
    async def remove(self, interaction: discord.Interaction, player: discord.Member, amount: app_commands.Range[int, 1, 100000], reason: str):
        await interaction.response.defer()
        try:
            result = await api.adjust_points(str(player.id), player.display_name, -amount, reason, str(interaction.user))
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return
        balance = result["profile"]["balance"]
        embed = pja_embed("Points Removed", f"Removed **{amount:,} points** from {player.mention}.", RED)
        embed.add_field(name="Reason", value=reason, inline=False)
        embed.add_field(name="New Balance", value=f"{balance:,} points", inline=True)
        await interaction.followup.send(embed=embed)

    @points_group.command(name="set", description="Set a player's exact points balance")
    @is_manager()
    @app_commands.describe(player="Player to update", amount="New exact balance", reason="Optional reason")
    async def set_balance(self, interaction: discord.Interaction, player: discord.Member, amount: app_commands.Range[int, 0, 1000000], reason: str = "Manager set balance"):
        await interaction.response.defer()
        try:
            result = await api.set_points(str(player.id), player.display_name, amount, reason, str(interaction.user))
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return
        embed = pja_embed("Points Balance Set", f"{player.mention} now has **{result['profile']['balance']:,} points**.", CYAN)
        embed.add_field(name="Reason", value=reason, inline=False)
        await interaction.followup.send(embed=embed)


async def setup(bot):
    await bot.add_cog(PointsCog(bot))
