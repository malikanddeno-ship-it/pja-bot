// ============================================================
//  PROJECT AZURE (PJA) — Discord Bot  |  index.js
//  Manager Channel : 1514321227097837678
//  Admin Roles     : TEAM MANAGER | CAPTIAN | OWNER
// ============================================================

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ChannelType,
} = require("discord.js");

require("dotenv").config();

// ─── CONFIG ──────────────────────────────────────────────────
const MANAGER_CHANNEL_ID = "1514321227097837678";
const ADMIN_ROLES = ["TEAM MANAGER", "CAPTIAN", "OWNER"];
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// ─── CLIENT ──────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel],
});

const tryoutApplications = new Map();
const matchReports = new Map();
const playerStats = new Map();
const matchSchedule = [];
const roster = [];

function isAdmin(member) {
  return member.roles.cache.some((r) => ADMIN_ROLES.includes(r.name));
}
function makeId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}
function formatDate(d) {
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function statusEmoji(s) {
  return ({ pending: "⏳", accepted: "✅", denied: "❌", trialist: "🔵" }[s] || "❓");
}

const commands = [
  new SlashCommandBuilder()
    .setName("tryout").setDescription("Apply for a PJA tryout")
    .addStringOption(o => o.setName("ign").setDescription("Your in-game name").setRequired(true))
    .addStringOption(o => o.setName("position").setDescription("Your preferred position").setRequired(true)
      .addChoices(
        { name: "Goalkeeper (GK)", value: "GK" }, { name: "Defender (CB)", value: "CB" },
        { name: "Left Back (LB)", value: "LB" }, { name: "Right Back (RB)", value: "RB" },
        { name: "Defensive Mid (CDM)", value: "CDM" }, { name: "Central Mid (CM)", value: "CM" },
        { name: "Attacking Mid (CAM)", value: "CAM" }, { name: "Left Mid (LM)", value: "LM" },
        { name: "Left Wing (LW)", value: "LW" }, { name: "Right Mid (RM)", value: "RM" },
        { name: "Right Wing (RW)", value: "RW" }, { name: "Striker (ST)", value: "ST" }
      ))
    .addStringOption(o => o.setName("skill").setDescription("Your skill level").setRequired(true)
      .addChoices(
        { name: "Beginner", value: "Beginner" }, { name: "Intermediate", value: "Intermediate" },
        { name: "Advanced", value: "Advanced" }, { name: "Elite", value: "Elite" }
      ))
    .addStringOption(o => o.setName("timezone").setDescription("Your timezone (e.g. GMT, EST, PST)").setRequired(true))
    .addStringOption(o => o.setName("availability").setDescription("When are you available?").setRequired(true))
    .addStringOption(o => o.setName("experience").setDescription("Previous team experience").setRequired(false))
    .addStringOption(o => o.setName("clip").setDescription("Link to a gameplay clip (YouTube/Medal)").setRequired(false)),

  new SlashCommandBuilder().setName("checktryout").setDescription("Check your tryout application status"),
  new SlashCommandBuilder().setName("roster").setDescription("View the current PJA roster"),
  new SlashCommandBuilder().setName("stats").setDescription("View player stats")
    .addUserOption(o => o.setName("player").setDescription("Player to look up (leave empty for yourself)").setRequired(false)),
  new SlashCommandBuilder().setName("schedule").setDescription("View upcoming PJA matches"),
  new SlashCommandBuilder().setName("results").setDescription("View recent match results"),

  new SlashCommandBuilder().setName("report").setDescription("Submit a match report [Manager only]")
    .addStringOption(o => o.setName("opponent").setDescription("Opponent team name").setRequired(true))
    .addStringOption(o => o.setName("score").setDescription("Final score (e.g. 3-1)").setRequired(true))
    .addStringOption(o => o.setName("result").setDescription("Match result").setRequired(true)
      .addChoices({ name: "Win", value: "Win" }, { name: "Loss", value: "Loss" }, { name: "Draw", value: "Draw" }))
    .addStringOption(o => o.setName("scorers").setDescription("Goal scorers (comma separated)").setRequired(false))
    .addStringOption(o => o.setName("motm").setDescription("Man of the Match").setRequired(false))
    .addStringOption(o => o.setName("notes").setDescription("Extra notes").setRequired(false)),

  new SlashCommandBuilder().setName("addplayer").setDescription("Add a player to the roster [Manager only]")
    .addUserOption(o => o.setName("user").setDescription("Discord user").setRequired(true))
    .addStringOption(o => o.setName("ign").setDescription("In-game name").setRequired(true))
    .addStringOption(o => o.setName("position").setDescription("Position").setRequired(true)
      .addChoices(
        { name: "GK", value: "GK" }, { name: "CB", value: "CB" }, { name: "LB", value: "LB" },
        { name: "RB", value: "RB" }, { name: "CDM", value: "CDM" }, { name: "CM", value: "CM" },
        { name: "CAM", value: "CAM" }, { name: "LM/LW", value: "LM" }, { name: "RM/RW", value: "RM" }, { name: "ST", value: "ST" }
      ))
    .addStringOption(o => o.setName("role").setDescription("Team role").setRequired(true)
      .addChoices(
        { name: "Captain", value: "Captain" }, { name: "Co-Captain", value: "Co-Captain" },
        { name: "Starter", value: "Starter" }, { name: "Backup", value: "Backup" },
        { name: "Academy", value: "Academy" }, { name: "Trialist", value: "Trialist" }
      ))
    .addStringOption(o => o.setName("timezone").setDescription("Timezone").setRequired(false)),

  new SlashCommandBuilder().setName("removeplayer").setDescription("Remove a player from the roster [Manager only]")
    .addStringOption(o => o.setName("ign").setDescription("Player's in-game name").setRequired(true)),

  new SlashCommandBuilder().setName("accept").setDescription("Accept a tryout application [Manager only]")
    .addStringOption(o => o.setName("id").setDescription("Application ID").setRequired(true))
    .addStringOption(o => o.setName("note").setDescription("Optional note to applicant").setRequired(false)),

  new SlashCommandBuilder().setName("deny").setDescription("Deny a tryout application [Manager only]")
    .addStringOption(o => o.setName("id").setDescription("Application ID").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason for denial").setRequired(false)),

  new SlashCommandBuilder().setName("trialist").setDescription("Move applicant to Trialist [Manager only]")
    .addStringOption(o => o.setName("id").setDescription("Application ID").setRequired(true)),

  new SlashCommandBuilder().setName("applications").setDescription("List all tryout applications [Manager only]")
    .addStringOption(o => o.setName("filter").setDescription("Filter by status").setRequired(false)
      .addChoices(
        { name: "All", value: "all" }, { name: "Pending", value: "pending" },
        { name: "Accepted", value: "accepted" }, { name: "Denied", value: "denied" }, { name: "Trialist", value: "trialist" }
      )),

  new SlashCommandBuilder().setName("ping").setDescription("Check if the bot is online"),
  new SlashCommandBuilder().setName("help").setDescription("List all PJA bot commands"),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    console.log("🔄 Registering slash commands...");
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log(`✅ Slash commands registered to guild ${GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log("✅ Global slash commands registered");
    }
  } catch (err) {
    console.error("❌ Failed to register commands:", err);
  }
}

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setActivity("PJA Tryouts | /tryout", { type: 3 });
  await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, user, member } = interaction;

  if (commandName === "ping") {
    return interaction.reply({ content: `🏓 Pong! Latency: **${client.ws.ping}ms** | Bot is online ✅`, ephemeral: true });
  }

  if (commandName === "help") {
    const embed = new EmbedBuilder()
      .setTitle("🔷 Project Azure Bot — Commands").setColor(0x2563eb)
      .addFields(
        { name: "📋 Player Commands", value: ["`/tryout` — Apply for a tryout", "`/checktryout` — Check your status", "`/roster` — View the squad", "`/stats [player]` — View stats", "`/schedule` — Upcoming matches", "`/results` — Recent results"].join("\n") },
        { name: "🔐 Manager Commands", value: ["`/applications` — View applications", "`/accept <id>` — Accept applicant", "`/deny <id>` — Deny applicant", "`/trialist <id>` — Offer trialist", "`/addplayer` — Add to roster", "`/removeplayer` — Remove from roster", "`/report` — Post match report"].join("\n") }
      )
      .setFooter({ text: "Project Azure (PJA) • Competitive VRFS" }).setTimestamp();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (commandName === "tryout") {
    if (tryoutApplications.has(user.id)) {
      const existing = tryoutApplications.get(user.id);
      return interaction.reply({ content: `⚠️ You already applied!\n**Status:** ${statusEmoji(existing.status)} ${existing.status.toUpperCase()}\n**ID:** \`${existing.id}\`\n\nUse \`/checktryout\` to check your status.`, ephemeral: true });
    }
    const appId = makeId();
    const app = {
      id: appId, userId: user.id, username: user.tag,
      ign: interaction.options.getString("ign"),
      position: interaction.options.getString("position"),
      skill: interaction.options.getString("skill"),
      timezone: interaction.options.getString("timezone"),
      availability: interaction.options.getString("availability"),
      experience: interaction.options.getString("experience") || "None provided",
      clip: interaction.options.getString("clip") || "None provided",
      status: "pending", submittedAt: new Date().toISOString(), note: "",
    };
    tryoutApplications.set(user.id, app);
    try {
      await user.send({ embeds: [new EmbedBuilder().setTitle("✅ Tryout Application Received — Project Azure").setColor(0x2563eb)
        .setDescription("Your application has been submitted! Management will review it shortly.")
        .addFields(
          { name: "Application ID", value: `\`${appId}\``, inline: true }, { name: "IGN", value: app.ign, inline: true },
          { name: "Position", value: app.position, inline: true }, { name: "Skill", value: app.skill, inline: true },
          { name: "Timezone", value: app.timezone, inline: true }, { name: "Availability", value: app.availability },
          { name: "Status", value: "⏳ Pending Review" }
        ).setFooter({ text: "Project Azure (PJA) • We'll be in touch!" }).setTimestamp()] });
    } catch {}
    const managerChannel = await client.channels.fetch(MANAGER_CHANNEL_ID).catch(() => null);
    if (managerChannel) {
      const mgrEmbed = new EmbedBuilder().setTitle("📥 New Tryout Application").setColor(0xf59e0b)
        .addFields(
          { name: "Application ID", value: `\`${appId}\``, inline: true }, { name: "Discord", value: `<@${user.id}>`, inline: true },
          { name: "IGN", value: app.ign, inline: true }, { name: "Position", value: app.position, inline: true },
          { name: "Skill", value: app.skill, inline: true }, { name: "Timezone", value: app.timezone, inline: true },
          { name: "Availability", value: app.availability }, { name: "Experience", value: app.experience }, { name: "Clip", value: app.clip }
        ).setFooter({ text: `Use /accept ${appId} | /deny ${appId} | /trialist ${appId}` }).setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`accept_${appId}`).setLabel("✅ Accept").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`trialist_${appId}`).setLabel("🔵 Trialist").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`deny_${appId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
      );
      await managerChannel.send({ embeds: [mgrEmbed], components: [row] });
    }
    return interaction.reply({ content: `✅ **Application submitted!**\nYour ID: \`${appId}\` — save this!\nUse \`/checktryout\` to check status. Good luck! 🏆`, ephemeral: true });
  }

  if (commandName === "checktryout") {
    const app = tryoutApplications.get(user.id);
    if (!app) return interaction.reply({ content: "❌ No application found. Use `/tryout` to apply!", ephemeral: true });
    const colorMap = { pending: 0xf59e0b, accepted: 0x22c55e, denied: 0xef4444, trialist: 0x3b82f6 };
    const embed = new EmbedBuilder().setTitle(`${statusEmoji(app.status)} Tryout — ${app.ign}`).setColor(colorMap[app.status] || 0x6b7280)
      .addFields(
        { name: "Application ID", value: `\`${app.id}\``, inline: true }, { name: "Position", value: app.position, inline: true },
        { name: "Skill", value: app.skill, inline: true },
        { name: "Status", value: `${statusEmoji(app.status)} **${app.status.toUpperCase()}**`, inline: true },
        { name: "Submitted", value: formatDate(app.submittedAt), inline: true }
      ).setTimestamp();
    if (app.note) embed.addFields({ name: "Manager Note", value: app.note });
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (commandName === "applications") {
    if (!isAdmin(member)) return interaction.reply({ content: "❌ You need the **TEAM MANAGER**, **CAPTIAN**, or **OWNER** role.", ephemeral: true });
    const filter = interaction.options.getString("filter") || "all";
    let apps = [...tryoutApplications.values()];
    if (filter !== "all") apps = apps.filter(a => a.status === filter);
    if (apps.length === 0) return interaction.reply({ content: `📭 No ${filter === "all" ? "" : filter + " "}applications found.`, ephemeral: true });
    const embed = new EmbedBuilder().setTitle(`📋 Applications (${filter.toUpperCase()}) — ${apps.length} total`).setColor(0x2563eb)
      .setDescription(apps.slice(0, 25).map(a => `${statusEmoji(a.status)} **\`${a.id}\`** — ${a.ign} | ${a.position} | ${a.skill} | <@${a.userId}>`).join("\n"))
      .setFooter({ text: "Use /accept <id> | /deny <id> | /trialist <id>" }).setTimestamp();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (commandName === "accept") {
    if (!isAdmin(member)) return interaction.reply({ content: "❌ Manager only.", ephemeral: true });
    const id = interaction.options.getString("id").toUpperCase();
    const note = interaction.options.getString("note") || "";
    const app = [...tryoutApplications.values()].find(a => a.id === id);
    if (!app) return interaction.reply({ content: `❌ No application with ID \`${id}\` found.`, ephemeral: true });
    app.status = "accepted"; app.note = note;
    try {
      const applicant = await client.users.fetch(app.userId).catch(() => null);
      if (applicant) {
        const dm = new EmbedBuilder().setTitle("🎉 Tryout Application — ACCEPTED").setColor(0x22c55e)
          .setDescription(`Congratulations **${app.ign}**! You've been **accepted** into Project Azure! 🎉 A manager will be in touch shortly.`)
          .addFields({ name: "Position", value: app.position, inline: true }, { name: "Application ID", value: `\`${id}\``, inline: true });
        if (note) dm.addFields({ name: "Manager Note", value: note });
        dm.setFooter({ text: "Project Azure (PJA) • GG!" }).setTimestamp();
        await applicant.send({ embeds: [dm] });
      }
    } catch {}
    return interaction.reply({ content: `✅ **${app.ign}** ACCEPTED. Applicant notified.`, ephemeral: true });
  }

  if (commandName === "deny") {
    if (!isAdmin(member)) return interaction.reply({ content: "❌ Manager only.", ephemeral: true });
    const id = interaction.options.getString("id").toUpperCase();
    const reason = interaction.options.getString("reason") || "No reason provided.";
    const app = [...tryoutApplications.values()].find(a => a.id === id);
    if (!app) return interaction.reply({ content: `❌ No application with ID \`${id}\` found.`, ephemeral: true });
    app.status = "denied"; app.note = reason;
    try {
      const applicant = await client.users.fetch(app.userId).catch(() => null);
      if (applicant) await applicant.send({ embeds: [new EmbedBuilder().setTitle("❌ Tryout Application — Not Accepted").setColor(0xef4444)
        .setDescription(`Hi **${app.ign}**, thank you for applying. Unfortunately your application was not successful at this time. Keep practising and feel free to apply again!`)
        .addFields({ name: "Reason", value: reason }).setFooter({ text: "Project Azure (PJA) • Keep going!" }).setTimestamp()] });
    } catch {}
    return interaction.reply({ content: `❌ **${app.ign}** DENIED. Applicant notified.`, ephemeral: true });
  }

  if (commandName === "trialist") {
    if (!isAdmin(member)) return interaction.reply({ content: "❌ Manager only.", ephemeral: true });
    const id = interaction.options.getString("id").toUpperCase();
    const app = [...tryoutApplications.values()].find(a => a.id === id);
    if (!app) return interaction.reply({ content: `❌ No application with ID \`${id}\` found.`, ephemeral: true });
    app.status = "trialist";
    try {
      const applicant = await client.users.fetch(app.userId).catch(() => null);
      if (applicant) await applicant.send({ embeds: [new EmbedBuilder().setTitle("🔵 Tryout Application — Trialist Offer!").setColor(0x3b82f6)
        .setDescription(`Hi **${app.ign}**! You've been offered a **Trialist** spot at Project Azure! A manager will contact you with details.`)
        .setFooter({ text: "Project Azure (PJA) • Show us what you've got!" }).setTimestamp()] });
    } catch {}
    return interaction.reply({ content: `🔵 **${app.ign}** moved to TRIALIST. Applicant notified.`, ephemeral: true });
  }

  if (commandName === "roster") {
    if (roster.length === 0) return interaction.reply({ content: "📋 The roster is empty. Use `/addplayer` to add players." });
    const roleOrder = ["Captain", "Co-Captain", "Starter", "Backup", "Trialist", "Academy"];
    const sorted = [...roster].sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role));
    const embed = new EmbedBuilder().setTitle("🔷 Project Azure — Current Roster").setColor(0x2563eb)
      .setDescription(sorted.map(p => `**${p.ign}** — ${p.position} | ${p.role}${p.timezone ? ` | ${p.timezone}` : ""}`).join("\n"))
      .setFooter({ text: `${roster.length} player(s) total` }).setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === "addplayer") {
    if (!isAdmin(member)) return interaction.reply({ content: "❌ Manager only.", ephemeral: true });
    const targetUser = interaction.options.getUser("user");
    const ign = interaction.options.getString("ign");
    const position = interaction.options.getString("position");
    const role = interaction.options.getString("role");
    const timezone = interaction.options.getString("timezone") || "Unknown";
    if (roster.find(p => p.ign.toLowerCase() === ign.toLowerCase())) return interaction.reply({ 
