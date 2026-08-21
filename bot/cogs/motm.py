import discord
from discord.ext import commands
from discord import app_commands
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from utils.helpers import *


def _match_title(scrim: dict) -> str:
    return f"{scrim.get('match_type', 'Match')} vs {scrim.get('opponent', 'Opponent')}"


def _match_option(scrim: dict) -> discord.SelectOption:
    label = _match_title(scrim)[:100]
    details = []
    if scrim.get("match_time"):
        details.append(str(scrim["match_time"]))
    if scrim.get("final_score"):
        details.append(f"Final {scrim['final_score']}")
    description = " • ".join(details)[:100] or "Finished match"
    return discord.SelectOption(label=label, value=str(scrim["id"]), description=description, emoji="⚽")


def _poll_option(poll: dict) -> discord.SelectOption:
    label = f"vs {poll.get('opponent', 'Opponent')}"[:100]
    total = sum((poll.get("votes") or {}).values())
    description = f"{len(poll.get('nominees') or [])} players • {total} vote(s)"[:100]
    return discord.SelectOption(label=label, value=str(poll["id"]), description=description, emoji="⭐")


def build_results_embed(poll: dict) -> discord.Embed:
    votes = poll.get("votes") or {}
    total_votes = sum(votes.values())
    if not votes or total_votes == 0:
        return pja_embed("No Votes", "Nobody voted in this poll.", DARK)

    sorted_votes = sorted(votes.items(), key=lambda item: item[1], reverse=True)
    winner_name, winner_votes = sorted_votes[0]
    embed = pja_embed(
        f"⭐ MOTM Results — vs {poll.get('opponent', 'Opponent')}",
        f"**{winner_name}** wins Man of the Match with **{winner_votes}/{total_votes}** votes!",
        YELLOW,
    )
    for name, vote_count in sorted_votes:
        percent = round((vote_count / total_votes) * 100) if total_votes else 0
        bar = "█" * (percent // 10) + "░" * (10 - percent // 10)
        embed.add_field(
            name=f"{'🏆 ' if name == winner_name else ''}{name}",
            value=f"`{bar}` {vote_count} vote(s) ({percent}%)",
            inline=False,
        )
    embed.add_field(name="Total Votes", value=total_votes, inline=True)
    return embed


class MOTMVoteSelect(discord.ui.Select):
    def __init__(self, nominees: list[tuple[str, str]], poll_id: str):
        options = [
            discord.SelectOption(label=name[:100], value=name[:100], description="Vote for this player", emoji="⭐")
            for _player_id, name in nominees[:25]
        ]
        super().__init__(
            placeholder="Choose your Player of the Match…",
            min_values=1,
            max_values=1,
            options=options,
            custom_id=f"motm_vote_{poll_id}",
        )
        self.poll_id = poll_id

    async def callback(self, interaction: discord.Interaction):
        nominee = self.values[0]
        await interaction.response.defer(ephemeral=True)
        try:
            await api.vote_motm(
                poll_id=self.poll_id,
                voter_id=str(interaction.user.id),
                voter_tag=str(interaction.user),
                nominee=nominee,
            )
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return
        await interaction.followup.send(
            embed=pja_embed("Vote Recorded", f"You voted for **{nominee}** as Man of the Match.", GREEN),
            ephemeral=True,
        )


class MOTMVoteView(discord.ui.View):
    """One roster dropdown backed by the shared API; duplicate votes are blocked there."""

    def __init__(self, nominees: list[tuple[str, str]], match_id: str):
        super().__init__(timeout=None)
        self.add_item(MOTMVoteSelect(nominees, match_id))


class MOTMStartMatchSelect(discord.ui.Select):
    def __init__(self, cog: "MOTMCog", scrims: list[dict], owner_id: int):
        super().__init__(
            placeholder="Choose the finished match…",
            min_values=1,
            max_values=1,
            options=[_match_option(scrim) for scrim in scrims[:25]],
        )
        self.cog = cog
        self.owner_id = owner_id
        self.scrims = {str(scrim["id"]): scrim for scrim in scrims}

    async def callback(self, interaction: discord.Interaction):
        if interaction.user.id != self.owner_id:
            await interaction.response.send_message("Only the manager who opened this menu can use it.", ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True)
        scrim_id = self.values[0]
        scrim = self.scrims[scrim_id]
        try:
            participants = await api.get_scrim_participants(scrim_id)
            if len(participants) < 2:
                await interaction.edit_original_response(
                    embed=pja_embed(
                        "Not Enough Match Participants",
                        "This match needs at least two saved participants. Publish its lineup or approve player match reports first.",
                        RED,
                    ),
                    view=None,
                )
                return
            if len(participants) > 25:
                await interaction.edit_original_response(
                    embed=pja_embed("Too Many Participants", "Discord can show up to 25 players in one voting dropdown.", RED),
                    view=None,
                )
                return
            nominee_names = [player["username"] for player in participants]
            poll = await api.start_motm(
                match_id=scrim_id,
                opponent=scrim.get("opponent", "Opponent"),
                nominees=nominee_names,
                started_by=str(interaction.user),
            )
        except APIError as error:
            await interaction.edit_original_response(embed=api_error_embed(error), view=None)
            return

        embed = pja_embed(
            f"⭐ Man of the Match — vs {scrim.get('opponent', 'Opponent')}",
            "Choose one player from the match-participant dropdown. One vote per Discord account.",
            YELLOW,
        )
        embed.add_field(name="Match", value=_match_title(scrim), inline=False)
        embed.add_field(name="Eligible Players", value="\n".join(f"• {name}" for name in nominee_names), inline=False)
        embed.set_author(name="Project Azure", icon_url=interaction.guild.icon.url if interaction.guild and interaction.guild.icon else None)
        vote_view = None
        if PUBLIC_PORTAL_URL:
            vote_view = discord.ui.View(timeout=None)
            vote_view.add_item(discord.ui.Button(
                label="Vote in Player Portal",
                url=f"{PUBLIC_PORTAL_URL}?page=player&panel=player-motm",
                emoji="⭐",
            ))
        embed.description = "MOTM voting is Player-Portal only in V6. Log in with `/portal login`, then cast one secure vote on the website."
        if interaction.channel is None:
            await interaction.edit_original_response(embed=pja_embed("Channel Missing", "I could not post the vote in this channel.", RED), view=None)
            return
        await interaction.channel.send(embed=embed, view=vote_view)
        await interaction.edit_original_response(
            embed=pja_embed("MOTM Vote Started", f"Voting is now open for **{_match_title(scrim)}**.", GREEN),
            view=None,
        )


class MOTMStartMatchView(discord.ui.View):
    def __init__(self, cog: "MOTMCog", scrims: list[dict], owner_id: int):
        super().__init__(timeout=180)
        self.add_item(MOTMStartMatchSelect(cog, scrims, owner_id))


class MOTMResultsSelect(discord.ui.Select):
    def __init__(self, polls: list[dict], owner_id: int):
        super().__init__(
            placeholder="Choose the active MOTM vote…",
            min_values=1,
            max_values=1,
            options=[_poll_option(poll) for poll in polls[:25]],
        )
        self.owner_id = owner_id

    async def callback(self, interaction: discord.Interaction):
        if interaction.user.id != self.owner_id:
            await interaction.response.send_message("Only the manager who opened this menu can use it.", ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True)
        try:
            poll = await api.close_motm(self.values[0])
        except APIError as error:
            await interaction.edit_original_response(embed=api_error_embed(error), view=None)
            return
        await interaction.edit_original_response(
            embed=pja_embed("MOTM Voting Closed", f"The vote against **{poll.get('opponent', 'Opponent')}** is closed.", GREEN),
            view=None,
        )
        if interaction.channel is not None:
            await interaction.channel.send(embed=build_results_embed(poll))


class MOTMResultsView(discord.ui.View):
    def __init__(self, polls: list[dict], owner_id: int):
        super().__init__(timeout=180)
        self.add_item(MOTMResultsSelect(polls, owner_id))


class MOTMCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    motm_group = app_commands.Group(name="motm", description="Man of the Match voting commands")

    @motm_group.command(name="start", description="Start a MOTM vote for a finished match")
    @is_manager()
    async def start(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            scrims = await api.list_scrims()
            active_polls = await api.list_motm(active=True)
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return

        active_match_ids = {str(poll.get("match_id", "")) for poll in active_polls}
        finished = [
            scrim for scrim in scrims
            if str(scrim.get("status", "")).lower() == "finished"
            and str(scrim.get("id", "")) not in active_match_ids
        ]
        finished.sort(key=lambda item: item.get("updated_at") or item.get("created_at") or "", reverse=True)
        if not finished:
            await interaction.followup.send(
                embed=pja_embed("No Finished Matches", "Finish a scrim first, or close its existing MOTM vote.", DARK),
                ephemeral=True,
            )
            return

        await interaction.followup.send(
            embed=pja_embed("Start MOTM Voting", "Choose the finished match. Eligible players will be loaded from its saved participants.", BLUE),
            view=MOTMStartMatchView(self, finished[:25], interaction.user.id),
            ephemeral=True,
        )

    @motm_group.command(name="results", description="End an active MOTM vote and show results")
    @is_manager()
    async def results(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            polls = await api.list_motm(active=True)
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return
        if not polls:
            await interaction.followup.send(embed=pja_embed("No Active Votes", "There are no active MOTM votes.", DARK), ephemeral=True)
            return
        await interaction.followup.send(
            embed=pja_embed("Close MOTM Voting", "Choose the active match vote to close.", BLUE),
            view=MOTMResultsView(polls[:25], interaction.user.id),
            ephemeral=True,
        )


async def setup(bot):
    await bot.add_cog(MOTMCog(bot))
