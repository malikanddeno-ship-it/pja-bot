import discord
from discord.ext import commands
from discord import app_commands
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from utils.helpers import *
from datetime import datetime

POSITIONS = ["Goalkeeper", "Defender", "Midfielder", "Striker", "Winger", "Sweeper"]
STATUSES = ["Active", "Trial", "Injured", "Inactive", "Loaned"]

class RosterCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    roster_group = app_commands.Group(name="roster", description="Roster management commands")

    @roster_group.command(name="add", description="Add a player to the roster")
    @is_manager()
    @app_commands.describe(
        member="Discord member to add",
        username="VRFS username",
        position="Player position",
        overall="Player overall rating",
        status="Player status"
    )
    @app_commands.choices(
        position=[app_commands.Choice(name=p, value=p) for p in POSITIONS],
        status=[app_commands.Choice(name=s, value=s) for s in STATUSES]
    )
    async def add(self, interaction: discord.Interaction, member: discord.Member, username: str, position: str, overall: int, status: str = "Active"):
        await interaction.response.defer()
        try:
            player = await api.add_player(
                discord_id=str(member.id),
                discord_tag=str(member),
                username=username,
                position=position,
                overall=overall,
                status=status,
                added_by=str(interaction.user),
            )
        except APIError as e:
            await interaction.followup.send(embed=api_error_embed(e), ephemeral=True)
            return

        embed = pja_embed("Player Added to Roster", f"{member.mention} has been added to the Project Azure roster.", GREEN)
        embed.add_field(name="Username", value=username, inline=True)
        embed.add_field(name="Position", value=position, inline=True)
        embed.add_field(name="Overall", value=f"{overall} OVR", inline=True)
        embed.add_field(name="Status", value=status, inline=True)
        embed.set_thumbnail(url=member.display_avatar.url)
        await interaction.followup.send(embed=embed)

    @roster_group.command(name="remove", description="Remove a player from the roster")
    @is_manager()
    @app_commands.describe(member="Discord member to remove", reason="Reason for removal")
    async def remove(self, interaction: discord.Interaction, member: discord.Member, reason: str = "No reason provided"):
        await interaction.response.defer()
        try:
            result = await api.remove_player(str(member.id))
        except APIError as e:
            await interaction.followup.send(embed=api_error_embed(e), ephemeral=True)
            return

        player = result["player"]
        embed = pja_embed("Player Removed", f"**{player['username']}** has been removed from the roster.", RED)
        embed.add_field(name="Reason", value=reason, inline=False)
        embed.add_field(name="Removed by", value=str(interaction.user), inline=True)
        await interaction.followup.send(embed=embed)

    @roster_group.command(name="update", description="Update a player's info on the roster")
    @is_manager()
    @app_commands.describe(member="Player to update", overall="New overall rating", status="New status", position="New position")
    @app_commands.choices(
        status=[app_commands.Choice(name=s, value=s) for s in STATUSES],
        position=[app_commands.Choice(name=p, value=p) for p in POSITIONS]
    )
    async def update(self, interaction: discord.Interaction, member: discord.Member, overall: int = None, status: str = None, position: str = None):
        await interaction.response.defer()
        update_fields = {}
        changes = []
        if overall is not None:
            update_fields["overall"] = overall
            changes.append(f"Overall → {overall} OVR")
        if status is not None:
            update_fields["status"] = status
            changes.append(f"Status → {status}")
        if position is not None:
            update_fields["position"] = position
            changes.append(f"Position → {position}")

        try:
            player = await api.update_player(str(member.id), **update_fields)
        except APIError as e:
            await interaction.followup.send(embed=api_error_embed(e), ephemeral=True)
            return

        embed = pja_embed("Roster Updated", f"**{player['username']}** has been updated.", CYAN)
        embed.add_field(name="Changes", value="\n".join(changes) if changes else "No changes made", inline=False)
        await interaction.followup.send(embed=embed)

    @roster_group.command(name="view", description="View the full team roster")
    async def view(self, interaction: discord.Interaction):
        await interaction.response.defer()
        try:
            players = await api.get_roster()
        except APIError as e:
            await interaction.followup.send(embed=api_error_embed(e), ephemeral=True)
            return

        if not players:
            await interaction.followup.send(
                embed=pja_embed("Roster Empty", "No players are currently on the roster.", DARK)
            )
            return

        status_colors = {"Active": "🟢", "Trial": "🔵", "Injured": "🟡", "Inactive": "⚫", "Loaned": "🟣"}
        positions_order = {"Goalkeeper": 0, "Defender": 1, "Midfielder": 2, "Winger": 3, "Striker": 4, "Sweeper": 5}
        players = sorted(players, key=lambda p: positions_order.get(p["position"], 9))

        embed = pja_embed(f"Project Azure — Team Roster ({len(players)} players)", "", BLUE)
        for player in players:
            emoji = status_colors.get(player["status"], "⚪")
            embed.add_field(
                name=f"{emoji} {player['username']} — {player['position']}",
                value=f"Overall: **{player['overall']} OVR** | Status: {player['status']}",
                inline=False
            )
        await interaction.followup.send(embed=embed)




async def setup(bot):
    await bot.add_cog(RosterCog(bot))
