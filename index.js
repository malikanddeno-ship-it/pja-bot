require("./keep-alive");
const {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  SlashCommandBuilder, REST, Routes,
} = require("discord.js");
require("dotenv").config();

const TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID  = process.env.GUILD_ID;
const ADMIN_ROLES = ["Manager", "Admin", "Owner", "Coach", "TEAM MANAGER", "CAPTIAN"];

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

const roster = [];
const friendlies = new Map();
const applications = new Map();
const matchReports = [];
const scheduleList = [];
const attendanceLogs = new Map();
const lineups = new Map();
const stats = new Map();

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
    .addStringOption(o => o.setName("position").setDescription("Main position").setRequired(true).addChoices(
      { name: "GK", value: "GK" }, { name: "CB", value: "CB" }, { name: "LB", value: "LB" },
      { name: "RB", value: "RB" }, { name: "CDM", value: "CDM" }, { name: "CM", value: "CM" },
      { name: "CAM", value: "CAM" }, { name: "LW/LM", value: "LW" }, { name: "RW/RM", value: "RW" }, { name: "ST", value: "ST" }
    ))
    .addStringOption(o => o.setName("backup").setDescription("Backup position").setRequired(true).addChoices(
      { name: "GK", value: "GK" }, { name: "CB", value: "CB" }, { name: "LB", value: "LB" },
      { name: "RB", value: "RB" }, { name: "CDM", value: "CDM" }, { name: "CM", value: "CM" },
      { name: "CAM", value: "CAM" }, { name: "LW/LM", value: "LW" }, { name: "RW/RM", value: "RW" },
      { name: "ST", value: "ST" }, { name: "None", value: "None" }
    ))
    .addStringOption(o => o.setName("skill").setDescription("Skill level").setRequired(true).addChoices(
      { name: "Beginner", value: "Beginner" }, { name: "Intermediate", value: "Intermediate" },
      { name: "Advanced", value: "Advanced" }, { name: "Elite", value: "Elite" }
    ))
    .addStringOption(o => o.setName("timezone").setDescription("Your timezone e.g. GMT").setRequired(true))
    .addStringOption(o => o.setName("availability").setDescription("When are you available?").setRequired(true))
    .addStringOption(o => o.setName("priority").setDescription("Team priority").setRequired(true).addChoices(
      { name: "1st Main", value: "1st Main" }, { name: "2nd Main", value: "2nd Main" },
      { name: "3rd Main", value: "3rd Main" }, { name: "Other", value: "Other" }
    ))
    .addStringOption(o => o.setName("clip").setDescription("Clip/highlight link").setRequired(false))
    .addStringOption(o => o.setName("why").setDescription("Why do you want to join PJA?").setRequired(false))
    .addStringOption(o => o.setName("bring").setDescription("What can you bring to PJA?").setRequired(false)),
  new SlashCommandBuilder().setName("applications").setDescription("View tryout applications [Manager only]")
    .addStringOption(o => o.setName("filter").setDescription("Filter by status").setRequired(false).addChoices(
      { name: "All", value: "all" }, { name: "Pending", value: "pending" },
      { name: "Accepted", value: "accepted" }, { name: "Denied", value: "denied" },
      { name: "Trialist", value: "trialist" }, { name: "Needs Clips", value: "needsclips" }
    )),
  new SlashCommandBuilder().setName("match-report").setDescription("Post a match report [Manager only]")
    .addStringOption(o => o.setName("opponent").setDescription("Opponent name").setRequired(true))
    .addStringOption(o => o.setName("score").setDescription("Score e.g. 3-1").setRequired(true))
    .addStringOption(o => o.setName("result").setDescription("Result").setRequired(true).addChoices(
      { name: "Win", value: "Win" }, { name: "Loss", value: "Loss" }, { name: "Draw", value: "Draw" }
    ))
    .addStringOption(o => o.setName("scorers").setDescription("Goal scorers comma separated").setRequired(false))
    .addStringOption(o => o.setName("assists").setDescription("Assisters comma separated").setRequired(false))
    .addStringOption(o => o.setName("saves").setDescription("Saves comma separated").setRequired(false))
    .addStringOption(o => o.setName("motm").setDescription("Man of the Match").setRequired(false))
    .addStringOption(o => o.setName("notes").setDescription("Extra notes").setRequired(false)),
  new SlashCommandBuilder().setName("leaderboard").setDescription("View PJA player leaderboard")
    .addStringOption(o => o.setName("category").setDescription("Category").setRequired(false).addChoices(
      { name: "Goals", value: "goals" }, { name: "Assists", value: "assists" },
      { name: "Saves", value: "saves" }, { name: "MOTMs", value: "motms" }, { name: "Matches Played", value: "matches" }
    )),
  new SlashCommandBuilder().setName("schedule").setDescription("View upcoming matches and events")
    .addStringOption(o => o.setName("type").setDescription("Filter by type").setRequired(false).addChoices(
      { name: "All", value: "all" }, { name: "Match", value: "match" },
      { name: "Friendly", value: "friendly" }, { name: "Scrim", value: "scrim" }, { name: "Practice", value: "practice" }
    )),
  new SlashCommandBuilder().setName("add-schedule").setDescription("Add an event to the schedule [Manager only]")
    .addStringOption(o => o.setName("type").setDescription("Event type").setRequired(true).addChoices(
      { name: "Match", value: "match" }, { name: "Friendly", value: "friendly" },
      { name: "Scrim", value: "scrim" }, { name: "Practice", value: "practice" }
    ))
    .addStringOption(o => o.setName("opponent").setDescription("Opponent or event name").setRequired(true))
    .addStringOption(o => o.setName("date").setDescription("Date e.g. 14 Jun 2026").setRequired(true))
    .addStringOption(o => o.setName("time").setDescription("Time e.g. 7pm GMT").setRequired(true))
    .addStringOption(o => o.setName("notes").setDescription("Extra notes").setRequired(false)),
  new SlashCommandBuilder().setName("attendance").setDescription("Mark player attendance [Manager only]")
    .addStringOption(o => o.setName("session").setDescription("Session name or ID").setRequired(true))
    .addStringOption(o => o.setName("player").setDescription("Player IGN").setRequired(true))
    .addStringOption(o => o.setName("status").setDescription("Attendance status").setRequired(true).addChoices(
      { name: "Present", value: "Present" }, { name: "Late", value: "Late" },
      { name: "Absent", value: "Absent" }, { name: "Excused", value: "Excused" }
    )),
  new SlashCommandBuilder().setName("lineup").setDescription("View or set the team lineup")
    .addStringOption(o => o.setName("match").setDescription("Match name or ID").setRequired(false))
    .addStringOption(o => o.setName("formation").setDescription("Formation e.g. 4-3-3").setRequired(false))
    .addStringOption(o => o.setName("players").setDescription("Players e.g. PlayerA-GK, PlayerB-CB").setRequired(false))
    .addStringOption(o => o.setName("bench").setDescription("Bench players comma separated").setRequired(false))
    .addStringOption(o => o.setName("notes").setDescription("Notes").setRequired(false)),
].map(c => c.toJSON());

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

client.once("ready", async () => {
  console.log("Logged in as: " + client.user.tag);
  client.user.setActivity("PJA Bot | /tryout", { type: 3 });
  await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, user, member } = interaction;
  try {

    if (commandName === "ping") {
      await interaction.reply({ content: "🏓 Pong! " + client.ws.ping + "ms — Bot is online ✅", ephemeral: true });
      return;
    }

    if (commandName === "roster") {
      await interaction.deferReply();
      if (roster.length === 0) { await interaction.editReply("📋 The roster is currently empty."); return; }
      const roleOrder = ["Captain", "Co-Captain", "Starter", "Backup", "Trialist", "Academy"];
      const sorted = [...roster].sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role));
      const embed = pjaEmbed("🔷 Project Azure — Current Roster")
        .setDescription(sorted.map(p => "**" + p.ign + "** — " + p.position + " | " + p.role + (p.timezone ? " | " + p.timezone : "")).join("\n"))
        .setFooter({ text: roster.length + " player(s) | Project Azure (PJA)" });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (commandName === "friendly") {
      await interaction.deferReply();
      const id = makeId();
      const data = {
        opponent:  interaction.options.getString("opponent"),
        date:      interaction.options.getString("date"),
        time:      interaction.options.getString("time"),
        notes:     interaction.options.getString("notes") || "None",
        going:     new Set(), maybe: new Set(), cantGo: new Set(), responses: new Map(),
      };
      friendlies.set(id, data);
      await interaction.editReply({ embeds: [buildFriendlyEmbed(data)], components: [buildFriendlyButtons(id)] });
      return;
    }

    if (commandName === "tryout") {
      await interaction.deferReply({ ephemeral: true });
      if (applications.has(user.id)) {
        const ex = applications.get(user.id);
        await interaction.editReply("⚠️ You already have an application!\n**Status:** " + ex.status.toUpperCase() + "\n**IGN:** " + ex.ign);
        return;
      }
      const appId = makeId();
      const app = {
        id: appId, userId: user.id, username: user.tag,
        ign:          interaction.options.getString("ign"),
        position:     interaction.options.getString("position"),
        backup:       interaction.options.getString("backup"),
        skill:        interaction.options.getString("skill"),
        timezone:     interaction.options.getString("timezone"),
        availability: interaction.options.getString("availability"),
        priority:     interaction.options.getString("priority"),
        clip:         interaction.options.getString("clip")  || "Not provided",
        why:          interaction.options.getString("why")   || "Not provided",
        bring:        interaction.options.getString("bring") || "Not provided",
        status: "pending", submittedAt: new Date().toISOString(), note: "",
      };
      applications.set(user.id, app);
      try {
        await user.send({ embeds: [pjaEmbed("✅ Tryout Application Received", 0x2563eb)
          .setDescription("Your application for **Project Azure** has been submitted! Management will review it shortly.")
          .addFields(
            { name: "App ID",       value: appId,           inline: true },
            { name: "IGN",          value: app.ign,          inline: true },
            { name: "Position",     value: app.position,     inline: true },
            { name: "Skill",        value: app.skill,        inline: true },
            { name: "Timezone",     value: app.timezone,     inline: true },
            { name: "Priority",     value: app.priority,     inline: true },
            { name: "Availability", value: app.availability },
            { name: "Status",       value: "⏳ Pending Review" }
          )] });
      } catch (e) { console.log("Could not DM applicant"); }
      await interaction.editReply("✅ Application submitted!\n**App ID: " + appId + "** — save this!\nWe will DM you with a decision. Good luck! 🏆");
      return;
    }

    if (commandName === "applications") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ Managers only."); return; }
      const filter = interaction.options.getString("filter") || "all";
      let apps = [...applications.values()];
      if (filter !== "all") apps = apps.filter(a => a.status === filter);
      if (apps.length === 0) { await interaction.editReply("📭 No applications found."); return; }
      const statusEmoji = { pending: "⏳", accepted: "✅", denied: "❌", trialist: "🔵", needsclips: "🎬" };
      const embed = pjaEmbed("📋 Applications — " + filter.toUpperCase() + " (" + apps.length + ")", 0xf59e0b)
        .setDescription(apps.slice(0, 20).map(a =>
          (statusEmoji[a.status] || "❓") + " **" + a.id + "** — " + a.ign + " | " + a.position + " | " + a.skill + " | <@" + a.userId + ">"
        ).join("\n"));
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

    if (commandName === "match-report") {
      await interaction.deferReply();
      if (!isAdmin(member)) { await interaction.editReply("❌ Managers only."); return; }
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
      if (scorers !== "None") scorers.split(",").map(s => s.trim()).filter(Boolean).forEach(p => { statFor(p).goals++; statFor(p).matches++; });
      if (assists !== "None") assists.split(",").map(s => s.trim()).filter(Boolean).forEach(p => { statFor(p).assists++; });
      if (saves   !== "None") saves.split(",").map(s => s.trim()).filter(Boolean).forEach(p => { statFor(p).saves++; });
      if (motm !== "TBD" && motm !== "None") statFor(motm).motms++;
      const resultColor = result === "Win" ? 0x22c55e : result === "Loss" ? 0xef4444 : 0xf59e0b;
      const resultIcon  = result === "Win" ? "✅" : result === "Loss" ? "❌" : "🟡";
      const embed = pjaEmbed(resultIcon + " Match Report — PJA vs " + opponent, resultColor)
        .addFields(
          { name: "Result",      value: result,   inline: true },
          { name: "Score",       value: score,    inline: true },
          { name: "Report ID",   value: reportId, inline: true },
          { name: "⚽ Scorers",  value: scorers },
          { name: "🎯 Assists",  value: assists,  inline: true },
          { name: "🧤 Saves",    value: saves,    inline: true },
          { name: "🏆 MOTM",     value: motm,     inline: true },
          { name: "📝 Notes",    value: notes },
        )
        .setFooter({ text: "Reported by " + user.tag + " | Project Azure (PJA)" });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (commandName === "leaderboard") {
      await interaction.deferReply();
      const category = interaction.options.getString("category") || "goals";
      if (stats.size === 0) { await interaction.editReply("📊 No stats recorded yet. Stats update after match reports."); return; }
      const entries = [...stats.entries()].sort((a, b) => b[1][category] - a[1][category]).slice(0, 10);
      const categoryLabel = { goals: "⚽ Goals", assists: "🎯 Assists", saves: "🧤 Saves", motms: "🏆 MOTMs", matches: "🎮 Matches" };
      const embed = pjaEmbed("🏅 Leaderboard — " + (categoryLabel[category] || category))
        .setDescription(entries.map((e, i) => {
          const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : (i + 1) + ".";
          return medal + " **" + e[0] + "** — " + e[1][category];
        }).join("\n"));
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (commandName === "schedule") {
      await interaction.deferReply();
      const typeFilter = interaction.options.getString("type") || "all";
      let events = [...scheduleList];
      if (typeFilter !== "all") events = events.filter(e => e.type === typeFilter);
      if (events.length === 0) { await interaction.editReply("📅 No events scheduled. Managers can add with `/add-schedule`."); return; }
      const typeIcon = { match: "🏆", friendly: "⚽", scrim: "⚔️", practice: "🏋️" };
      const embed = pjaEmbed("📅 PJA Schedule")
        .setDescription(events.slice(0, 15).map(e =>
          (typeIcon[e.type] || "📌") + " **" + e.opponent + "** | " + e.date + " @ " + e.time + (e.notes !== "None" ? " | " + e.notes : "")
        ).join("\n"));
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (commandName === "add-schedule") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ Managers only."); return; }
      const event = {
        id: makeId(),
        type:     interaction.options.getString("type"),
        opponent: interaction.options.getString("opponent"),
        date:     interaction.options.getString("date"),
        time:     interaction.options.getString("time"),
        notes:    interaction.options.getString("notes") || "None",
      };
      scheduleList.push(event);
      await interaction.editReply("✅ Added to schedule: **" + event.opponent + "** — " + event.date + " @ " + event.time);
      return;
    }

    if (commandName === "attendance") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ Managers only."); return; }
      const session = interaction.options.getString("session");
      const player  = interaction.options.getString("player");
      const status  = interaction.options.getString("status");
      if (!attendanceLogs.has(session)) attendanceLogs.set(session, new Map());
      attendanceLogs.get(session).set(player, status);
      const sessionLog = attendanceLogs.get(session);
      const statusIcon = { Present: "✅", Late: "🕐", Absent: "❌", Excused: "🟡" };
      const embed = pjaEmbed("📋 Attendance — " + session)
        .setDescription([...sessionLog.entries()].map(([p, s]) => (statusIcon[s] || "❓") + " **" + p + "** — " + s).join("\n"))
        .setFooter({ text: sessionLog.size + " player(s) logged | Project Azure (PJA)" });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (commandName === "lineup") {
      await interaction.deferReply();
      const matchName = interaction.options.getString("match");
      const formation = interaction.options.getString("formation");
      const players   = interaction.options.getString("players");
      const bench     = interaction.options.getString("bench");
      const notes     = interaction.options.getString("notes");
      if (formation || players) {
        if (!isAdmin(member)) { await interaction.editReply("❌ Only Managers can set the lineup."); return; }
        const id = matchName || "current";
        lineups.set(id, { formation: formation || "TBD", players: players || "TBD", bench: bench || "None", notes: notes || "None", setBy: user.tag });
        const embed = pjaEmbed("📋 Lineup Set — " + id)
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
      if (!lineup) { await interaction.editReply("📋 No lineup set yet. Managers can set one with `/lineup formation:<f> players:<p>`."); return; }
      const embed = pjaEmbed("📋 Lineup — " + id)
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

  } catch (err) {
    console.error("Error in /" + commandName + ":", err);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply("❌ Something went wrong. Please try again.");
      } else {
        await interaction.reply({ content: "❌ Something went wrong. Please try again.", ephemeral: true });
      }
    } catch (e) { console.error("Could not send error reply:", e.message); }
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  try {
    await interaction.deferUpdate();
    const { customId, user, member } = interaction;
    const parts  = customId.split("_");
    const action = parts[0];

    if (action === "going" || action === "maybe" || action === "cantgo") {
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

    if (action === "app") {
      if (!isAdmin(member)) { await interaction.followUp({ content: "❌ No permission.", ephemeral: true }); return; }
      const appAction = parts[1];
      const appId     = parts[2];
      const app       = [...applications.values()].find(a => a.id === appId);
      if (!app) { await interaction.followUp({ content: "❌ Application not found.", ephemeral: true }); return; }
      const statusMap = { accept: "accepted", deny: "denied", trialist: "trialist", needsclips: "needsclips" };
      app.status = statusMap[appAction] || appAction;
      const dmMessages = {
        accept:     "🎉 Congratulations **" + app.ign + "**! Your tryout application for **Project Azure** has been **ACCEPTED**! A manager will be in touch shortly.",
        deny:       "Hi **" + app.ign + "**, thank you for applying. Unfortunately your application was not successful. Keep practising and feel free to apply again!",
        trialist:   "Hi **" + app.ign + "**! You have been offered a **Trialist** spot at **Project Azure**! A manager will contact you with details.",
        needsclips: "Hi **" + app.ign + "**, your application looks good but we need **more clips**. Please send additional highlights to a manager!",
      };
      const dmColors = { accept: 0x22c55e, deny: 0xef4444, trialist: 0x3b82f6, needsclips: 0xf59e0b };
      try {
        const applicant = await client.users.fetch(app.userId).catch(() => null);
        if (applicant) await applicant.send({ embeds: [new EmbedBuilder()
          .setTitle("PJA Tryout Application Update").setColor(dmColors[appAction] || 0x2563eb)
          .setDescription(dmMessages[appAction] || "Your application status has been updated.").setTimestamp()] });
      } catch (e) { console.log("Could not DM applicant"); }
      const actionLabel = { accept: "✅ Accepted", deny: "❌ Denied", trialist: "🔵 Trialist", needsclips: "🎬 Needs Clips" };
      await interaction.followUp({ content: "**" + app.ign + "** — " + (actionLabel[appAction] || appAction) + ". Applicant notified.", ephemeral: true });
      return;
    }

  } catch (err) {
    console.error("Button error:", err);
    try { await interaction.followUp({ content: "❌ Something went wrong.", ephemeral: true }); } catch (e) {}
  }
});

client.login(TOKEN);
