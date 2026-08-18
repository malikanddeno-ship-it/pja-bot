import discord
from discord.ext import commands
from discord import app_commands
import os, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from utils.helpers import *

SHOP_CHOICES = [
    app_commands.Choice(name="Custom Player Title — 250", value="custom-player-title"),
    app_commands.Choice(name="Roster Emoji — 350", value="roster-emoji"),
    app_commands.Choice(name="Player Profile Bio — 500", value="profile-bio"),
    app_commands.Choice(name="Custom Goal Celebration — 550", value="goal-celebration"),
    app_commands.Choice(name="Pro Card Theme — 650", value="card-theme-unlock"),
    app_commands.Choice(name="Matchday Lineup Graphic — 750", value="lineup-graphic"),
    app_commands.Choice(name="Position Trial Request — 900", value="position-trial"),
    app_commands.Choice(name="Matchday Spotlight — 1,000", value="matchday-spotlight"),
    app_commands.Choice(name="Custom Color Role — 1,200", value="custom-color-role"),
    app_commands.Choice(name="Elite Card Theme — 1,500", value="elite-card-theme"),
]


class ShopCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    shop_group = app_commands.Group(name="shop", description="Spend PJA points on rewards")

    @shop_group.command(name="view", description="View available PJA shop rewards")
    async def view(self, interaction: discord.Interaction):
        await interaction.response.defer()
        try:
            items = await api.get_shop()
            profile = await api.get_points(str(interaction.user.id))
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return

        embed = pja_embed(
            "Project Azure — Points Shop",
            f"Your balance: **{profile.get('balance', 0):,} points**\nBuy with `/shop buy`. Purchases wait for manager fulfillment.",
            PURPLE,
        )
        for item in items:
            embed.add_field(
                name=f"{item['name']} — {item['price']:,} pts",
                value=item["description"],
                inline=False,
            )
        await interaction.followup.send(embed=embed)

    @shop_group.command(name="buy", description="Buy a reward with your PJA points")
    @app_commands.describe(item="Reward to purchase")
    @app_commands.choices(item=SHOP_CHOICES)
    async def buy(self, interaction: discord.Interaction, item: app_commands.Choice[str]):
        await interaction.response.defer(ephemeral=True)
        try:
            order = await api.purchase_shop_item(str(interaction.user.id), interaction.user.display_name, item.value)
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return

        embed = pja_embed(
            "Purchase Submitted",
            f"You bought **{order['item_name']}** for **{order['price']:,} points**.",
            GREEN,
        )
        embed.add_field(name="Order ID", value=f"`{order['id']}`", inline=True)
        embed.add_field(name="Status", value="Pending manager fulfillment", inline=True)
        embed.add_field(name="Remaining Balance", value=f"{order.get('balance_after', 0):,} points", inline=False)
        await interaction.followup.send(embed=embed, ephemeral=True)

    @app_commands.command(name="inventory", description="View fulfilled PJA shop rewards")
    @app_commands.describe(player="Player to view; leave blank for yourself")
    async def inventory(self, interaction: discord.Interaction, player: discord.Member = None):
        target = player or interaction.user
        await interaction.response.defer()
        try:
            items = await api.get_inventory(str(target.id))
            orders = await api.get_player_orders(str(target.id))
        except APIError as error:
            await interaction.followup.send(embed=api_error_embed(error), ephemeral=True)
            return

        embed = pja_embed(f"{target.display_name} — Inventory", "Fulfilled rewards and pending purchases.", PURPLE)
        if items:
            embed.add_field(name="Owned Rewards", value="\n".join(f"• {entry['item_name']}" for entry in items[:15]), inline=False)
        else:
            embed.add_field(name="Owned Rewards", value="No fulfilled rewards yet.", inline=False)
        pending = [order for order in orders if order.get("status") == "pending"]
        if pending:
            embed.add_field(name="Pending Orders", value="\n".join(f"• {order['item_name']} (`{order['id']}`)" for order in pending[:10]), inline=False)
        await interaction.followup.send(embed=embed)


async def setup(bot):
    await bot.add_cog(ShopCog(bot))
