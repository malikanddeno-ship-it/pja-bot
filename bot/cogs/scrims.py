import discord
from discord.ext import commands
from discord import app_commands
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from utils.helpers import *


def rsvp_display_names(entries: dict) -> list[str]:
    names = []
    for value in entries.values():
        if isinstance(value, dict):
            name = value.get("username", "Player")
            note = value.get("note", "")
            names.append(f"{name} — {note}" if note else name)
        else:
            names.append(str(value))
    return names


def normalized_match_type(match_type: str) -> str | None:
    cleaned = " ".join(str(match_type or "").strip().lower().replace("_", " ").replace("-", " ").split())
    if "friendly" in cleaned:
        return "Friendly"
    if "league" in cleaned:
        return "League Match"
    return None


def is_friendly_match(match_type: str) -> bool:
    return normalized_match_type(match_type) == "Friendly"


def configured_channel_for(guild: discord.Guild, settings: dict, match_type: str):
    """Resolve only the approved friendly/league channels—never General."""
    normalized = normalized_match_type(match_type)
    if normalized is None:
        return None
    friendly = normalized == "Friendly"
    key = "friendly_channel_id" if friendly else "league_channel_id"
    name_key = "friendly_channel_name" if friendly else "league_channel_name"
    canonical_name = "friendly-ticks" if friendly else "league-ticks"

    channel_id = str(settings.get(key, "")).strip()
    if channel_id.isdigit():
        channel = guild.get_channel(int(channel_id))
        if isinstance(channel, discord.TextChannel):
            return channel

    # Exact-name recovery handles a deleted/recreated channel or stale saved ID.
    wanted_names = [str(settings.get(name_key, "")).strip(), canonical_name]
    for wanted in wanted_names:
        if not wanted:
            continue
        channel = discord.utils.find(
            lambda item: isinstance(item, discord.TextChannel) and item.name.lower() == wanted.lower(),
            guild.channels,
        )
        if channel:
            return channel
    return None


class ScrimRSVPView(discord.ui.View):
    def __init__(self, scrim_id: str):
        super().__init__(timeout=None)
        self.scrim_id = scrim_id

    @discord.ui.button(label="I'm Going", style=discord.ButtonStyle.success, emoji="✅", custom_id="scrim_going")
    async def going(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._rsvp(interaction, "going")

    @discord.ui.button(label="Maybe", style=discord.ButtonStyle.primary, emoji="🟡", custom_id="scrim_maybe")
    async def maybe(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._rsvp(interaction, "maybe")

    @discord.ui.button(label="Can't Go", style=discord.ButtonStyle.danger, emoji="❌", custom_id="scrim_cant")
    async def cant(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._rsvp(interaction, "cant")

    async def _rsvp(self, interaction: discord.Interaction, status: str):
        await interaction.response.defer(ephemeral=True)

        player_id = str(interaction.user.id)
        try:
            player = await api.get_player(player_id)
        except APIError:
            player = None
        player_name = player["username"] if player else interaction.user.display_name

        try:
            scrim = await api.rsvp_scrim(self.scrim_id, player_id, player_name, status)
        except APIError as e:
            await interaction.followup.send(embed=api_error_embed(e), ephemeral=True)
            return

        labels = {"going": "confirmed ✅", "maybe": "marked as maybe 🟡", "cant": "marked as unavailable ❌"}
        await interaction.followup.send(
            embed=pja_embed("RSVP Updated", f"You are {labels[status]} for this scrim. The website updates live too.", GREEN if status == "going" else (YELLOW if status == "maybe" else RED)),
            ephemeral=True,
        )

        going = scrim.get("going", {})
        maybe = scrim.get("maybe", {})
        cant = scrim.get("cant", {})

        updated_embed = pja_embed(
            f"⚽ {scrim['match_type']} vs {scrim['opponent']}",
            f"**{scrim['match_time']}**\n{scrim.get('notes', '')}",
            BLUE,
        )
        updated_embed.add_field(
            name=f"✅ Going ({len(going)})",
            value="\n".join(rsvp_display_names(going)) if going else "—",
            inline=True,
        )
        updated_embed.add_field(
            name=f"🟡 Maybe ({len(maybe)})",
            value="\n".join(rsvp_display_names(maybe)) if maybe else "—",
            inline=True,
        )
        updated_embed.add_field(
            name=f"❌ Can't Go ({len(cant)})",
            value="\n".join(rsvp_display_names(cant)) if cant else "—",
            inline=True,
        )
        updated_embed.set_footer(text="Project Azure • VRFS")
        updated_embed.timestamp = discord.utils.utcnow()

        try:
            await interaction.message.edit(embed=updated_embed, view=self)
        except Exception:
            pass


class ScrimCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    scrim_group = app_commands.Group(name="scrim", description="League and friendly scrim management")

    @scrim_group.command(name="setup", description="Choose the league-ticks and friendly-ticks channels")
    @is_manager()
    @app_commands.describe(
        league_channel="Channel for league scrims",
        friendly_channel="Channel for friendly scrims",
    )
    async def setup_channels(
        self,
        interaction: discord.Interaction,
        league_channel: discord.TextChannel,
        friendly_channel: discord.TextChannel,
    ):
        await interaction.response.defer(ephemeral=True)
        if interaction.guild is None:
            await interaction.followup.send(
                embed=pja_embed("Server Only", "Use this command inside the Project Azure server.", RED),
                ephemeral=True,
            )
            return
        try:
            await api.set_scrim_channels(
                guild_id=str(interaction.guild.id),
                league_channel_id=str(league_channel.id),
                friendly_channel_id=str(friendly_channel.id),
                league_channel_name=league_channel.name,
                friendly_channel_name=friendly_channel.name,
                updated_by=str(interaction.user),
            )
        except APIError as e:
            await interaction.followup.send(embed=api_error_embed(e), ephemeral=True)
            return

        embed = pja_embed(
            "Scrim Channels Saved",
            "Scrims will no longer post in General.",
            GREEN,
        )
        embed.add_field(name="League", value=league_channel.mention, inline=True)
        embed.add_field(name="Friendly", value=friendly_channel.mention, inline=True)
        await interaction.followup.send(embed=embed, ephemeral=True)

    @scrim_group.command(name="announce", description="Post a league or friendly scrim in its configured channel")
    @is_manager()
    @app_commands.describe(
        opponent="Opponent team name",
        time="Match time (e.g. Saturday 8 PM UTC)",
        match_type="League Match or Friendly",
        notes="Optional extra information",
        ping="Optional role name to ping",
    )
    @app_commands.choices(match_type=[
        app_commands.Choice(name="League Match", value="League Match"),
        app_commands.Choice(name="Friendly", value="Friendly"),
    ])
    async def announce(
        self,
        interaction: discord.Interaction,
        opponent: str,
        time: str,
        match_type: str,
        notes: str = "",
        ping: str = None,
    ):
        await interaction.response.defer(ephemeral=True)
        if interaction.guild is None:
            await interaction.followup.send(
                embed=pja_embed("Server Only", "Use this command inside the Project Azure server.", RED),
                ephemeral=True,
            )
            return

        try:
            settings = await api.get_scrim_channels(str(interaction.guild.id))
        except APIError as e:
            await interaction.followup.send(embed=api_error_embed(e), ephemeral=True)
            return

        channel = configured_channel_for(interaction.guild, settings, match_type)
        if channel is None:
            expected = "friendly-ticks" if is_friendly_match(match_type) else "league-ticks"
            await interaction.followup.send(
                embed=pja_embed(
                    "Scrim Channel Not Configured",
                    f"I will not post this in General. Run `/scrim setup` and choose the **{expected}** channel first.",
                    RED,
                ),
                ephemeral=True,
            )
            return

        try:
            scrim = await api.create_scrim(
                opponent=opponent,
                match_type=match_type,
                match_time=time,
                notes=notes,
                created_by=str(interaction.user),
            )
        except APIError as e:
            await interaction.followup.send(embed=api_error_embed(e), ephemeral=True)
            return

        scrim_id = scrim["id"]
        embed = pja_embed(
            f"⚽ {match_type} vs {opponent}",
            f"**{time}**\n{notes if notes else 'Use the buttons below to RSVP.'} RSVPs sync live with the player portal.",
            BLUE,
        )
        embed.add_field(name="✅ Going (0)", value="—", inline=True)
        embed.add_field(name="🟡 Maybe (0)", value="—", inline=True)
        embed.add_field(name="❌ Can't Go (0)", value="—", inline=True)
        embed.set_author(name=str(interaction.user), icon_url=interaction.user.display_avatar.url)

        view = ScrimRSVPView(scrim_id=scrim_id)
        content = None
        if ping:
            role = discord.utils.get(interaction.guild.roles, name=ping.replace("@", ""))
            if role:
                content = role.mention

        try:
            posted_message = await channel.send(content=content, embed=embed, view=view)
            try:
                await api.save_scrim_message(scrim_id, str(channel.id), str(posted_message.id))
            except APIError as save_error:
                print(f"Could not save scrim Discord message metadata: {save_error}")
        except discord.Forbidden:
            await interaction.followup.send(
                embed=pja_embed(
                    "Missing Channel Permission",
                    f"I cannot send messages in {channel.mention}. Give the bot **View Channel**, **Send Messages**, and **Embed Links** there.",
                    RED,
                ),
                ephemeral=True,
            )
            return

        await interaction.followup.send(
            embed=pja_embed("Scrim Posted", f"The {match_type.lower()} was posted in {channel.mention}.", GREEN),
            ephemeral=True,
        )

    @scrim_group.command(name="list", description="View upcoming scrims")
    async def list_scrims(self, interaction: discord.Interaction):
        await interaction.response.defer()
        try:
            scrims = await api.list_scrims()
        except APIError as e:
            await interaction.followup.send(embed=api_error_embed(e), ephemeral=True)
            return

        if not scrims:
            await interaction.followup.send(embed=pja_embed("No Scrims", "No scrims scheduled.", DARK))
            return

        embed = pja_embed("Upcoming Scrims", "", BLUE)
        for scrim in scrims[:5]:
            going = len(scrim.get("going", {}))
            maybe = len(scrim.get("maybe", {}))
            embed.add_field(
                name=f"{scrim['match_type']} vs {scrim['opponent']}",
                value=f"🕐 {scrim['match_time']}\n✅ {going} going · 🟡 {maybe} maybe",
                inline=False,
            )
        await interaction.followup.send(embed=embed)


async def setup(bot):
    await bot.add_cog(ScrimCog(bot))
