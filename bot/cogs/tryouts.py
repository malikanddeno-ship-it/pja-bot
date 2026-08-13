import discord
from discord.ext import commands
from discord import app_commands
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from utils.helpers import *
from datetime import datetime

class TryoutModal(discord.ui.Modal, title="Project Azure — Tryout Application"):
    username = discord.ui.TextInput(label="VRFS Username", placeholder="Your in-game name", max_length=50)
    position = discord.ui.TextInput(label="Position", placeholder="e.g. Striker, Goalkeeper, Midfielder", max_length=50)
    overall = discord.ui.TextInput(label="Overall / Rating", placeholder="e.g. 87 OVR", max_length=20)
    experience = discord.ui.TextInput(label="Experience", placeholder="How long have you played VRFS? Any previous teams?", style=discord.TextStyle.paragraph, max_length=500)
    reason = discord.ui.TextInput(label="Why do you want to join PJA?", style=discord.TextStyle.paragraph, max_length=600)

    def __init__(self, availability: str):
        super().__init__()
        self.availability_value = availability

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            app = await api.create_tryout(
                discord_id=str(interaction.user.id),
                discord_tag=str(interaction.user),
                username=self.username.value,
                position=self.position.value,
                overall=self.overall.value,
                experience=self.experience.value,
                reason=self.reason.value,
                availability=self.availability_value,
            )
        except APIError as e:
            await interaction.followup.send(embed=api_error_embed(e), ephemeral=True)
            return

        app_id = app["id"]
        embed = pja_embed(
            f"Application Received — #{app_id}",
            "Your tryout application is permanently saved in the manager portal and Railway storage. You'll hear back after management reviews it.",
            GREEN
        )
        embed.add_field(name="Username", value=self.username.value, inline=True)
        embed.add_field(name="Position", value=self.position.value, inline=True)
        embed.add_field(name="Overall", value=self.overall.value, inline=True)
        embed.set_author(name=str(interaction.user), icon_url=interaction.user.display_avatar.url)
        await interaction.followup.send(embed=embed, ephemeral=True)

        guild = interaction.guild
        review_channel = discord.utils.get(guild.text_channels, name="tryout-reviews")
        if not review_channel:
            review_channel = discord.utils.get(guild.text_channels, name="manager-lounge")
        if review_channel:
            view = TryoutReviewView(app_id)
            review_embed = pja_embed(
                f"New Tryout Application — #{app_id}",
                "A new application has been submitted and is awaiting review.",
                YELLOW
            )
            review_embed.set_author(name=str(interaction.user), icon_url=interaction.user.display_avatar.url)
            review_embed.add_field(name="Username", value=self.username.value, inline=True)
            review_embed.add_field(name="Position", value=self.position.value, inline=True)
            review_embed.add_field(name="Overall", value=self.overall.value, inline=True)
            review_embed.add_field(name="Availability", value=self.availability_value, inline=True)
            review_embed.add_field(name="Experience", value=self.experience.value, inline=False)
            review_embed.add_field(name="Why PJA?", value=self.reason.value, inline=False)
            await review_channel.send(embed=review_embed, view=view)


class TryoutReviewView(discord.ui.View):
    """Persistent view (timeout=None, fixed custom_id) so buttons keep
    working across bot restarts — Discord re-attaches them to this class
    based on custom_id as long as the same app_id is embedded in it."""
    def __init__(self, app_id: str):
        super().__init__(timeout=None)
        self.app_id = app_id
        # custom_id must be unique per message and stable across restarts;
        # embedding app_id directly means re-registering on_ready isn't
        # needed for THIS bot's own buttons during its own runtime, though
        # a production deployment would also re-add persistent views with
        # known custom_ids in on_ready for true restart survival.
        for child in self.children:
            child.custom_id = f"{child.custom_id}_{app_id}"

    @discord.ui.button(label="Accept", style=discord.ButtonStyle.success, emoji="✅", custom_id="tryout_accept")
    async def accept(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._review(interaction, "accepted", GREEN, "accepted into Project Azure")

    @discord.ui.button(label="Trial", style=discord.ButtonStyle.primary, emoji="🔵", custom_id="tryout_trial")
    async def trial(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._review(interaction, "trial", BLUE, "placed on trial for Project Azure")

    @discord.ui.button(label="Deny", style=discord.ButtonStyle.danger, emoji="❌", custom_id="tryout_deny")
    async def deny(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._review(interaction, "denied", RED, "not selected at this time")

    async def _review(self, interaction: discord.Interaction, status: str, color: int, outcome_text: str):
        if not await has_manager_access(interaction):
            await interaction.response.send_message(
                "You need OWNER, CO OWNER, TEAM MANAGER, an approved portal role, or Administrator permission to review applications.",
                ephemeral=True
            )
            return

        await interaction.response.defer()
        try:
            app = await api.review_tryout(self.app_id, status, str(interaction.user))
        except APIError as e:
            await interaction.followup.send(embed=api_error_embed(e), ephemeral=True)
            return

        updated = pja_embed(
            f"Application #{self.app_id} — {status.upper()}",
            f"Reviewed by {interaction.user.mention}",
            color
        )
        updated.add_field(name="Player", value=app["username"], inline=True)
        updated.add_field(name="Position", value=app["position"], inline=True)
        updated.add_field(name="Verdict", value=status.title(), inline=True)

        for child in self.children:
            child.disabled = True
        await interaction.edit_original_response(embed=updated, view=self)

        applicant = interaction.guild.get_member(int(app["discord_id"]))
        if applicant:
            try:
                dm_embed = pja_embed(
                    "Project Azure — Application Update",
                    f"Your tryout application has been reviewed. You have been **{outcome_text}**.",
                    color
                )
                dm_embed.add_field(name="Reviewed by", value=str(interaction.user), inline=True)
                await applicant.send(embed=dm_embed)
            except discord.Forbidden:
                pass


class AvailabilityView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=120)
        self.availability = None

    @discord.ui.select(
        placeholder="Select your availability...",
        options=[
            discord.SelectOption(label="Weekdays (Mon–Fri)", value="Weekdays", emoji="📅"),
            discord.SelectOption(label="Weekends (Sat–Sun)", value="Weekends", emoji="📆"),
            discord.SelectOption(label="Both Weekdays & Weekends", value="Both", emoji="🗓️"),
            discord.SelectOption(label="Flexible / Varies", value="Flexible", emoji="🔄"),
        ]
    )
    async def select_availability(self, interaction: discord.Interaction, select: discord.ui.Select):
        self.availability = select.values[0]
        modal = TryoutModal(availability=self.availability)
        await interaction.response.send_modal(modal)
        self.stop()


class TryoutCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    tryout_group = app_commands.Group(name="tryout", description="Tryout management commands")

    @tryout_group.command(name="apply", description="Submit a tryout application for Project Azure")
    async def apply(self, interaction: discord.Interaction):
        try:
            existing = await api.get_player_tryouts(str(interaction.user.id))
        except APIError as e:
            await interaction.response.send_message(embed=api_error_embed(e), ephemeral=True)
            return

        if any(a["status"] == "pending" for a in existing):
            await interaction.response.send_message(
                embed=pja_embed("Already Applied", "You already have a pending application. Check `/tryout status` for an update.", YELLOW),
                ephemeral=True
            )
            return

        embed = pja_embed(
            "Project Azure — Tryout Application",
            "Select your availability first, then complete the application form.",
            BLUE
        )
        view = AvailabilityView()
        await interaction.response.send_message(embed=embed, view=view, ephemeral=True)

    @tryout_group.command(name="list", description="View all pending tryout applications")
    @is_manager()
    async def list_apps(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            pending = await api.list_tryouts(status="pending")
        except APIError as e:
            await interaction.followup.send(embed=api_error_embed(e), ephemeral=True)
            return

        if not pending:
            await interaction.followup.send(
                embed=pja_embed("No Pending Applications", "The tryout queue is empty.", DARK),
                ephemeral=True
            )
            return
        embed = pja_embed(f"Pending Applications ({len(pending)})", "", BLUE)
        for app in pending[:10]:
            embed.add_field(
                name=f"#{app['id']} — {app['username']}",
                value=f"Position: {app['position']} | Overall: {app['overall']}\nApplied: <t:{int(datetime.fromisoformat(app['submitted_at']).timestamp())}:R>",
                inline=False
            )
        await interaction.followup.send(embed=embed, ephemeral=True)

    @tryout_group.command(name="status", description="Check your application status")
    async def status(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            apps = await api.get_player_tryouts(str(interaction.user.id))
        except APIError as e:
            await interaction.followup.send(embed=api_error_embed(e), ephemeral=True)
            return

        if not apps:
            await interaction.followup.send(
                embed=pja_embed("No Application", "You haven't applied yet. Use `/tryout apply`.", DARK),
                ephemeral=True
            )
            return
        latest = sorted(apps, key=lambda x: x["submitted_at"])[-1]
        status_colors = {"pending": YELLOW, "accepted": GREEN, "denied": RED, "trial": BLUE}
        embed = pja_embed(
            f"Application #{latest['id']} — {latest['status'].title()}",
            "",
            status_colors.get(latest["status"], BLUE)
        )
        embed.add_field(name="Username", value=latest["username"], inline=True)
        embed.add_field(name="Position", value=latest["position"], inline=True)
        embed.add_field(name="Status", value=latest["status"].title(), inline=True)
        await interaction.followup.send(embed=embed, ephemeral=True)


async def setup(bot):
    await bot.add_cog(TryoutCog(bot))
