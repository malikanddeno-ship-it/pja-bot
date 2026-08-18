import discord
from discord.ext import commands
from discord import app_commands
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from utils.helpers import *

COLOR_MAP = {
    "Blue": BLUE, "Green": GREEN, "Red": RED, "Yellow": YELLOW,
    "Purple": PURPLE, "Cyan": CYAN, "Dark": DARK
}
COLOR_HEX = {
    "Blue": "#3B82F6", "Green": "#22C55E", "Red": "#EF4444", "Yellow": "#EAB308",
    "Purple": "#8B5CF6", "Cyan": "#06B6D4", "Dark": "#0F172A"
}

class AnnouncementCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    announce_group = app_commands.Group(name="announce", description="Announcement commands")

    @announce_group.command(name="send", description="Send a team announcement embed")
    @is_manager()
    @app_commands.describe(
        channel="Channel to send the announcement in",
        title="Announcement title",
        message="Announcement content",
        color="Embed color",
        ping="Role or @everyone to ping",
        image_url="Optional image URL",
        link_label="Optional link button label",
        link_url="Optional link button URL"
    )
    @app_commands.choices(color=[app_commands.Choice(name=c, value=c) for c in COLOR_MAP])
    async def send(
        self,
        interaction: discord.Interaction,
        channel: discord.TextChannel,
        title: str,
        message: str,
        color: str = "Blue",
        ping: str = None,
        image_url: str = None,
        link_label: str = None,
        link_url: str = None
    ):
        await interaction.response.defer(ephemeral=True)
        embed_color = COLOR_MAP.get(color, BLUE)
        embed = discord.Embed(title=f"📢 {title}", description=message, color=embed_color)
        embed.set_footer(text="Project Azure • VRFS", icon_url=interaction.guild.icon.url if interaction.guild.icon else None)
        embed.timestamp = discord.utils.utcnow()
        embed.set_author(name="Project Azure Announcement", icon_url=interaction.guild.icon.url if interaction.guild.icon else None)

        if image_url:
            embed.set_image(url=image_url)

        view = None
        if link_label and link_url:
            view = discord.ui.View()
            view.add_item(discord.ui.Button(label=link_label, url=link_url, style=discord.ButtonStyle.link, emoji="🔗"))

        content = None
        if ping:
            if ping == "@everyone":
                content = "@everyone"
            elif ping == "@here":
                content = "@here"
            else:
                role = discord.utils.get(interaction.guild.roles, name=ping.replace("@", ""))
                if role:
                    content = role.mention

        await channel.send(content=content, embed=embed, view=view)

        # Log it to the backend too so it shows in the website's announcement
        # history. This is a record only — the bot already sent the actual
        # Discord message above, so it self-tags as the bot to avoid the
        # WebSocket listener trying to re-post it a second time.
        try:
            await api.post_announcement_record(
                title=title,
                message=message,
                color=COLOR_HEX.get(color, "#3B82F6"),
                image_url=image_url or "",
                link_label=link_label or "",
                link_url=link_url or "",
                ping=ping or "",
                posted_by=str(interaction.user),
                channel_id=str(channel.id),
            )
        except APIError:
            pass  # Discord message already sent successfully; don't fail the command over a logging miss

        await interaction.followup.send(
            embed=pja_embed("Announcement Sent", f"Your announcement was posted in {channel.mention}.", GREEN),
            ephemeral=True
        )

    @announce_group.command(name="roster-update", description="Send a formatted roster update announcement")
    @is_manager()
    @app_commands.describe(channel="Channel to post in", content="Describe the roster changes")
    async def roster_update(self, interaction: discord.Interaction, channel: discord.TextChannel, content: str):
        await interaction.response.defer(ephemeral=True)
        embed = discord.Embed(title="🔄 Roster Update", description=content, color=CYAN)
        embed.set_footer(text="Project Azure • VRFS")
        embed.timestamp = discord.utils.utcnow()
        embed.set_author(name=str(interaction.user), icon_url=interaction.user.display_avatar.url)
        await channel.send(embed=embed)

        try:
            await api.post_announcement_record(
                title="Roster Update",
                message=content,
                color="#06B6D4",
                posted_by=str(interaction.user),
                channel_id=str(channel.id),
            )
        except APIError:
            pass

        await interaction.followup.send(embed=pja_embed("Posted", "Roster update sent.", GREEN), ephemeral=True)


async def setup(bot):
    await bot.add_cog(AnnouncementCog(bot))
