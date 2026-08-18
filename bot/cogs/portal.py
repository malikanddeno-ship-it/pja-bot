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


def portal_view() -> discord.ui.View | None:
    if not PUBLIC_PORTAL_URL:
        return None
    view = discord.ui.View(timeout=600)
    view.add_item(discord.ui.Button(label="Open Player Portal", url=PUBLIC_PORTAL_URL, emoji="🌐"))
    return view


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

    @talk_group.command(name="manager", description="Start a private conversation with Project Azure management")
    async def talk_manager(self, interaction: discord.Interaction):
        await interaction.response.send_modal(TalkToManagerModal())

    @request_group.command(name="submit", description="Submit a request to management")
    @app_commands.describe(request_type="Type of request", details="Explain exactly what you are requesting", attachment="Optional screenshot or file")
    @app_commands.choices(request_type=REQUEST_TYPES)
    async def request_submit(
        self,
        interaction: discord.Interaction,
        request_type: app_commands.Choice[str],
        details: str,
        attachment: discord.Attachment = None,
    ):
        await interaction.response.defer(ephemeral=True)
        try:
            entry = await api.create_player_request(
                str(interaction.user.id), interaction.user.display_name,
                request_type.value, details, attachment.url if attachment else "",
            )
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return

        embed = pja_embed(
            "Request Submitted",
            f"Request `{entry['id']}` was sent privately to management.\n"
            "Use `/request status` or the player portal to follow it.",
            GREEN,
        )
        await interaction.followup.send(embed=embed, view=portal_view(), ephemeral=True)

    @request_group.command(name="status", description="View your recent requests")
    async def request_status(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            entries = await api.get_player_requests(str(interaction.user.id))
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return

        if not entries:
            await interaction.followup.send(embed=pja_embed("No Requests", "You have not submitted any requests.", DARK), ephemeral=True)
            return

        embed = pja_embed("My Requests", "Your five most recent requests.", BLUE)
        for entry in entries[:5]:
            reply = f"\n**Manager reply:** {entry.get('reply')}" if entry.get("reply") else ""
            embed.add_field(
                name=f"{entry.get('request_type', 'Request')} · {str(entry.get('status', 'pending')).replace('_', ' ').title()}",
                value=f"`{entry.get('id')}` — {entry.get('details', '')[:350]}{reply}"[:1024],
                inline=False,
            )
        await interaction.followup.send(embed=embed, view=portal_view(), ephemeral=True)

    @availability_group.command(name="set", description="Set your availability for an upcoming match")
    @app_commands.describe(status="Your availability", note="Optional note, such as available after 7 PM")
    @app_commands.choices(status=AVAILABILITY_CHOICES)
    async def availability_set(
        self,
        interaction: discord.Interaction,
        status: app_commands.Choice[str],
        note: str = "",
    ):
        await interaction.response.defer(ephemeral=True)
        try:
            scrims = await api.list_scrims()
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return
        upcoming = [
            scrim for scrim in scrims
            if str(scrim.get("status", "scheduled")).lower() not in {"finished", "cancelled"}
        ]
        upcoming.sort(key=lambda item: item.get("match_time") or item.get("created_at") or "")
        if not upcoming:
            await interaction.followup.send(
                embed=pja_embed("No Upcoming Matches", "There are no matches available to respond to.", DARK),
                ephemeral=True,
            )
            return
        await interaction.followup.send(
            embed=pja_embed("Choose a Match", f"Availability: **{status.name}**" + (f"\nNote: {note}" if note else ""), BLUE),
            view=AvailabilityMatchView(upcoming[:25], interaction.user.id, status.value, note),
            ephemeral=True,
        )

    @availability_group.command(name="view", description="View upcoming matches and your availability")
    async def availability_view(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            scrims = await api.list_scrims()
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return
        if not scrims:
            await interaction.followup.send(embed=pja_embed("No Upcoming Matches", "There are no matches to respond to.", DARK), ephemeral=True)
            return
        user_id = str(interaction.user.id)
        embed = pja_embed("My Match Availability", "Use `/availability set` to respond.", BLUE)
        labels = {"going": "✅ Available", "maybe": "🟡 Maybe", "cant": "❌ Unavailable", "missing": "⚪ No response"}
        for scrim in scrims[:8]:
            current = "missing"
            note = ""
            for key in ("going", "maybe", "cant"):
                raw = scrim.get(key, {}).get(user_id)
                if raw is not None:
                    current = key
                    if isinstance(raw, dict):
                        note = raw.get("note", "")
                    break
            embed.add_field(
                name=f"{scrim.get('match_type', 'Match')} vs {scrim.get('opponent', 'Opponent')}",
                value=f"{scrim.get('match_time', 'Time TBD')}\n{labels[current]}" + (f" — {note}" if note else ""),
                inline=False,
            )
        await interaction.followup.send(embed=embed, view=portal_view(), ephemeral=True)

    @app_commands.command(name="history", description="View approved match history")
    @app_commands.describe(player="Player to view; managers can view other players")
    async def history(self, interaction: discord.Interaction, player: discord.Member = None):
        target = player or interaction.user
        if target.id != interaction.user.id and not await has_manager_access(interaction):
            await interaction.response.send_message(
                embed=pja_embed("Private History", "Players can only view their own full match history.", RED),
                ephemeral=True,
            )
            return
        await interaction.response.defer(ephemeral=True)
        try:
            matches = await api.get_player_stats(str(target.id))
        except APIError as error:
            if error.status == 404:
                await interaction.followup.send(embed=pja_embed("No Match History", f"{target.display_name} has no approved matches yet.", DARK), ephemeral=True)
            else:
                await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return

        recent = sorted(matches.values(), key=lambda match: match.get("submitted_at", ""), reverse=True)
        embed = pja_embed(f"{target.display_name} — Match History", f"{len(recent)} approved match(es). Showing the latest five.", BLUE)
        embed.set_thumbnail(url=target.display_avatar.url)
        for match in recent[:5]:
            points = match.get("points_awarded", 0)
            rating_change = int(match.get("card_rating_change", 0) or 0)
            rating_text = f"{rating_change:+d}" if rating_change else "0"
            embed.add_field(
                name=f"vs {match.get('opponent', 'Opponent')} · {match.get('result', '—')}",
                value=(
                    f"Match `{match.get('match_id', '—')}` · G {match.get('goals',0)} · A {match.get('assists',0)} · "
                    f"Saves {match.get('saves',0)} · Tackles {match.get('tackles',0)}\n"
                    f"**+{points} points** · Card rating change: **{rating_text}**"
                ),
                inline=False,
            )
        await interaction.followup.send(embed=embed, view=portal_view(), ephemeral=True)


async def setup(bot):
    await bot.add_cog(PlayerPortalCog(bot))
