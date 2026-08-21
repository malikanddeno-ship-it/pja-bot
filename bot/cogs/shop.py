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

    @shop_group.command(name="view", description="Open the PJA shop in the Player Portal")
    async def view(self, interaction: discord.Interaction):
        await send_portal_redirect(
            interaction,
            "PJA Shop — Player Portal",
            "Browse rewards, see your balance, and track orders from the website.",
            "player-shop",
        )

    @shop_group.command(name="buy", description="Purchase rewards in the Player Portal")
    async def buy(self, interaction: discord.Interaction):
        await send_portal_redirect(
            interaction,
            "Buy Rewards — Player Portal",
            "Purchases now happen in the secure Player Portal so your balance, orders, and inventory stay together.",
            "player-shop",
        )

    @app_commands.command(name="inventory", description="Open your inventory in the Player Portal")
    async def inventory(self, interaction: discord.Interaction):
        await send_portal_redirect(
            interaction,
            "My Inventory — Player Portal",
            "Fulfilled rewards and pending purchases are now in the website Shop tab.",
            "player-shop",
        )


async def setup(bot):
    await bot.add_cog(ShopCog(bot))
