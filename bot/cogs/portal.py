import discord
from discord.ext import commands
from discord import app_commands
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from utils.helpers import (
    api, APIError, api_error_embed, pja_embed, has_manager_access,
    PUBLIC_PORTAL_URL, BLUE, GREEN, YELLOW, RED, DARK,
)


REQUEST_TYPES = [
    app_commands.Choice(name="Profile or card change", value="Profile or card change"),
    app_commands.Choice(name="Position or roster change", value="Position or roster change"),
    app_commands.Choice(name="Shop reward fulfillment", value="Shop reward fulfillment"),
    app_commands.Choice(name="Leave or absence", value="Leave or absence"),
    app_commands.Choice(name="Match-stat correction", value="Match-stat correction"),
    app_commands.Choice(name="Trial or promotion", value="Trial or promotion"),
    app_commands.Choice(name="Role request", value="Role request"),
    app_commands.Choice(name="Other", value="Other"),
]

AVAILABILITY_CHOICES = [
    app_commands.Choice(name="Available", value="going"),
    app_commands.Choice(name="Maybe", value="maybe"),
    app_commands.Choice(name="Unavailable", value="cant"),
]


def _availability_match_title(scrim: dict) -> str:
    return f"{scrim.get('match_type', 'Match')} vs {scrim.get('opponent', 'Opponent')}"


class AvailabilityMatchSelect(discord.ui.Select):
    def __init__(self, scrims: list[dict], owner_id: int, status: str, note: str):
        options = []
        for scrim in scrims[:25]:
            options.append(discord.SelectOption(
                label=_availability_match_title(scrim)[:100],
                value=str(scrim["id"]),
                description=str(scrim.get("match_time") or "Time TBD")[:100],
                emoji="📅",
            ))
        super().__init__(
            placeholder="Choose the upcoming match…",
            min_values=1,
            max_values=1,
            options=options,
        )
        self.scrims = {str(scrim["id"]): scrim for scrim in scrims}
        self.owner_id = owner_id
        self.status = status
        self.note = note

    async def callback(self, interaction: discord.Interaction):
        if interaction.user.id != self.owner_id:
            await interaction.response.send_message("Only the player who opened this menu can use it.", ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True)
        scrim_id = self.values[0]
        scrim = self.scrims[scrim_id]
        try:
            await api.rsvp_scrim(
                scrim_id,
                str(interaction.user.id),
                interaction.user.display_name,
                self.status,
                self.note,
            )
        except APIError as error:
            await interaction.edit_original_response(embed=api_error_embed(error), view=None)
            return
        labels = {"going": "Available", "maybe": "Maybe", "cant": "Unavailable"}
        description = f"You are marked **{labels[self.status]}** for **{_availability_match_title(scrim)}**."
        if self.note:
            description += f"\nNote: {self.note}"
        await interaction.edit_original_response(
            embed=pja_embed("Availability Updated", description, GREEN),
            view=None,
        )


class AvailabilityMatchView(discord.ui.View):
    def __init__(self, scrims: list[dict], owner_id: int, status: str, note: str):
        super().__init__(timeout=180)
        self.add_item(AvailabilityMatchSelect(scrims, owner_id, status, note))


def portal_view(panel: str = "") -> discord.ui.View | None:
    if not PUBLIC_PORTAL_URL:
        return None
    url = PUBLIC_PORTAL_URL
    if panel:
        url += f"?page=player&panel={panel}"
    view = discord.ui.View(timeout=600)
    view.add_item(discord.ui.Button(label="Open Player Portal", url=url, emoji="🌐"))
    return view


async def portal_only(interaction: discord.Interaction, title: str, message: str, panel: str):
    embed = pja_embed(title, message + "\n\nUse `/portal login` if you are not signed in yet.", BLUE)
    await interaction.response.send_message(embed=embed, view=portal_view(panel), ephemeral=True)


class TalkToManagerModal(discord.ui.Modal, title="Talk to Project Azure Management"):
    subject = discord.ui.TextInput(label="Subject", placeholder="What do you need help with?", max_length=120)
    category = discord.ui.TextInput(label="Category", placeholder="General, roster, match, shop...", default="General", max_length=50)
    message = discord.ui.TextInput(label="Message", style=discord.TextStyle.paragraph, placeholder="Explain what you need.", max_length=2000)

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            conversation = await api.create_conversation(
                str(interaction.user.id), interaction.user.display_name,
                str(self.subject), str(self.category), str(self.message),
            )
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return

        embed = pja_embed(
            "Private Conversation Opened",
            f"Your message was sent to management. Conversation ID: `{conversation['id']}`\n"
            "Management can reply through the website, and you will receive a Discord DM.",
            GREEN,
        )
        if PUBLIC_PORTAL_URL:
            embed.add_field(name="Continue the chat", value="Use `/portal login`, then open **Talk to Manager** in the player portal.", inline=False)
        await interaction.followup.send(embed=embed, view=portal_view(), ephemeral=True)


class PlayerPortalCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    portal_group = app_commands.Group(name="portal", description="Secure Project Azure player portal login")
    talk_group = app_commands.Group(name="talk", description="Private conversations with management")
    request_group = app_commands.Group(name="request", description="Player request center")
    availability_group = app_commands.Group(name="availability", description="Match availability commands")

    @portal_group.command(name="login", description="Create a one-use player portal login code")
    async def portal_login(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            result = await api.create_portal_code(str(interaction.user.id), interaction.user.display_name)
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return

        embed = pja_embed(
            "Player Portal Login",
            f"Your one-use code is:\n\n# `{result['code']}`\n\n"
            "It expires in **10 minutes**. Do not share it with anyone.",
            BLUE,
        )
        if PUBLIC_PORTAL_URL:
            embed.add_field(name="Next step", value="Tap **Open Player Portal**, choose **Player Login**, and enter the code.", inline=False)
        else:
            embed.add_field(name="Next step", value="Open your normal PJA website, choose **Player Login**, and enter the code.", inline=False)
        await interaction.followup.send(embed=embed, view=portal_view(), ephemeral=True)

    @talk_group.command(name="manager", description="Open your private manager conversation center")
    async def talk_manager(self, interaction: discord.Interaction):
        await portal_only(interaction, "Talk to Management — Player Portal", "Private conversations now live in your Player Portal so your full thread stays together.", "player-chat")

    @request_group.command(name="submit", description="Open the Player Portal request center")
    async def request_submit(self, interaction: discord.Interaction):
        await portal_only(interaction, "Requests — Player Portal", "Submit and track requests from the website. Manager replies and status stay in one place.", "player-requests")

    @request_group.command(name="status", description="Open your request history in the Player Portal")
    async def request_status(self, interaction: discord.Interaction):
        await portal_only(interaction, "My Requests — Player Portal", "Your request history and manager replies are now in the website.", "player-requests")

    @availability_group.command(name="set", description="Set availability in the Player Portal")
    async def availability_set(self, interaction: discord.Interaction):
        await portal_only(interaction, "Availability — Player Portal", "Choose your upcoming match and tap Available, Maybe, or Unavailable on the website. No Scrim IDs to type.", "player-availability")

    @availability_group.command(name="view", description="View availability in the Player Portal")
    async def availability_view(self, interaction: discord.Interaction):
        await portal_only(interaction, "My Availability — Player Portal", "Upcoming matches and your current responses are kept in your Player Portal.", "player-availability")

    @app_commands.command(name="history", description="Open your match history in the Player Portal")
    async def history(self, interaction: discord.Interaction):
        await portal_only(interaction, "Match History — Player Portal", "Your approved match history, card, points, and recent form are together on the website.", "player-card-history")


async def setup(bot):
    await bot.add_cog(PlayerPortalCog(bot))
