import os
import sys
from datetime import datetime, timezone

import discord
from discord import app_commands
from discord.ext import commands, tasks

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from utils.helpers import *


def display_stamp(value: str) -> str:
    if not value:
        return "Not tracked yet"
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return discord.utils.format_dt(dt, "R")
    except Exception:
        return value


class ConfirmKickView(discord.ui.View):
    def __init__(self, wave: "KickWaveView", member: discord.Member):
        super().__init__(timeout=45)
        self.wave = wave
        self.member = member

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.wave.manager_id:
            await interaction.response.send_message("Only the manager who started this review can use these buttons.", ephemeral=True)
            return False
        return True

    @discord.ui.button(label="Confirm Kick", style=discord.ButtonStyle.danger, emoji="👢")
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button):
        if await member_has_manager_access(self.member):
            await interaction.response.edit_message(
                embed=pja_embed("Protected Manager", "This person now has manager access and cannot be kicked by Kick Wave.", RED),
                view=self.wave,
            )
            return
        try:
            try:
                await self.member.send(
                    "You were removed from Project Azure after a manager reviewed prolonged inactivity. "
                    "Contact management if you believe this was a mistake."
                )
            except discord.HTTPException:
                pass
            await self.member.kick(reason=f"PJA Kick Wave by {interaction.user}")
            await api.log_activity_action(
                str(interaction.guild.id), self.member, "kick", str(interaction.user),
                "Confirmed inactive-member removal",
            )
            self.wave.index += 1
            await interaction.response.edit_message(embed=self.wave.current_embed(), view=self.wave if self.wave.has_current else None)
        except discord.Forbidden:
            await interaction.response.edit_message(
                embed=pja_embed("Kick Failed", "The bot cannot kick this member. Move the bot role above their highest role and make sure it has Kick Members permission.", RED),
                view=self.wave,
            )
        except (discord.HTTPException, APIError) as error:
            await interaction.response.edit_message(embed=pja_embed("Kick Failed", str(error), RED), view=self.wave)

    @discord.ui.button(label="No, Go Back", style=discord.ButtonStyle.secondary, emoji="↩️")
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.edit_message(embed=self.wave.current_embed(), view=self.wave)


class KickWaveView(discord.ui.View):
    def __init__(self, guild: discord.Guild, manager_id: int, candidates: list[dict], inactivity_days: int):
        super().__init__(timeout=900)
        self.guild = guild
        self.manager_id = manager_id
        self.candidates = candidates
        self.inactivity_days = inactivity_days
        self.index = 0

    @property
    def has_current(self) -> bool:
        return self.index < len(self.candidates)

    @property
    def current(self) -> dict | None:
        return self.candidates[self.index] if self.has_current else None

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.manager_id:
            await interaction.response.send_message("Only the manager who started this review can use these buttons.", ephemeral=True)
            return False
        return True

    def current_embed(self) -> discord.Embed:
        if not self.has_current:
            return pja_embed(
                "Kick Wave Complete",
                f"Reviewed all {len(self.candidates)} inactive members. No one else is waiting in this wave.",
                GREEN,
            )
        item = self.current
        member = self.guild.get_member(int(item["discord_id"]))
        name = member.display_name if member else item.get("display_name") or item.get("username") or item["discord_id"]
        embed = pja_embed(
            f"Activity Review — {self.index + 1}/{len(self.candidates)}",
            f"**{name}** has no tracked activity within the last **{self.inactivity_days} days**. Review the evidence before choosing an action.",
            YELLOW,
        )
        if member:
            embed.set_thumbnail(url=member.display_avatar.url)
            roles = [role.name for role in member.roles if not role.is_default()]
        else:
            roles = item.get("role_names", [])
        inactive = item.get("inactive_days")
        embed.add_field(name="Inactive For", value=f"{inactive} days" if inactive is not None else "No activity recorded", inline=True)
        embed.add_field(name="Warnings", value=str(item.get("warning_count", 0)), inline=True)
        embed.add_field(name="Joined", value=display_stamp(item.get("joined_at", "")), inline=True)
        embed.add_field(name="Last Message", value=display_stamp(item.get("last_message_at", "")), inline=True)
        embed.add_field(name="Last Match", value=display_stamp(item.get("last_match_at", "")), inline=True)
        embed.add_field(name="Last Availability", value=display_stamp(item.get("last_availability_at", "")), inline=True)
        embed.add_field(name="Roles", value=", ".join(roles[:12]) or "No roles", inline=False)
        embed.set_footer(text="Project Azure • Message activity only exists from the date tracking was deployed")
        return embed

    def current_member(self) -> discord.Member | None:
        return self.guild.get_member(int(self.current["discord_id"])) if self.current else None

    async def advance(self, interaction: discord.Interaction):
        self.index += 1
        await interaction.response.edit_message(embed=self.current_embed(), view=self if self.has_current else None)

    @discord.ui.button(label="Warn", style=discord.ButtonStyle.primary, emoji="⚠️")
    async def warn(self, interaction: discord.Interaction, button: discord.ui.Button):
        member = self.current_member()
        if member is None:
            await self.advance(interaction)
            return
        try:
            await member.send(
                f"Project Azure activity warning: management has noticed no recent tracked participation in **{self.guild.name}**. "
                "Please talk in the server, update your match availability, or contact a manager if you are taking a break."
            )
            detail = "Warning delivered by DM"
        except discord.HTTPException:
            detail = "Warning recorded, but the member's DMs were closed"
        try:
            await api.log_activity_action(str(self.guild.id), member, "warn", str(interaction.user), detail)
        except APIError:
            pass
        await self.advance(interaction)

    @discord.ui.button(label="Kick", style=discord.ButtonStyle.danger, emoji="👢")
    async def kick(self, interaction: discord.Interaction, button: discord.ui.Button):
        member = self.current_member()
        if member is None:
            await self.advance(interaction)
            return
        embed = pja_embed(
            "Confirm Member Kick",
            f"Are you sure you want to remove **{member.display_name}**? This is the final confirmation.",
            RED,
        )
        await interaction.response.edit_message(embed=embed, view=ConfirmKickView(self, member))

    @discord.ui.button(label="Skip", style=discord.ButtonStyle.secondary, emoji="⏭️")
    async def skip(self, interaction: discord.Interaction, button: discord.ui.Button):
        member = self.current_member()
        if member:
            try:
                await api.log_activity_action(str(self.guild.id), member, "skip", str(interaction.user), "Skipped during review")
            except APIError:
                pass
        await self.advance(interaction)

    @discord.ui.button(label="Protect", style=discord.ButtonStyle.success, emoji="🛡️")
    async def protect(self, interaction: discord.Interaction, button: discord.ui.Button):
        member = self.current_member()
        if member:
            try:
                await api.protect_activity_member(str(self.guild.id), member, str(interaction.user), "Protected during Kick Wave")
                await api.log_activity_action(str(self.guild.id), member, "protect", str(interaction.user), "Protected from future inactivity reviews")
            except APIError as error:
                await interaction.response.send_message(embed=api_error_embed(error), ephemeral=True)
                return
        await self.advance(interaction)

    @discord.ui.button(label="End Wave", style=discord.ButtonStyle.secondary, emoji="🛑")
    async def end(self, interaction: discord.Interaction, button: discord.ui.Button):
        self.stop()
        await interaction.response.edit_message(
            embed=pja_embed("Kick Wave Ended", f"Stopped after reviewing {self.index} of {len(self.candidates)} members.", DARK),
            view=None,
        )


class ActivityCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._last_recorded: dict[tuple[int, int], float] = {}
        self.sync_members_loop.start()

    def cog_unload(self):
        self.sync_members_loop.cancel()

    kickwave = app_commands.Group(name="kickwave", description="Review inactive members safely")

    async def sync_guild(self, guild: discord.Guild):
        members = []
        for member in guild.members:
            members.append({
                "discord_id": str(member.id),
                "username": str(member),
                "display_name": member.display_name,
                "joined_at": member.joined_at.isoformat() if member.joined_at else "",
                "role_names": [role.name for role in member.roles if not role.is_default()],
                "role_ids": [str(role.id) for role in member.roles if not role.is_default()],
                "administrator": member.guild_permissions.administrator,
                "owner": guild.owner_id == member.id,
                "bot": member.bot,
            })
        await api.sync_activity_members(str(guild.id), guild.name, members)

    @tasks.loop(hours=1)
    async def sync_members_loop(self):
        for guild in self.bot.guilds:
            try:
                await self.sync_guild(guild)
            except APIError as error:
                print(f"[activity] member sync failed for {guild.id}: {error}")

    @sync_members_loop.before_loop
    async def before_sync(self):
        await self.bot.wait_until_ready()

    @commands.Cog.listener()
    async def on_ready(self):
        for guild in self.bot.guilds:
            try:
                await self.sync_guild(guild)
            except APIError:
                pass

    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member):
        try:
            await self.sync_guild(member.guild)
        except APIError:
            pass

    @commands.Cog.listener()
    async def on_member_remove(self, member: discord.Member):
        try:
            await self.sync_guild(member.guild)
        except APIError:
            pass

    @commands.Cog.listener()
    async def on_member_update(self, before: discord.Member, after: discord.Member):
        if before.roles != after.roles:
            try:
                await self.sync_guild(after.guild)
            except APIError:
                pass

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if not message.guild or message.author.bot:
            return
        key = (message.guild.id, message.author.id)
        now_ts = discord.utils.utcnow().timestamp()
        if now_ts - self._last_recorded.get(key, 0) < 60:
            return
        self._last_recorded[key] = now_ts
        try:
            await api.record_message_activity(
                str(message.guild.id), str(message.author.id), str(message.author), message.created_at.isoformat()
            )
        except APIError:
            pass

    @kickwave.command(name="start", description="Review inactive members one at a time")
    @is_manager()
    @app_commands.describe(inactivity_days="Days without tracked messages, matches, or availability (7-365)")
    async def start(self, interaction: discord.Interaction, inactivity_days: app_commands.Range[int, 7, 365] = 30):
        await interaction.response.defer(ephemeral=True)
        try:
            await self.sync_guild(interaction.guild)
            candidates = await api.get_activity_candidates(str(interaction.guild.id), inactivity_days)
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return
        if not candidates:
            await interaction.followup.send(
                embed=pja_embed("No Inactive Members", f"No eligible members were inactive for {inactivity_days}+ days.", GREEN),
                ephemeral=True,
            )
            return
        view = KickWaveView(interaction.guild, interaction.user.id, candidates, inactivity_days)
        await interaction.followup.send(embed=view.current_embed(), view=view, ephemeral=True)

    @kickwave.command(name="warnings", description="View recent inactivity warnings")
    @is_manager()
    async def warnings(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            actions = await api.get_activity_actions(str(interaction.guild.id), "warn")
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return
        embed = pja_embed("Kick Wave Warnings", "Recent inactivity warnings for this server.", YELLOW)
        for entry in actions[:15]:
            embed.add_field(
                name=entry.get("username", entry.get("discord_id", "Member")),
                value=f"{display_stamp(entry.get('created_at', ''))} · {entry.get('detail') or entry.get('reason') or 'Warning recorded'}",
                inline=False,
            )
        if not actions:
            embed.description = "No warnings have been recorded."
        await interaction.followup.send(embed=embed, ephemeral=True)

    @kickwave.command(name="protected", description="View members protected from inactivity reviews")
    @is_manager()
    async def protected(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            entries = await api.get_activity_protected(str(interaction.guild.id))
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return
        text = "\n".join(f"• **{entry.get('username', entry['discord_id'])}** — {entry.get('reason') or 'Protected'}" for entry in entries[:30])
        await interaction.followup.send(embed=pja_embed("Protected Members", text or "No protected members.", GREEN), ephemeral=True)

    @kickwave.command(name="unprotect", description="Allow a protected member to appear in future inactivity reviews")
    @is_manager()
    async def unprotect(self, interaction: discord.Interaction, member: discord.Member):
        await interaction.response.defer(ephemeral=True)
        try:
            await api.unprotect_activity_member(str(interaction.guild.id), str(member.id))
            await api.log_activity_action(str(interaction.guild.id), member, "unprotect", str(interaction.user), "Removed from protected list")
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return
        await interaction.followup.send(embed=pja_embed("Protection Removed", f"{member.mention} can appear in future Kick Waves.", GREEN), ephemeral=True)

    async def handle_remote_action(self, data: dict):
        action_id = data.get("id", "")
        guild = self.bot.get_guild(int(data.get("guild_id", 0)))
        member = guild.get_member(int(data.get("discord_id", 0))) if guild else None
        if not guild or not member:
            await api.complete_activity_action(action_id, "failed", "Server or member not found")
            return
        try:
            if data.get("action") == "warn":
                try:
                    await member.send(
                        f"Project Azure activity warning: management has noticed no recent tracked participation in **{guild.name}**. "
                        "Please return to the server or contact management if you are taking a break."
                    )
                    detail = "Warning delivered by DM"
                except discord.HTTPException:
                    detail = "Warning recorded, but DMs were closed"
                await api.complete_activity_action(action_id, "completed", detail)
            elif data.get("action") == "kick":
                if await member_has_manager_access(member):
                    await api.complete_activity_action(action_id, "failed", "Member has manager access")
                    return
                try:
                    await member.send("You were removed from Project Azure after a manager reviewed prolonged inactivity.")
                except discord.HTTPException:
                    pass
                await member.kick(reason=f"PJA website activity review by {data.get('manager_name', 'Manager')}")
                await api.complete_activity_action(action_id, "completed", "Member kicked")
        except discord.Forbidden:
            await api.complete_activity_action(action_id, "failed", "Bot lacks permission or role position")
        except Exception as error:
            await api.complete_activity_action(action_id, "failed", str(error)[:500])


async def setup(bot):
    await bot.add_cog(ActivityCog(bot))
