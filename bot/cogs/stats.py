import discord
from discord.ext import commands
from discord import app_commands
import sys, os, re
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from utils.helpers import *
from datetime import datetime

class StatsModal(discord.ui.Modal, title="Submit Match Stats"):
    goals = discord.ui.TextInput(label="Goals", placeholder="0", default="0", max_length=3)
    assists = discord.ui.TextInput(label="Assists", placeholder="0", default="0", max_length=3)
    saves = discord.ui.TextInput(label="Saves (GK)", placeholder="0", default="0", max_length=3)
    shots = discord.ui.TextInput(label="Shots on Target", placeholder="0", default="0", max_length=3)
    tackles = discord.ui.TextInput(label="Tackles / Interceptions", placeholder="e.g. 3 tackles, 2 interceptions", max_length=50)

    def __init__(self, match_id: str, opponent: str, result: str):
        super().__init__()
        self.match_id = match_id
        self.opponent = opponent
        self.result = result

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)

        # Accept entries such as "3 tackles, 2 interceptions" without
        # accidentally turning the two numbers into 32. Labelled entries are
        # stored separately; plain "3, 2" still works as tackles/interceptions.
        defensive_text = (self.tackles.value or "").lower()
        tackle_match = re.search(r"(\d+)\s*(?:tackle|tackles|tkl)", defensive_text)
        interception_match = re.search(r"(\d+)\s*(?:interception|interceptions|int)", defensive_text)
        defensive_numbers = [int(value) for value in re.findall(r"\d+", defensive_text)]
        tackles_n = int(tackle_match.group(1)) if tackle_match else (defensive_numbers[0] if defensive_numbers else 0)
        interceptions_n = int(interception_match.group(1)) if interception_match else (defensive_numbers[1] if len(defensive_numbers) > 1 else 0)

        try:
            await api.submit_stats(
                discord_id=str(interaction.user.id),
                discord_tag=str(interaction.user),
                match_id=self.match_id,
                opponent=self.opponent,
                result=self.result,
                goals=int(self.goals.value or 0),
                assists=int(self.assists.value or 0),
                saves=int(self.saves.value or 0),
                shots=int(self.shots.value or 0),
                passes=0,
                tackles=tackles_n,
                interceptions=interceptions_n,
                player_username=interaction.user.display_name,
            )
        except APIError as e:
            await interaction.followup.send(embed=api_error_embed(e), ephemeral=True)
            return

        embed = pja_embed(
            f"Match Stats Submitted — vs {self.opponent}",
            f"Result: **{self.result}**\n\nYour report is **pending manager approval**. Points and public season stats are added only after approval.",
            YELLOW
        )
        embed.set_author(name=str(interaction.user), icon_url=interaction.user.display_avatar.url)
        embed.add_field(name="⚽ Goals", value=self.goals.value or "0", inline=True)
        embed.add_field(name="🅰️ Assists", value=self.assists.value or "0", inline=True)
        embed.add_field(name="🧤 Saves", value=self.saves.value or "0", inline=True)
        embed.add_field(name="🎯 Shots", value=self.shots.value or "0", inline=True)
        embed.add_field(name="🛡️ Tackles/Int", value=self.tackles.value or "0", inline=True)
        embed.add_field(name="Match ID", value=f"`{self.match_id}`", inline=True)
        await interaction.followup.send(embed=embed, ephemeral=True)

        stats_channel = discord.utils.get(interaction.guild.text_channels, name="match-stats")
        if stats_channel:
            pub_embed = pja_embed(
                f"Pending Match Report — vs {self.opponent}",
                f"{interaction.user.mention}'s report is waiting for manager approval. It will count toward points and public stats after approval.",
                YELLOW
            )
            pub_embed.set_author(name=str(interaction.user), icon_url=interaction.user.display_avatar.url)
            pub_embed.add_field(name="⚽ Goals", value=self.goals.value or "0", inline=True)
            pub_embed.add_field(name="🅰️ Assists", value=self.assists.value or "0", inline=True)
            pub_embed.add_field(name="🧤 Saves", value=self.saves.value or "0", inline=True)
            pub_embed.add_field(name="🎯 Shots on Target", value=self.shots.value or "0", inline=True)
            pub_embed.add_field(name="🛡️ Tackles/Interceptions", value=self.tackles.value or "—", inline=True)
            pub_embed.add_field(name="Result", value=self.result, inline=True)
            await stats_channel.send(embed=pub_embed)


class StatsCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    stats_group = app_commands.Group(name="stats", description="Match stats commands")

    @stats_group.command(name="submit", description="Submit your stats for a match")
    @app_commands.describe(opponent="Team you played against", result="Match result (e.g. W 3-1)", match_id="Unique match ID (e.g. M001)")
    async def submit(self, interaction: discord.Interaction, opponent: str, result: str, match_id: str):
        modal = StatsModal(match_id=match_id, opponent=opponent, result=result)
        await interaction.response.send_modal(modal)

    @stats_group.command(name="view", description="View stats for a player")
    @app_commands.describe(member="Player to view (leave blank for yourself)")
    async def view(self, interaction: discord.Interaction, member: discord.Member = None):
        target = member or interaction.user
        await interaction.response.defer()
        try:
            matches = await api.get_player_stats(str(target.id))
        except APIError as e:
            await interaction.followup.send(embed=api_error_embed(e), ephemeral=True)
            return

        if not matches:
            await interaction.followup.send(
                embed=pja_embed("No Stats", f"{target.mention} has no stats recorded.", DARK)
            )
            return

        total_goals = sum(m.get("goals", 0) for m in matches.values())
        total_assists = sum(m.get("assists", 0) for m in matches.values())
        total_saves = sum(m.get("saves", 0) for m in matches.values())
        total_shots = sum(m.get("shots", 0) for m in matches.values())
        total_matches = len(matches)

        embed = pja_embed(
            f"{target.display_name} — Season Stats",
            f"Stats across {total_matches} match(es).",
            BLUE
        )
        embed.set_thumbnail(url=target.display_avatar.url)
        embed.add_field(name="⚽ Goals", value=total_goals, inline=True)
        embed.add_field(name="🅰️ Assists", value=total_assists, inline=True)
        embed.add_field(name="🧤 Saves", value=total_saves, inline=True)
        embed.add_field(name="🎯 Shots on Target", value=total_shots, inline=True)
        embed.add_field(name="📊 Matches Played", value=total_matches, inline=True)

        recent = sorted(matches.values(), key=lambda x: x["submitted_at"], reverse=True)[:3]
        recent_text = "\n".join(
            [f"vs {m['opponent']} — {m['result']} | G:{m.get('goals',0)} A:{m.get('assists',0)}" for m in recent]
        )
        embed.add_field(name="Recent Matches", value=recent_text or "None", inline=False)

        await interaction.followup.send(embed=embed)

    @stats_group.command(name="leaderboard", description="View the team stats leaderboard")
    async def leaderboard(self, interaction: discord.Interaction):
        await interaction.response.defer()
        try:
            board = await api.get_leaderboard()
        except APIError as e:
            await interaction.followup.send(embed=api_error_embed(e), ephemeral=True)
            return

        if not board:
            await interaction.followup.send(embed=pja_embed("No Stats", "No stats recorded yet.", DARK))
            return

        embed = pja_embed("Project Azure — Stats Leaderboard", "Top performers this season.", BLUE)
        medals = ["🥇", "🥈", "🥉"]
        for i, entry in enumerate(board[:10]):
            medal = medals[i] if i < 3 else f"`{i+1}.`"
            embed.add_field(
                name=f"{medal} {entry['username']}",
                value=f"⚽ {entry['goals']} Goals | 🅰️ {entry['assists']} Assists | {entry['matches']} Matches",
                inline=False
            )

        await interaction.followup.send(embed=embed)


async def setup(bot):
    await bot.add_cog(StatsCog(bot))
