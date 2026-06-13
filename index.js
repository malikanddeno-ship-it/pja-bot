const { setMatchHandler } = require("./keep-alive");
const {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  SlashCommandBuilder, REST, Routes,
} = require("discord.js");
require("dotenv").config();

// ── CONFIG ───────────────────────────────────────────────────
const TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID  = process.env.GUILD_ID;
const ADMIN_ROLES = ["Manager", "Admin", "Owner", "Coach", "TEAM MANAGER", "CAPTIAN"];

// ── CLIENT ───────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

// ── DATA STORES ──────────────────────────────────────────────
const roster         = [];
const friendlies     = new Map();
const applications   = new Map();
const matchReports   = [];
const scheduleList   = [];
const attendanceLogs = new Map();
const lineups        = new Map();
const stats          = new Map();
const weaknesses     = new Map();
const contracts      = [];
const reminders      = new Map();

// ── HELPERS ──────────────────────────────────────────────────
function isAdmin(member) {
  return member.roles.cache.some(r => ADMIN_ROLES.includes(r.name));
}
function makeId() {
  return Date.now().toString(36).toUpperCase();
}
function statFor(ign) {
  if (!stats.has(ign)) stats.set(ign, { goals: 0, assists: 0, saves: 0, motms: 0, matches: 0 });
  return stats.get(ign);
}
function pjaEmbed(title, color) {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(color || 0x2563eb)
    .setFooter({ text: "Project Azure (PJA)" })
    .setTimestamp();
}
async function safeReply(interaction, options) {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(options);
    } else {
      await interaction.reply(options);
    }
  } catch (e) {
    console.error("safeReply error:", e.message);
  }
}

// ── FRIENDLY HELPERS ─────────────────────────────────────────
function buildFriendlyEmbed(data) {
  const goingList = data.going.size  > 0 ? [...data.going].map(n  => "• " + n).join("\n") : "Nobody yet";
  const maybeList = data.maybe.size  > 0 ? [...data.maybe].map(n  => "• " + n).join("\n") : "Nobody yet";
  const cantList  = data.cantGo.size > 0 ? [...data.cantGo].map(n => "• " + n).join("\n") : "Nobody yet";
  return new EmbedBuilder()
    .setTitle("⚽ Friendly Match Request")
    .setColor(0x2563eb)
    .addFields(
      { name: "🆚 Opponent", value: data.opponent, inline: true },
      { name: "📅 Date",     value: data.date,     inline: true },
      { name: "🕐 Time",     value: data.time,     inline: true },
      { name: "📝 Notes",    value: data.notes || "None" },
      { name: "✅ Going ("    + data.going.size  + ")", value: goingList, inline: true },
      { name: "❓ Maybe ("    + data.maybe.size  + ")", value: maybeList, inline: true },
      { name: "❌ Can't Go (" + data.cantGo.size + ")", value: cantList,  inline: true },
    )
    .setFooter({ text: "Click a button to respond • Click again to remove" })
    .setTimestamp();
}
function buildFriendlyButtons(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("going_"  + id).setLabel("✅ I'm Going").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("maybe_"  + id).setLabel("❓ Maybe")    .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("cantgo_" + id).setLabel("❌ Can't Go") .setStyle(ButtonStyle.Danger),
  );
}
// ── SLASH COMMANDS ───────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Check if the bot is online"),
  new SlashCommandBuilder().setName("roster").setDescription("View the current PJA roster"),
  new SlashCommandBuilder().setName("friendly").setDescription("Request a friendly match")
    .addStringOption(o => o.setName("opponent").setDescription("Opponent team name").setRequired(true))
    .addStringOption(o => o.setName("date").setDescription("Date e.g. 14 Jun 2026").setRequired(true))
    .addStringOption(o => o.setName("time").setDescription("Time e.g. 7pm GMT").setRequired(true))
    .addStringOption(o => o.setName("notes").setDescription("Any extra notes").setRequired(false)),

  new SlashCommandBuilder().setName("tryout").setDescription("Apply for a PJA tryout")
    .addStringOption(o => o.setName("ign").setDescription("Your VRFS username").setRequired(true))
    .addStringOption(o => o.setName("position").setDescription("Main position").setRequired(true)
      .addChoices(
        { name: "GK", value: "GK" }, { name: "CB", value: "CB" }, { name: "LB", value: "LB" },
        { name: "RB", value: "RB" }, { name: "CDM", value: "CDM" }, { name: "CM", value: "CM" },
        { name: "CAM", value: "CAM" }, { name: "LW/LM", value: "LW" }, { name: "RW/RM", value: "RW" },
        { name: "ST", value: "ST" }
      ))
    .addStringOption(o => o.setName("backup").setDescription("Backup position").setRequired(true)
      .addChoices(
        { name: "GK", value: "GK" }, { name: "CB", value: "CB" }, { name: "LB", value: "LB" },
        { name: "RB", value: "RB" }, { name: "CDM", value: "CDM" }, { name: "CM", value: "CM" },
        { name: "CAM", value: "CAM" }, { name: "LW/LM", value: "LW" }, { name: "RW/RM", value: "RW" },
        { name: "ST", value: "ST" }, { name: "None", value: "None" }
      ))
    .addStringOption(o => o.setName("skill").setDescription("Skill level").setRequired(true)
      .addChoices(
        { name: "Beginner", value: "Beginner" }, { name: "Intermediate", value: "Intermediate" },
        { name: "Advanced", value: "Advanced" }, { name: "Elite", value: "Elite" }
      ))
    .addStringOption(o => o.setName("timezone").setDescription("Your timezone e.g. GMT").setRequired(true))
    .addStringOption(o => o.setName("availability").setDescription("When are you available?").setRequired(true))
    .addStringOption(o => o.setName("priority").setDescription("Team priority").setRequired(true)
      .addChoices(
        { name: "1st Main", value: "1st Main" }, { name: "2nd Main", value: "2nd Main" },
        { name: "3rd Main", value: "3rd Main" }, { name: "Other", value: "Other" }
      ))
    .addStringOption(o => o.setName("clip").setDescription("Clip/highlight link").setRequired(false))
    .addStringOption(o => o.setName("why").setDescription("Why do you want to join PJA?").setRequired(false))
    .addStringOption(o => o.setName("bring").setDescription("What can you bring to PJA?").setRequired(false)),

  new SlashCommandBuilder().setName("applications").setDescription("View pending tryout applications [Manager only]")
    .addStringOption(o => o.setName("filter").setDescription("Filter status").setRequired(false)
      .addChoices(
        { name: "All", value: "all" }, { name: "Pending", value: "pending" },
        { name: "Accepted", value: "accepted" }, { name: "Denied", value: "denied" },
        { name: "Trialist", value: "trialist" }, { name: "Needs Clips", value: "needsclips" }
      )),

  new SlashCommandBuilder().setName("match-report").setDescription("Post a match report [Manager only]")
    .addStringOption(o => o.setName("opponent").setDescription("Opponent name").setRequired(true))
    .addStringOption(o => o.setName("score").setDescription("Score e.g. 3-1").setRequired(true))
    .addStringOption(o => o.setName("result").setDescription("Result").setRequired(true)
      .addChoices({ name: "Win", value: "Win" }, { name: "Loss", value: "Loss" }, { name: "Draw", value: "Draw" }))
    .addStringOption(o => o.setName("scorers").setDescription("Goal scorers (comma separated)").setRequired(false))
    .addStringOption(o => o.setName("assists").setDescription("Assisters (comma separated)").setRequired(false))
    .addStringOption(o => o.setName("saves").setDescription("Saves (comma separated)").setRequired(false))
    .addStringOption(o => o.setName("motm").setDescription("Man of the Match").setRequired(false))
    .addStringOption(o => o.setName("notes").setDescription("Extra notes").setRequired(false)),

  new SlashCommandBuilder().setName("leaderboard").setDescription("View PJA player leaderboard")
    .addStringOption(o => o.setName("category").setDescription("Category").setRequired(false)
      .addChoices(
        { name: "Goals", value: "goals" }, { name: "Assists", value: "assists" },
        { name: "Saves", value: "saves" }, { name: "MOTMs", value: "motms" },
        { name: "Matches Played", value: "matches" }
      )),

  new SlashCommandBuilder().setName("schedule").setDescription("View upcoming matches, friendlies and scrims")
    .addStringOption(o => o.setName("type").setDescription("Filter by type").setRequired(false)
      .addChoices(
        { name: "All", value: "all" }, { name: "Match", value: "match" },
        { name: "Friendly", value: "friendly" }, { name: "Scrim", value: "scrim" },
        { name: "Practice", value: "practice" }
      )),

  new SlashCommandBuilder().setName("add-schedule").setDescription("Add an event to the schedule [Manager only]")
    .addStringOption(o => o.setName("type").setDescription("Event type").setRequired(true)
      .addChoices(
        { name: "Match", value: "match" }, { name: "Friendly", value: "friendly" },
        { name: "Scrim", value: "scrim" }, { name: "Practice", value: "practice" }
      ))
    .addStringOption(o => o.setName("opponent").setDescription("Opponent / event name").setRequired(true))
    .addStringOption(o => o.setName("date").setDescription("Date e.g. 14 Jun 2026").setRequired(true))
    .addStringOption(o => o.setName("time").setDescription("Time e.g. 7pm GMT").setRequired(true))
    .addStringOption(o => o.setName("notes").setDescription("Extra notes").setRequired(false)),

  new SlashCommandBuilder().setName("attendance").setDescription("Mark attendance for a session [Manager only]")
    .addStringOption(o => o.setName("session").setDescription("Session name or ID").setRequired(true))
    .addStringOption(o => o.setName("player").setDescription("Player IGN").setRequired(true))
    .addStringOption(o => o.setName("status").setDescription("Attendance status").setRequired(true)
      .addChoices(
        { name: "Present", value: "Present" }, { name: "Late", value: "Late" },
        { name: "Absent", value: "Absent" }, { name: "Excused", value: "Excused" }
      )),

  new SlashCommandBuilder().setName("lineup").setDescription("Show or set the team lineup [Manager only]")
    .addStringOption(o => o.setName("match").setDescription("Match name or ID").setRequired(false))
    .addStringOption(o => o.setName("formation").setDescription("Formation e.g. 4-3-3").setRequired(false))
    .addStringOption(o => o.setName("players").setDescription("Players & positions e.g. PlayerA-GK, PlayerB-CB").setRequired(false))
    .addStringOption(o => o.setName("bench").setDescription("Bench players (comma separated)").setRequired(false))
    .addStringOption(o => o.setName("notes").setDescription("Notes").setRequired(false)),

  new SlashCommandBuilder().setName("chemistry").setDescription("Check chemistry score between two players")
    .addStringOption(o => o.setName("player1").setDescription("First player IGN").setRequired(true))
    .addStringOption(o => o.setName("player2").setDescription("Second player IGN").setRequired(true)),

  new SlashCommandBuilder().setName("duo").setDescription("Find the best duo partner for a player")
    .addStringOption(o => o.setName("player").setDescription("Player IGN").setRequired(true)),

  new SlashCommandBuilder().setName("weaknesses").setDescription("Track or view team weaknesses [Manager only]")
    .addStringOption(o => o.setName("team").setDescription("Team name e.g. Opponent or PJA").setRequired(true))
    .addStringOption(o => o.setName("areas").setDescription("Weak areas (comma separated) e.g. Defending,Set Pieces").setRequired(false)),

  new SlashCommandBuilder().setName("contract").setDescription("Announce a player signing [Manager only]")
    .addStringOption(o => o.setName("player").setDescription("Player IGN").setRequired(true))
    .addStringOption(o => o.setName("role").setDescription("Role e.g. Starter, Trialist").setRequired(true))
    .addStringOption(o => o.setName("position").setDescription("Position e.g. ST, GK").setRequired(true))
    .addStringOption(o => o.setName("notes").setDescription("Extra notes").setRequired(false)),

  new SlashCommandBuilder().setName("best-lineup").setDescription("Suggest the best lineup from current roster")
    .addStringOption(o => o.setName("formation").setDescription("Formation e.g. 4-3-3").setRequired(false)),

  new SlashCommandBuilder().setName("timezone-check").setDescription("Convert a time across timezones")
    .addStringOption(o => o.setName("time").setDescription("Time e.g. 7pm").setRequired(true))
    .addStringOption(o => o.setName("from").setDescription("From timezone e.g. GMT").setRequired(true))
    .addStringOption(o => o.setName("date").setDescription("Date e.g. 14 Jun 2026").setRequired(false)),

  new SlashCommandBuilder().setName("remind-team").setDescription("Set a reminder for the team [Manager only]")
    .addStringOption(o => o.setName("message").setDescription("Reminder message").setRequired(true))
    .addStringOption(o => o.setName("in").setDescription("Time until reminder e.g. 30m, 2h, 1d").setRequired(true))
    .addStringOption(o => o.setName("repeat").setDescription("Repeat interval e.g. 1h, 1d").setRequired(false)),

].map(c => c.toJSON());

// ── REGISTER COMMANDS ─────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    console.log("Registering slash commands...");
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log("Commands registered to guild: " + GUILD_ID);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log("Global commands registered.");
    }
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
}

// ── MATCH CHANNEL ID ─────────────────────────────────────────
const MATCH_CHANNEL_ID = process.env.MATCH_CHANNEL_ID || GUILD_ID;

client.once("ready", async () => {
  console.log("Logged in as: " + client.user.tag);
  client.user.setActivity("PJA Bot | /tryout", { type: 3 });
  await registerCommands();

  setMatchHandler(async (data) => {
    try {
      const channel = await client.channels.fetch(MATCH_CHANNEL_ID).catch(() => null);
      if (!channel) {
        console.error("Could not find MATCH_CHANNEL_ID: " + MATCH_CHANNEL_ID);
        return;
      }
      const id = makeId();
      const matchData = {
        opponent:  data.opponent  || "TBD",
        date:      data.date      || "TBD",
        time:      data.time      || "TBD",
        notes:     data.notes     || "None",
        type:      data.type      || "Match",
        going:     new Set(),
        maybe:     new Set(),
        cantGo:    new Set(),
        responses: new Map(),
      };
      friendlies.set(id, matchData);

      const typeIcon = { Match: "🏆", Friendly: "⚽", Scrim: "⚔️", Practice: "🏋️" };
      const embed = new EmbedBuilder()
        .setTitle((typeIcon[matchData.type] || "📌") + " " + matchData.type + " — PJA vs " + matchData.opponent)
        .setColor(0x2563eb)
        .addFields(
          { name: "🆚 Opponent", value: matchData.opponent, inline: true },
          { name: "📅 Date",     value: matchData.date,     inline: true },
          { name: "🕐 Time",     value: matchData.time,     inline: true },
          { name: "📝 Notes",    value: matchData.notes },
          { name: "✅ Going (0)",    value: "Nobody yet", inline: true },
          { name: "❓ Maybe (0)",    value: "Nobody yet", inline: true },
          { name: "❌ Can't Go (0)", value: "Nobody yet", inline: true },
        )
        .setFooter({ text: "Click a button to respond • Click again to remove | Project Azure (PJA)" })
        .setTimestamp();

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("going_"  + id).setLabel("✅ I'm Going").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("maybe_"  + id).setLabel("❓ Maybe")    .setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("cantgo_" + id).setLabel("❌ Can't Go") .setStyle(ButtonStyle.Danger),
      );

      await channel.send({ embeds: [embed], components: [buttons] });
      console.log("Posted match RSVP embed for: " + matchData.opponent);
    } catch (err) {
      console.error("Error posting match embed:", err);
    }
  });
});
   // ── SLASH COMMAND HANDLER ─────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, user, member } = interaction;

  try {

    // ── /ping ──────────────────────────────────────────────
    if (commandName === "ping") {
      await interaction.reply({ content: "🏓 Pong! " + client.ws.ping + "ms — Bot is online ✅", ephemeral: true });
      return;
    }

    // ── /roster ────────────────────────────────────────────
    if (commandName === "roster") {
      await interaction.deferReply();
      if (roster.length === 0) {
        await interaction.editReply("📋 The roster is currently empty.");
        return;
      }
      const roleOrder = ["Captain", "Co-Captain", "Starter", "Backup", "Trialist", "Academy"];
      const sorted = [...roster].sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role));
      const embed = pjaEmbed("🔷 Project Azure — Current Roster")
        .setDescription(sorted.map(p => "**" + p.ign + "** — " + p.position + " | " + p.role + (p.timezone ? " | " + p.timezone : "")).join("\n"))
        .setFooter({ text: roster.length + " player(s) | Project Azure (PJA)" });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /friendly ──────────────────────────────────────────
    if (commandName === "friendly") {
      await interaction.deferReply();
      const id = makeId();
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
      friendlies.set(id, data);
      await interaction.editReply({ embeds: [buildFriendlyEmbed(data)], components: [buildFriendlyButtons(id)] });
      return;
    }

    // ── /tryout ────────────────────────────────────────────
    if (commandName === "tryout") {
      await interaction.deferReply({ ephemeral: true });
      if (applications.has(user.id)) {
        const ex = applications.get(user.id);
        await interaction.editReply("⚠️ You already have an application on file!\n**Status:** " + ex.status.toUpperCase() + "\n**IGN:** " + ex.ign + "\n\nContact a manager if you need to update it.");
        return;
      }
      const appId = makeId();
      const app = {
        id:           appId,
        userId:       user.id,
        username:     user.tag,
        ign:          interaction.options.getString("ign"),
        position:     interaction.options.getString("position"),
        backup:       interaction.options.getString("backup"),
        skill:        interaction.options.getString("skill"),
        timezone:     interaction.options.getString("timezone"),
        availability: interaction.options.getString("availability"),
        priority:     interaction.options.getString("priority"),
        clip:         interaction.options.getString("clip") || "Not provided",
        why:          interaction.options.getString("why") || "Not provided",
        bring:        interaction.options.getString("bring") || "Not provided",
        status:       "pending",
        submittedAt:  new Date().toISOString(),
        note:         "",
      };
      applications.set(user.id, app);
      try {
        const dmEmbed = pjaEmbed("✅ Tryout Application Received", 0x2563eb)
          .setDescription("Your application for **Project Azure** has been submitted! Management will review it shortly.")
          .addFields(
            { name: "App ID",       value: appId,          inline: true },
            { name: "IGN",          value: app.ign,         inline: true },
            { name: "Position",     value: app.position,    inline: true },
            { name: "Skill",        value: app.skill,       inline: true },
            { name: "Timezone",     value: app.timezone,    inline: true },
            { name: "Priority",     value: app.priority,    inline: true },
            { name: "Availability", value: app.availability },
            { name: "Status",       value: "⏳ Pending Review" }
          );
        await user.send({ embeds: [dmEmbed] });
      } catch (e) { console.log("Could not DM applicant"); }
      await interaction.editReply("✅ Application submitted! **App ID: " + appId + "** — save this!\nWe'll DM you with a decision. Good luck! 🏆");
      return;
    }

    // ── /applications ──────────────────────────────────────
    if (commandName === "applications") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) {
        await interaction.editReply("❌ This command is for Managers only.");
        return;
      }
      const filter = interaction.options.getString("filter") || "all";
      let apps = [...applications.values()];
      if (filter !== "all") apps = apps.filter(a => a.status === filter);
      if (apps.length === 0) {
        await interaction.editReply("📭 No applications found" + (filter !== "all" ? " with status: " + filter : "") + ".");
        return;
      }
      const statusEmoji = { pending: "⏳", accepted: "✅", denied: "❌", trialist: "🔵", needsclips: "🎬" };
      const embed = pjaEmbed("📋 Tryout Applications — " + filter.toUpperCase() + " (" + apps.length + ")", 0xf59e0b)
        .setDescription(apps.slice(0, 20).map(a =>
          (statusEmoji[a.status] || "❓") + " **" + a.id + "** — " + a.ign + " | " + a.position + " | " + a.skill + " | <@" + a.userId + ">"
        ).join("\n"))
        .setFooter({ text: "Use the buttons on each application to respond | Project Azure (PJA)" });
      const firstPending = apps.find(a => a.status === "pending");
      if (firstPending) {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("app_accept_"     + firstPending.id).setLabel("✅ Accept")      .setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("app_trialist_"   + firstPending.id).setLabel("🔵 Trialist")    .setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("app_needsclips_" + firstPending.id).setLabel("🎬 Needs Clips") .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("app_deny_"       + firstPending.id).setLabel("❌ Deny")        .setStyle(ButtonStyle.Danger),
        );
        await interaction.editReply({ embeds: [embed], components: [row] });
      } else {
        await interaction.editReply({ embeds: [embed] });
      }
      return;
    }

    // ── /match-report ──────────────────────────────────────
    if (commandName === "match-report") {
      await interaction.deferReply();
      if (!isAdmin(member)) {
        await interaction.editReply("❌ This command is for Managers only.");
        return;
      }
      const opponent = interaction.options.getString("opponent");
      const score    = interaction.options.getString("score");
      const result   = interaction.options.getString("result");
      const scorers  = interaction.options.getString("scorers") || "None";
      const assists  = interaction.options.getString("assists") || "None";
      const saves    = interaction.options.getString("saves")   || "None";
      const motm     = interaction.options.getString("motm")    || "TBD";
      const notes    = interaction.options.getString("notes")   || "None";
      const reportId = makeId();
      matchReports.push({ id: reportId, opponent, score, result, scorers, assists, saves, motm, notes, date: new Date().toISOString() });
      if (scorers !== "None") scorers.split(",").map(s => s.trim()).forEach(p => { if (p) { const s = statFor(p); s.goals++; s.matches++; } });
      if (assists !== "None") assists.split(",").map(s => s.trim()).forEach(p => { if (p) { statFor(p).assists++; } });
      if (saves   !== "None") saves.split(",").map(s => s.trim()).forEach(p => { if (p) { statFor(p).saves++; } });
      if (motm !== "TBD" && motm !== "None") statFor(motm).motms++;
      const resultColor = result === "Win" ? 0x22c55e : result === "Loss" ? 0xef4444 : 0xf59e0b;
      const resultIcon  = result === "Win" ? "✅" : result === "Loss" ? "❌" : "🟡";
      const embed = pjaEmbed(resultIcon + " Match Report — PJA vs " + opponent, resultColor)
        .addFields(
          { name: "Result",     value: result,   inline: true },
          { name: "Score",      value: score,    inline: true },
          { name: "Report ID",  value: reportId, inline: true },
          { name: "⚽ Scorers", value: scorers },
          { name: "🎯 Assists", value: assists,  inline: true },
          { name: "🧤 Saves",   value: saves,    inline: true },
          { name: "🏆 MOTM",    value: motm,     inline: true },
          { name: "📝 Notes",   value: notes },
        )
        .setFooter({ text: "Reported by " + user.tag + " | Project Azure (PJA)" });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /leaderboard ───────────────────────────────────────
    if (commandName === "leaderboard") {
      await interaction.deferReply();
      const category = interaction.options.getString("category") || "goals";
      if (stats.size === 0) {
        await interaction.editReply("📊 No stats recorded yet. Stats are updated after match reports.");
        return;
      }
      const entries = [...stats.entries()].sort((a, b) => b[1][category] - a[1][category]).slice(0, 10);
      const categoryLabel = { goals: "⚽ Goals", assists: "🎯 Assists", saves: "🧤 Saves", motms: "🏆 MOTMs", matches: "🎮 Matches Played" };
      const embed = pjaEmbed("🏅 Leaderboard — " + (categoryLabel[category] || category))
        .setDescription(entries.map((e, i) => {
          const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : (i + 1) + ".";
          return medal + " **" + e[0] + "** — " + e[1][category];
        }).join("\n"));
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /schedule ──────────────────────────────────────────
    if (commandName === "schedule") {
      await interaction.deferReply();
      const typeFilter = interaction.options.getString("type") || "all";
      let events = [...scheduleList];
      if (typeFilter !== "all") events = events.filter(e => e.type === typeFilter);
      if (events.length === 0) {
        await interaction.editReply("📅 No upcoming events scheduled" + (typeFilter !== "all" ? " of type: " + typeFilter : "") + ".\nManagers can add events with `/add-schedule`.");
        return;
      }
      const typeIcon = { match: "🏆", friendly: "⚽", scrim: "⚔️", practice: "🏋️" };
      const embed = pjaEmbed("📅 PJA Schedule" + (typeFilter !== "all" ? " — " + typeFilter.toUpperCase() : ""))
        .setDescription(events.slice(0, 15).map(e =>
          (typeIcon[e.type] || "📌") + " **" + e.opponent + "** | " + e.date + " @ " + e.time + (e.notes !== "None" ? " | " + e.notes : "")
        ).join("\n"));
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /add-schedule ──────────────────────────────────────
    if (commandName === "add-schedule") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) {
        await interaction.editReply("❌ This command is for Managers only.");
        return;
      }
      const event = {
        id:       makeId(),
        type:     interaction.options.getString("type"),
        opponent: interaction.options.getString("opponent"),
        date:     interaction.options.getString("date"),
        time:     interaction.options.getString("time"),
        notes:    interaction.options.getString("notes") || "None",
      };
      scheduleList.push(event);
      await interaction.editReply("✅ Event added to schedule!\n**" + event.opponent + "** — " + event.date + " @ " + event.time);
      return;
    }

    // ── /attendance ────────────────────────────────────────
    if (commandName === "attendance") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) {
        await interaction.editReply("❌ This command is for Managers only.");
        return;
      }
      const session = interaction.options.getString("session");
      const player  = interaction.options.getString("player");
      const status  = interaction.options.getString("status");
      if (!attendanceLogs.has(session)) attendanceLogs.set(session, new Map());
      attendanceLogs.get(session).set(player, status);
      const sessionLog = attendanceLogs.get(session);
      const statusIcon = { Present: "✅", Late: "🕐", Absent: "❌", Excused: "🟡" };
      const embed = pjaEmbed("📋 Attendance — " + session, 0x2563eb)
        .setDescription([...sessionLog.entries()].map(([p, s]) => (statusIcon[s] || "❓") + " **" + p + "** — " + s).join("\n"))
        .setFooter({ text: sessionLog.size + " player(s) logged | Project Azure (PJA)" });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /lineup ────────────────────────────────────────────
    if (commandName === "lineup") {
      await interaction.deferReply();
      const matchName = interaction.options.getString("match");
      const formation = interaction.options.getString("formation");
      const players   = interaction.options.getString("players");
      const bench     = interaction.options.getString("bench");
      const notes     = interaction.options.getString("notes");
      if (formation || players) {
        if (!isAdmin(member)) {
          await interaction.editReply("❌ Only Managers can set the lineup.");
          return;
        }
        const id = matchName || "current";
        lineups.set(id, { formation: formation || "TBD", players: players || "TBD", bench: bench || "None", notes: notes || "None", setBy: user.tag });
        const embed = pjaEmbed("📋 Lineup Set — " + id, 0x2563eb)
          .addFields(
            { name: "🗂️ Formation", value: formation || "TBD", inline: true },
            { name: "📝 Notes",     value: notes || "None",    inline: true },
            { name: "👥 Players",   value: players || "TBD" },
            { name: "🪑 Bench",     value: bench || "None" },
          )
          .setFooter({ text: "Set by " + user.tag + " | Project Azure (PJA)" });
        await interaction.editReply({ embeds: [embed] });
        return;
      }
      const id = matchName || "current";
      const lineup = lineups.get(id);
      if (!lineup) {
        await interaction.editReply("📋 No lineup set" + (matchName ? " for: " + matchName : "") + ". Managers can set one with `/lineup match:<name> formation:<f> players:<p>`.");
        return;
      }
      const embed = pjaEmbed("📋 Lineup — " + id, 0x2563eb)
        .addFields(
          { name: "🗂️ Formation", value: lineup.formation, inline: true },
          { name: "📝 Notes",     value: lineup.notes,     inline: true },
          { name: "👥 Players",   value: lineup.players },
          { name: "🪑 Bench",     value: lineup.bench },
        )
        .setFooter({ text: "Set by " + lineup.setBy + " | Project Azure (PJA)" });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /chemistry ─────────────────────────────────────────
    if (commandName === "chemistry") {
      await interaction.deferReply();
      const p1 = interaction.options.getString("player1");
      const p2 = interaction.options.getString("player2");
      const s1 = stats.get(p1);
      const s2 = stats.get(p2);
      let score = 0;
      let reasons = [];
      if (s1 && s2) {
        if (s1.matches > 0 && s2.matches > 0) { score += 30; reasons.push("Both have match experience"); }
        if (s1.motms > 0 && s2.motms > 0)     { score += 20; reasons.push("Both have MOTM awards"); }
        if (s1.goals > 0 && s2.assists > 0)    { score += 25; reasons.push(p1 + " scores, " + p2 + " assists"); }
        if (s2.goals > 0 && s1.assists > 0)    { score += 25; reasons.push(p2 + " scores, " + p1 + " assists"); }
        score = Math.min(score, 100);
      } else {
        score = Math.floor(Math.random() * 40) + 40;
        reasons.push("No shared match data — estimated score");
      }
      const bar = "█".repeat(Math.floor(score / 10)) + "░".repeat(10 - Math.floor(score / 10));
      const color = score >= 75 ? 0x22c55e : score >= 50 ? 0xf59e0b : 0xef4444;
      const embed = pjaEmbed("⚡ Chemistry — " + p1 + " & " + p2, color)
        .setDescription("**Score: " + score + "/100**\n`" + bar + "`")
        .addFields({ name: "📊 Analysis", value: reasons.length > 0 ? reasons.map(r => "• " + r).join("\n") : "No data available" });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /duo ───────────────────────────────────────────────
    if (commandName === "duo") {
      await interaction.deferReply();
      const player = interaction.options.getString("player");
      const playerStats = stats.get(player);
      if (stats.size < 2) {
        await interaction.editReply("📊 Not enough player data yet. Stats build up after match reports.");
        return;
      }
      let bestPartner = null;
      let bestScore = -1;
      for (const [ign, s] of stats.entries()) {
        if (ign === player) continue;
        let score = 0;
        if (playerStats) {
          if (playerStats.goals > 0 && s.assists > 0) score += 30;
          if (playerStats.assists > 0 && s.goals > 0) score += 30;
          if (s.motms > 0) score += 20;
          if (s.matches > 0) score += 20;
        } else {
          score = Math.floor(Math.random() * 60) + 20;
        }
        if (score > bestScore) { bestScore = score; bestPartner = ign; }
      }
      const color = bestScore >= 75 ? 0x22c55e : bestScore >= 50 ? 0xf59e0b : 0xef4444;
      const embed = pjaEmbed("👥 Best Duo For " + player, color)
        .setDescription("Based on PJA match data, the best duo partner for **" + player + "** is:")
        .addFields(
          { name: "🤝 Recommended Partner", value: "**" + bestPartner + "**", inline: true },
          { name: "⚡ Duo Score",           value: bestScore + "/100",         inline: true },
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /weaknesses ────────────────────────────────────────
    if (commandName === "weaknesses") {
      await interaction.deferReply();
      const team  = interaction.options.getString("team");
      const areas = interaction.options.getString("areas");
      if (areas) {
        if (!isAdmin(member)) {
          await interaction.editReply("❌ Only Managers can set weaknesses.");
          return;
        }
        const areaList = areas.split(",").map(a => a.trim()).filter(Boolean);
        weaknesses.set(team, { areas: areaList, updatedBy: user.tag, updatedAt: new Date().toISOString() });
        const embed = pjaEmbed("⚠️ Weaknesses Set — " + team, 0xf59e0b)
          .setDescription(areaList.map(a => "• " + a).join("\n"))
          .setFooter({ text: "Set by " + user.tag + " | Project Azure (PJA)" });
        await interaction.editReply({ embeds: [embed] });
        return;
      }
      const data = weaknesses.get(team);
      if (!data) {
        await interaction.editReply("📋 No weaknesses tracked for **" + team + "** yet. Managers can add with `/weaknesses team:" + team + " areas:Defending,Set Pieces`");
        return;
      }
      const embed = pjaEmbed("⚠️ Weaknesses — " + team, 0xf59e0b)
        .setDescription(data.areas.map(a => "• " + a).join("\n"))
        .setFooter({ text: "Last updated by " + data.updatedBy + " | Project Azure (PJA)" });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /contract ──────────────────────────────────────────
    if (commandName === "contract") {
      await interaction.deferReply();
      if (!                
          // ── BUTTON HANDLER ────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  try {
    await interaction.deferUpdate();

    const { customId, user, member } = interaction;
    const parts = customId.split("_");

    // ── Friendly RSVP buttons ─────────────────────────────
    if (parts[0] === "going" || parts[0] === "maybe" || parts[0] === "cantgo") {
      const action     = parts[0];
      const friendlyId = parts[1];
      const data = friendlies.get(friendlyId);
      if (!data) return;

      const name       = member ? member.displayName : user.username;
      const prevChoice = data.responses.get(user.id);

      if (prevChoice === "going")  data.going.delete(name);
      if (prevChoice === "maybe")  data.maybe.delete(name);
      if (prevChoice === "cantgo") data.cantGo.delete(name);

      if (prevChoice === action) {
        data.responses.delete(user.id);
      } else {
        if (action === "going")  data.going.add(name);
        if (action === "maybe")  data.maybe.add(name);
        if (action === "cantgo") data.cantGo.add(name);
        data.responses.set(user.id, action);
      }

      await interaction.editReply({ embeds: [buildFriendlyEmbed(data)], components: [buildFriendlyButtons(friendlyId)] });
      return;
    }

    // ── Application decision buttons ──────────────────────
    if (parts[0] === "app") {
      if (!isAdmin(member)) {
        await interaction.followUp({ content: "❌ You don't have permission to do this.", ephemeral: true });
        return;
      }
      const action = parts[1];
      const appId  = parts[2];
      const app    = [...applications.values()].find(a => a.id === appId);
      if (!app) {
        await interaction.followUp({ content: "❌ Application not found.", ephemeral: true });
        return;
      }

      const statusMap = { accept: "accepted", deny: "denied", trialist: "trialist", needsclips: "needsclips" };
      app.status = statusMap[action] || action;

      const dmMessages = {
        accept:     "🎉 Congratulations **" + app.ign + "**! Your tryout application for **Project Azure** has been **ACCEPTED**! A manager will be in touch shortly.",
        deny:       "Hi **" + app.ign + "**, thank you for applying to **Project Azure**. Unfortunately your application was not successful at this time. Keep practising and feel free to apply again!",
        trialist:   "Hi **" + app.ign + "**! You've been offered a **Trialist** spot at **Project Azure**! A manager will contact you with the details.",
        needsclips: "Hi **" + app.ign + "**, your application is looking good but we'd like to see **more clips** before making a decision. Please send additional highlight clips to a manager!",
      };
      const dmColors = { accept: 0x22c55e, deny: 0xef4444, trialist: 0x3b82f6, needsclips: 0xf59e0b };

      try {
        const applicant = await client.users.fetch(app.userId).catch(() => null);
        if (applicant) {
          await applicant.send({ embeds: [
            new EmbedBuilder()
              .setTitle("PJA Tryout Application Update")
              .setColor(dmColors[action] || 0x2563eb)
              .setDescription(dmMessages[action] || "Your application status has been updated.")
              .setTimestamp()
          ]});
        }
      } catch (e) { console.log("Could not DM applicant"); }

      const actionLabel = { accept: "✅ Accepted", deny: "❌ Denied", trialist: "🔵 Trialist", needsclips: "🎬 Needs Clips" };
      await interaction.followUp({ content: "**" + app.ign + "** — " + (actionLabel[action] || action) + ". Applicant notified.", ephemeral: true });
      return;
    }

  } catch (err) {
    console.error("Button handler error:", err);
    try {
      await interaction.followUp({ content: "❌ Something went wrong.", ephemeral: true });
    } catch (e) { console.error("Could not send button error reply:", e.message); }
  }
});

// ── REMINDER SCHEDULER ───────────────────────────────────────
setInterval(async () => {
  const now = Date.now();
  for (const [id, reminder] of reminders.entries()) {
    if (now >= reminder.triggerAt) {
      try {
        const channel = await client.channels.fetch(reminder.channelId).catch(() => null);
        if (channel) {
          const embed = new EmbedBuilder()
            .setTitle("⏰ Team Reminder")
            .setDescription(reminder.message)
            .setColor(0x2563eb)
            .setFooter({ text: "Project Azure (PJA)" })
            .setTimestamp();
          await channel.send({ embeds: [embed] });
        }
        if (reminder.repeatMs) {
          reminder.triggerAt = now + reminder.repeatMs;
        } else {
          reminders.delete(id);
        }
      } catch (err) {
        console.error("Reminder error:", err);
        reminders.delete(id);
      }
    }
  }
}, 30000);

// ── LOGIN ─────────────────────────────────────────────────────
client.login(TOKEN);
      
