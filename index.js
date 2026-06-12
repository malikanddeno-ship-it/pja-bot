const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes } = require("discord.js");
require("dotenv").config();

const TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID  = process.env.GUILD_ID;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

const roster = [];
const friendlies = new Map();

const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Check if the bot is online"),
  new SlashCommandBuilder().setName("roster").setDescription("View the current PJA roster"),
  new SlashCommandBuilder().setName("friendly").setDescription("Request a friendly match")
    .addStringOption(o => o.setName("opponent").setDescription("Opponent team name").setRequired(true))
    .addStringOption(o => o.setName("date").setDescription("Date e.g. 14 Jun 2026").setRequired(true))
    .addStringOption(o => o.setName("time").setDescription("Time e.g. 7pm GMT").setRequired(true))
    .addStringOption(o => o.setName("notes").setDescription("Any extra notes").setRequired(false)),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    console.log("Registering commands...");
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    }
    console.log("Commands registered.");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
}

function buildFriendlyEmbed(data) {
  const goingList  = data.going.size  > 0 ? [...data.going].map(n  => "• " + n).join("\n") : "Nobody yet";
  const maybeList  = data.maybe.size  > 0 ? [...data.maybe].map(n  => "• " + n).join("\n") : "Nobody yet";
  const cantList   = data.cantGo.size > 0 ? [...data.cantGo].map(n => "• " + n).join("\n") : "Nobody yet";
  return new EmbedBuilder()
    .setTitle("⚽ Friendly Match Request")
    .setColor(0x2563eb)
    .addFields(
      { name: "🆚 Opponent", value: data.opponent, inline: true },
      { name: "📅 Date",     value: data.date,     inline: true },
      { name: "🕐 Time",     value: data.time,     inline: true },
      { name: "📝 Notes",    value: data.notes },
      { name: "✅ Going ("    + data.going.size  + ")", value: goingList,  inline: true },
      { name: "❓ Maybe ("    + data.maybe.size  + ")", value: maybeList,  inline: true },
      { name: "❌ Can't Go (" + data.cantGo.size + ")", value: cantList,   inline: true },
    )
    .setFooter({ text: "Click a button to respond • Click again to remove your response" })
    .setTimestamp();
}

function buildFriendlyButtons(friendlyId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("going_"  + friendlyId).setLabel("✅ I'm Going").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("maybe_"  + friendlyId).setLabel("❓ Maybe")    .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("cantgo_" + friendlyId).setLabel("❌ Can't Go") .setStyle(ButtonStyle.Danger),
  );
}

client.once("ready", async () => {
  console.log("Logged in as: " + client.user.tag);
  client.user.setActivity("/friendly | PJA Bot", { type: 3 });
  await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, user } = interaction;

  if (commandName === "ping") {
    await interaction.reply({ content: "🏓 Pong! " + client.ws.ping + "ms — Bot is online ✅", ephemeral: true });
    return;
  }

  if (commandName === "roster") {
    await interaction.deferReply();
    if (roster.length === 0) {
      await interaction.editReply("📋 The roster is currently empty.");
      return;
    }
    const roleOrder = ["Captain", "Co-Captain", "Starter", "Backup", "Trialist", "Academy"];
    const sorted = [...roster].sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role));
    const embed = new EmbedBuilder()
      .setTitle("🔷 Project Azure — Current Roster").setColor(0x2563eb)
      .setDescription(sorted.map(p => "**" + p.ign + "** — " + p.position + " | " + p.role).join("\n"))
      .setFooter({ text: roster.length + " player(s)" }).setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (commandName === "friendly") {
    await interaction.deferReply();
    const friendlyId = Date.now().toString(36).toUpperCase();
    const data = {
      opponent:  interaction.options.getString("opponent"),
      date:      interaction.options.getString("date"),
      time:      interaction.options.getString("time"),
      notes:     interaction.options.getString("notes") || "None",
      going:     new Set(),
      maybe:     new Set(),
      cantGo:    new Set(),
      responses: new Map(),
    };
    friendlies.set(friendlyId, data);
    await interaction.editReply({ embeds: [buildFriendlyEmbed(data)], components: [buildFriendlyButtons(friendlyId)] });
    return;
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  await interaction.deferUpdate();
  const parts      = interaction.customId.split("_");
  const action     = parts[0];
  const friendlyId = parts[1];
  const data = friendlies.get(friendlyId);
  if (!data) return;
  const name     = interaction.member ? interaction.member.displayName : interaction.user.username;
  const prevChoice = data.responses.get(interaction.user.id);
  if (prevChoice === "going")  data.going.delete(name);
  if (prevChoice === "maybe")  data.maybe.delete(name);
  if (prevChoice === "cantgo") data.cantGo.delete(name);
  if (prevChoice === action) {
    data.responses.delete(interaction.user.id);
  } else {
    if (action === "going")  data.going.add(name);
    if (action === "maybe")  data.maybe.add(name);
    if (action === "cantgo") data.cantGo.add(name);
    data.responses.set(interaction.user.id, action);
  }
  await interaction.editReply({ embeds: [buildFriendlyEmbed(data)], components: [buildFriendlyButtons(friendlyId)] });
});

client.login(TOKEN);

