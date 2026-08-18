import os
import sys

import discord
from discord import app_commands
from discord.ext import commands

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from utils.helpers import api, APIError, api_error_embed, is_manager, pja_embed, BLUE, DARK, GREEN, YELLOW


def record_text(record: dict) -> str:
    return (
        f"**{record.get('wins', 0)}W — {record.get('draws', 0)}D — {record.get('losses', 0)}L**\n"
        f"{record.get('matches', 0)} matches · {record.get('win_percentage', 0)}% wins\n"
        f"Goals: {record.get('goals_for', 0)} scored, {record.get('goals_against', 0)} conceded · GD {record.get('goal_difference', 0):+d}\n"
        f"Form: {' '.join(record.get('form') or []) or '—'}"
    )


class ClubCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    @app_commands.command(name="wdl", description="Show Project Azure wins, draws, losses, goals, and recent form")
    async def wdl(self, interaction: discord.Interaction):
        await interaction.response.defer()
        try:
            record = await api.get_wdl()
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True); return
        if not record.get("matches"):
            await interaction.followup.send(embed=pja_embed("Project Azure Record", "Project Azure has no completed match results yet.", DARK)); return
        await interaction.followup.send(embed=pja_embed("Project Azure — W/D/L", record_text(record), BLUE))

    @app_commands.command(name="records", description="Show Project Azure all-time club records")
    async def records(self, interaction: discord.Interaction):
        await interaction.response.defer()
        try:
            data = await api.get_dynasty()
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True); return
        records = data.get("records") or {}
        embed = pja_embed("Project Azure — Club Records", record_text(records.get("wdl") or {}), BLUE)
        for label, key in (("All-Time Top Scorer", "top_scorer"), ("All-Time Assist Leader", "top_assist"), ("Most Appearances", "most_appearances")):
            row = records.get(key)
            if row:
                value = f"{row.get('username', 'Player')} — {row.get('goals' if key=='top_scorer' else 'assists' if key=='top_assist' else 'matches', 0)}"
                embed.add_field(name=label, value=value, inline=True)
        embed.add_field(name="Longest Win Streak", value=str(records.get("longest_win_streak", 0)), inline=True)
        biggest = records.get("biggest_win")
        if biggest:
            embed.add_field(name="Biggest Win", value=f"vs {biggest.get('opponent')} — {biggest.get('result')}", inline=False)
        await interaction.followup.send(embed=embed)

    @app_commands.command(name="rivalry", description="Show the all-time record against one opponent")
    async def rivalry(self, interaction: discord.Interaction, opponent: str):
        await interaction.response.defer()
        try:
            data = await api.get_rivalry(opponent)
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True); return
        if not data.get("record", {}).get("matches"):
            await interaction.followup.send(embed=pja_embed("No Rivalry Data", f"No approved matches against **{opponent}** were found.", DARK)); return
        embed = pja_embed(f"Project Azure vs {opponent}", record_text(data["record"]), BLUE)
        for match in data.get("matches", [])[:5]:
            embed.add_field(name=f"{match.get('result', '—')} · {match.get('match_id', 'Match')}", value=f"vs {match.get('opponent', opponent)}", inline=False)
        await interaction.followup.send(embed=embed)

    @app_commands.command(name="career", description="Show a player's Project Azure career totals and awards")
    async def career(self, interaction: discord.Interaction, player: discord.Member = None):
        target = player or interaction.user
        await interaction.response.defer()
        try:
            data = await api.get_career(str(target.id))
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True); return
        profile, totals = data.get("player", {}), data.get("totals", {})
        embed = pja_embed(f"{profile.get('username', target.display_name)} — PJA Career", "All totals use approved match reports.", BLUE)
        embed.set_thumbnail(url=target.display_avatar.url)
        embed.add_field(name="Position", value=profile.get("position", "—"), inline=True)
        embed.add_field(name="Overall", value=profile.get("overall", "—"), inline=True)
        embed.add_field(name="Matches", value=totals.get("matches", 0), inline=True)
        embed.add_field(name="Goals", value=totals.get("goals", 0), inline=True)
        embed.add_field(name="Assists", value=totals.get("assists", 0), inline=True)
        embed.add_field(name="Saves", value=totals.get("saves", 0), inline=True)
        embed.add_field(name="MOTM", value=totals.get("motm", 0), inline=True)
        embed.add_field(name="Points", value=data.get("points", 0), inline=True)
        awards = data.get("awards") or []
        if awards:
            embed.add_field(name="Awards", value="\n".join(f"🏅 {a.get('title')} ({a.get('period')})" for a in awards[:8]), inline=False)
        await interaction.followup.send(embed=embed)

    @app_commands.command(name="awards", description="Show Project Azure awards")
    async def awards(self, interaction: discord.Interaction):
        await interaction.response.defer()
        try:
            data = await api.get_dynasty()
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True); return
        awards = data.get("awards") or []
        if not awards:
            await interaction.followup.send(embed=pja_embed("Awards", "No club awards have been recorded yet.", DARK)); return
        embed = pja_embed("Project Azure — Awards", "Recent player and team awards.", YELLOW)
        for award in awards[:15]:
            embed.add_field(name=f"🏅 {award.get('title')}", value=f"**{award.get('winner')}** · {award.get('period', 'Season')}\n{award.get('reason', '')}", inline=False)
        await interaction.followup.send(embed=embed)

    @app_commands.command(name="trophies", description="Show the Project Azure trophy cabinet")
    async def trophies(self, interaction: discord.Interaction):
        await interaction.response.defer()
        try:
            data = await api.get_dynasty()
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True); return
        trophies = data.get("trophies") or []
        if not trophies:
            await interaction.followup.send(embed=pja_embed("Trophy Cabinet", "The trophy cabinet is waiting for its first trophy.", DARK)); return
        embed = pja_embed("🏆 Project Azure Trophy Cabinet", "Club honors across every season.", YELLOW)
        for trophy in trophies[:15]:
            embed.add_field(name=trophy.get("name", "Trophy"), value=f"{trophy.get('season') or 'Club honor'}\n{trophy.get('description', '')}", inline=False)
        await interaction.followup.send(embed=embed)

    season_group = app_commands.Group(name="season", description="Project Azure season controls")

    @season_group.command(name="start", description="Start a new Project Azure season")
    @is_manager()
    async def season_start(self, interaction: discord.Interaction, name: str):
        await interaction.response.defer(ephemeral=True)
        try:
            season = await api.start_season(name, str(interaction.user))
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True); return
        await interaction.followup.send(embed=pja_embed("Season Started", f"**{season['name']}** is now active. Old club history remains saved.", GREEN), ephemeral=True)

    @season_group.command(name="finish", description="Finish the active Project Azure season")
    @is_manager()
    async def season_finish(self, interaction: discord.Interaction, notes: str = ""):
        await interaction.response.defer(ephemeral=True)
        try:
            data = await api.get_dynasty()
            active = data.get("active_season")
            if not active:
                await interaction.followup.send(embed=pja_embed("No Active Season", "Start a season first with `/season start`.", DARK), ephemeral=True); return
            season = await api.finish_season(active["id"], str(interaction.user), notes)
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True); return
        await interaction.followup.send(embed=pja_embed("Season Finished", f"**{season['name']}** has been archived with its final record.", GREEN), ephemeral=True)


async def setup(bot):
    await bot.add_cog(ClubCog(bot))
