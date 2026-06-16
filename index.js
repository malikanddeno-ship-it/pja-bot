const { setMatchHandler } = require("./keep-alive");
const {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  SlashCommandBuilder, REST, Routes,
} = require("discord.js");
require("dotenv").config();

// ── CONFIG ───────────────────────────────────────────────────
const TOKEN        = process.env.DISCORD_TOKEN;
const CLIENT_ID    = process.env.CLIENT_ID;
const GUILD_ID     = process.env.GUILD_ID;
const WEBSITE_API  = process.env.WEBSITE_API || "https://syfnafne.gensparkspace.com/tables/";
const ADMIN_ROLES  = ["Manager", "Admin", "Owner", "Coach", "TEAM MANAGER", "CAPTIAN"];
const CAPTAIN_ROLES = ["Captain", "Co-Captain", ...ADMIN_ROLES];

// ── CLIENT ───────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

// ── DATA STORES ──────────────────────────────────────────────
const friendlies     = new Map();  // match RSVP embeds
const applications   = new Map();  // tryout apps
const scheduleList   = [];
const attendanceLogs = new Map();
const lineups        = new Map();
const weaknesses     = new Map();
const contracts      = [];
const reminders      = new Map();
const activityChecks = new Map();  // activity check embeds
const teamVotes      = new Map();  // team vote polls
const giveaways      = new Map();  // giveaway data
const playerRequests = new Map();  // player requests
const playerAwards   = new Map();  // awards per player IGN

// ── WEBSITE API ───────────────────────────────────────────────
async function apiGet(table) {
  try {
    const res = await fetch(WEBSITE_API + table + "?limit=500");
    if (!res.ok) return [];
    const json = await res.json();
    return json.data || [];
  } catch (e) {
    console.error("apiGet error for " + table + ":", e.message);
    return [];
  }
}
async function apiPost(table, body) {
  try {
    const res = await fetch(WEBSITE_API + table, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error("apiPost error for " + table + ":", e.message);
    return null;
  }
}

// ── HELPERS ───────────────────────────────────────────────────
function isAdmin(member) {
  return member.roles.cache.some(r => ADMIN_ROLES.includes(r.name));
}
function isCaptain(member) {
  return member.roles.cache.some(r => CAPTAIN_ROLES.includes(r.name));
}
function makeId() {
  return Date.now().toString(36).toUpperCase();
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

// ── FRIENDLY / MATCH RSVP EMBED BUILDERS ─────────────────────
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
function buildMatchRsvpEmbed(data) {
  const goingList = data.going.size  > 0 ? [...data.going].map(n  => "• " + n).join("\n") : "Nobody yet";
  const maybeList = data.maybe.size  > 0 ? [...data.maybe].map(n  => "• " + n).join("\n") : "Nobody yet";
  const cantList  = data.cantGo.size > 0 ? [...data.cantGo].map(n => "• " + n).join("\n") : "Nobody yet";
  const typeIcon  = { Match: "🏆", Friendly: "⚽", Scrim: "⚔️", Practice: "🏋️" };
  return new EmbedBuilder()
    .setTitle((typeIcon[data.type] || "📌") + " " + data.type + " — PJA vs " + data.opponent)
    .setColor(0x2563eb)
    .addFields(
      { name: "🆚 Opponent", value: data.opponent,      inline: true },
      { name: "📅 Date",     value: data.date,           inline: true },
      { name: "🕐 Time",     value: data.time,           inline: true },
      { name: "📝 Notes",    value: data.notes || "None" },
      { name: "✅ Going ("    + data.going.size  + ")", value: goingList, inline: true },
      { name: "❓ Maybe ("    + data.maybe.size  + ")", value: maybeList, inline: true },
      { name: "❌ Can't Go (" + data.cantGo.size + ")", value: cantList,  inline: true },
    )
    .setFooter({ text: "Click a button to respond • Click again to remove | Project Azure (PJA)" })
    .setTimestamp();
}
function buildRsvpButtons(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("going_"  + id).setLabel("✅ I'm Going").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("maybe_"  + id).setLabel("❓ Maybe")    .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("cantgo_" + id).setLabel("❌ Can't Go") .setStyle(ButtonStyle.Danger),
  );
}

// ── SLASH COMMANDS ───────────────────────────────────────────
const commands = [

  // ── EXISTING COMMANDS ──────────────────────────────────────
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
        { name: "Match", value: "Match" }, { name: "Friendly", value: "Friendly" },
        { name: "Scrim", value: "Scrim" }, { name: "Practice", value: "Practice" }
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

  // ── NEW COMMANDS ───────────────────────────────────────────

  // /profile
  new SlashCommandBuilder().setName("profile").setDescription("View a player's full profile")
    .addStringOption(o => o.setName("ign").setDescription("Player's VRFS username").setRequired(true)),

  // /id-card
  new SlashCommandBuilder().setName("id-card").setDescription("Generate a PJA player ID card")
    .addStringOption(o => o.setName("ign").setDescription("Player's VRFS username").setRequired(true)),

  // /request
  new SlashCommandBuilder().setName("request").setDescription("Send a request to the PJA managers")
    .addStringOption(o => o.setName("type").setDescription("Type of request").setRequired(true)
      .addChoices(
        { name: "Role Change",       value: "Role Change" },
        { name: "Position Change",   value: "Position Change" },
        { name: "Tryout Review",     value: "Tryout Review" },
        { name: "Roster Update",     value: "Roster Update" },
        { name: "Stat Correction",   value: "Stat Correction" },
        { name: "Scrim/Friendly Help", value: "Scrim/Friendly Help" },
        { name: "Transfer/Release",  value: "Transfer/Release" },
        { name: "Other",             value: "Other" }
      ))
    .addStringOption(o => o.setName("details").setDescription("Describe your request in detail").setRequired(true))
    .addStringOption(o => o.setName("ign").setDescription("Your VRFS username").setRequired(false)),

  // /trial-review
  new SlashCommandBuilder().setName("trial-review").setDescription("Rate a trialist [Manager only]")
    .addStringOption(o => o.setName("player").setDescription("Trialist IGN").setRequired(true))
    .addIntegerOption(o => o.setName("mechanics").setDescription("Mechanics score 1-10").setRequired(true).setMinValue(1).setMaxValue(10))
    .addIntegerOption(o => o.setName("positioning").setDescription("Positioning score 1-10").setRequired(true).setMinValue(1).setMaxValue(10))
    .addIntegerOption(o => o.setName("communication").setDescription("Communication score 1-10").setRequired(true).setMinValue(1).setMaxValue(10))
    .addIntegerOption(o => o.setName("teamwork").setDescription("Teamwork score 1-10").setRequired(true).setMinValue(1).setMaxValue(10))
    .addIntegerOption(o => o.setName("consistency").setDescription("Consistency score 1-10").setRequired(true).setMinValue(1).setMaxValue(10))
    .addIntegerOption(o => o.setName("gamesense").setDescription("Game sense score 1-10").setRequired(true).setMinValue(1).setMaxValue(10))
    .addStringOption(o => o.setName("notes").setDescription("Extra notes").setRequired(false)),

  // /award-give
  new SlashCommandBuilder().setName("award-give").setDescription("Give a player an award [Manager only]")
    .addStringOption(o => o.setName("player").setDescription("Player IGN").setRequired(true))
    .addStringOption(o => o.setName("award").setDescription("Award name e.g. MOTM, Golden Boot").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason for the award").setRequired(true)),

  // /awards
  new SlashCommandBuilder().setName("awards").setDescription("View a player's awards")
    .addStringOption(o => o.setName("player").setDescription("Player IGN").setRequired(true)),

  // /activity-check
  new SlashCommandBuilder().setName("activity-check").setDescription("Post an activity check [Manager/Captain]")
    .addStringOption(o => o.setName("message").setDescription("Message e.g. 'Check in for this week!'").setRequired(false))
    .addStringOption(o => o.setName("deadline").setDescription("Deadline e.g. Sunday midnight").setRequired(false)),

  // /team-vote
  new SlashCommandBuilder().setName("team-vote").setDescription("Create a team vote/poll [Manager/Captain]")
    .addStringOption(o => o.setName("question").setDescription("The question to vote on").setRequired(true))
    .addStringOption(o => o.setName("option1").setDescription("Option 1").setRequired(true))
    .addStringOption(o => o.setName("option2").setDescription("Option 2").setRequired(true))
    .addStringOption(o => o.setName("option3").setDescription("Option 3 (optional)").setRequired(false))
    .addStringOption(o => o.setName("option4").setDescription("Option 4 (optional)").setRequired(false)),

  // /giveaway
  new SlashCommandBuilder().setName("giveaway").setDescription("Start a giveaway [Manager only]")
    .addStringOption(o => o.setName("prize").setDescription("What are you giving away?").setRequired(true))
    .addStringOption(o => o.setName("duration").setDescription("Duration e.g. 1h, 30m, 1d, 7d").setRequired(true))
    .addIntegerOption(o => o.setName("winners").setDescription("Number of winners").setRequired(true).setMinValue(1).setMaxValue(10))
    .addStringOption(o => o.setName("requirements").setDescription("Entry requirements (optional)").setRequired(false))
    .addStringOption(o => o.setName("notes").setDescription("Extra notes (optional)").setRequired(false)),

  // /giveaway-end
  new SlashCommandBuilder().setName("giveaway-end").setDescription("End a giveaway early [Manager only]")
    .addStringOption(o => o.setName("id").setDescription("Giveaway ID").setRequired(true)),

  // /giveaway-reroll
  new SlashCommandBuilder().setName("giveaway-reroll").setDescription("Reroll a giveaway winner [Manager only]")
    .addStringOption(o => o.setName("id").setDescription("Giveaway ID").setRequired(true)),

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

registerCommands().then(() => {
  client.login(TOKEN);
}).catch(err => {
  console.error("Startup error:", err);
  client.login(TOKEN);
});

// ── READY ─────────────────────────────────────────────────────
client.once("ready", async () => {
  console.log("Logged in as: " + client.user.tag);
  try { client.user.setActivity("PJA Bot | /tryout", { type: 3 }); } catch(e) {}
  console.log("Bot fully ready!");

  // Website → Discord match RSVP handler
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
      const embed   = buildMatchRsvpEmbed(matchData);
      const buttons = buildRsvpButtons(id);
      await channel.send({ embeds: [embed], components: [buttons] });
      console.log("Posted match RSVP embed for: " + matchData.opponent);
    } catch (err) {
      console.error("Error posting match embed:", err);
    }
  });
});

// ── GIVEAWAY HELPER ───────────────────────────────────────────
function buildGiveawayEmbed(data) {
  const entries   = data.entries.size;
  const endUnix   = Math.floor(data.endsAt / 1000);
  const statusStr = data.ended ? "🔴 ENDED" : "🟢 ACTIVE";
  return new EmbedBuilder()
    .setTitle("🎉 GIVEAWAY — " + data.prize)
    .setColor(data.ended ? 0x6b7280 : 0x2563eb)
    .setDescription(
      "React with the button below to enter!\n\n" +
      (data.requirements ? "**Requirements:** " + data.requirements + "\n" : "") +
      (data.notes ? "**Notes:** " + data.notes + "\n" : "")
    )
    .addFields(
      { name: "🏆 Prize",      value: data.prize,                                  inline: true },
      { name: "🎫 Winners",    value: data.winnersCount + " winner(s)",             inline: true },
      { name: "👥 Entries",    value: entries + " entered",                         inline: true },
      { name: "⏰ Ends",       value: data.ended ? "Ended" : "<t:" + endUnix + ":R> (<t:" + endUnix + ":F>)", inline: false },
      { name: "🎙️ Hosted by", value: data.hostedBy,                               inline: true },
      { name: "🔵 Status",     value: statusStr,                                   inline: true },
    )
    .setFooter({ text: "Giveaway ID: " + data.id + " | Project Azure (PJA)" })
    .setTimestamp();
}
function buildGiveawayButton(id, ended) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("giveaway_enter_" + id)
      .setLabel(ended ? "🔒 Giveaway Ended" : "🎉 Enter Giveaway")
      .setStyle(ended ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(ended),
  );
}
function pickWinners(entries, count) {
  const arr = [...entries];
  const winners = [];
  const pool = [...arr];
  for (let i = 0; i < Math.min(count, pool.length); i++) {
    const idx = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(idx, 1)[0]);
  }
  return winners;
}

// ── ACTIVITY CHECK HELPERS ────────────────────────────────────
function buildActivityEmbed(data) {
  const active = data.active.size > 0 ? [...data.active].map(n => "✅ " + n).join("\n") : "No responses yet";
  return new EmbedBuilder()
    .setTitle("📋 Activity Check — Project Azure")
    .setColor(0x2563eb)
    .setDescription(data.message || "Click the button below to confirm you're active!")
    .addFields(
      { name: "⏰ Deadline", value: data.deadline || "No deadline set", inline: true },
      { name: "👥 Active (" + data.active.size + ")", value: active, inline: false },
    )
    .setFooter({ text: "Activity Check | Project Azure (PJA)" })
    .setTimestamp();
}

// ── VOTE HELPERS ─────────────────────────────────────────────
function buildVoteEmbed(data) {
  const total = [...data.options.values()].reduce((s, o) => s + o.voters.size, 0);
  const bars = data.options.map((opt, i) => {
    const count = opt.voters.size;
    const pct   = total > 0 ? Math.round((count / total) * 100) : 0;
    const bar   = "█".repeat(Math.floor(pct / 10)) + "░".repeat(10 - Math.floor(pct / 10));
    return `**${i + 1}. ${opt.label}** — ${count} vote(s) (${pct}%)\n\`${bar}\``;
  });
  return new EmbedBuilder()
    .setTitle("🗳️ Team Vote")
    .setColor(0x2563eb)
    .setDescription("**" + data.question + "**\n\n" + bars.join("\n\n"))
    .addFields({ name: "📊 Total Votes", value: total + " vote(s)", inline: true })
    .setFooter({ text: "Vote using the buttons below | Project Azure (PJA)" })
    .setTimestamp();
}

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
      const liveRoster = await apiGet("roster");
      if (liveRoster.length === 0) {
        await interaction.editReply("📋 The roster is currently empty.");
        return;
      }
      const roleOrder = ["Captain", "Co-Captain", "Starter", "Backup", "Trialist", "Academy"];
      const sorted = [...liveRoster].sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role));
      const embed = pjaEmbed("🔷 Project Azure — Current Roster")
        .setDescription(sorted.map(p =>
          "**" + (p.name || p.ign || "Unknown") + "** — " + (p.position || "?") +
          " | " + (p.role || "Player") + (p.timezone ? " | " + p.timezone : "")
        ).join("\n"))
        .setFooter({ text: liveRoster.length + " player(s) | Project Azure (PJA)" });
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
        type:      "Friendly",
        going:     new Set(),
        maybe:     new Set(),
        cantGo:    new Set(),
        responses: new Map(),
      };
      friendlies.set(id, data);
      await interaction.editReply({ embeds: [buildFriendlyEmbed(data)], components: [buildRsvpButtons(id)] });
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
        await apiPost("tryouts", { ...app, source: "discord" });
      } catch(e) {}
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
      try {
        await apiPost("match_reports", { id: reportId, opponent, score, result, scorers, assists, saves, motm, notes, date: new Date().toISOString(), source: "discord" });
      } catch (e) { console.error("Could not save match report:", e.message); }
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
      const category  = interaction.options.getString("category") || "goals";
      const liveStats = await apiGet("stats");
      if (liveStats.length === 0) {
        await interaction.editReply("📊 No stats recorded yet. Stats are updated after match reports.");
        return;
      }
      const categoryLabel = { goals: "⚽ Goals", assists: "🎯 Assists", saves: "🧤 Saves", motms: "🏆 MOTMs", matches: "🎮 Matches Played" };
      const sorted = [...liveStats].sort((a, b) => (Number(b[category]) || 0) - (Number(a[category]) || 0)).slice(0, 10);
      const embed = pjaEmbed("🏅 Leaderboard — " + (categoryLabel[category] || category))
        .setDescription(sorted.map((e, i) => {
          const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : (i + 1) + ".";
          return medal + " **" + (e.player || e.name || e.ign || "Unknown") + "** — " + (e[category] || 0);
        }).join("\n"));
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /schedule ──────────────────────────────────────────
    if (commandName === "schedule") {
      await interaction.deferReply();
      const typeFilter   = interaction.options.getString("type") || "all";
      const [liveMatches, liveScrims] = await Promise.all([apiGet("matches"), apiGet("scrims")]);
      let events = [
        ...liveMatches.map(m => ({ ...m, type: m.type || "match" })),
        ...liveScrims.map(s => ({ ...s, type: "scrim" })),
        ...scheduleList,
      ];
      if (typeFilter !== "all") events = events.filter(e => (e.type || "").toLowerCase() === typeFilter.toLowerCase());
      if (events.length === 0) {
        await interaction.editReply("📅 No upcoming events scheduled" + (typeFilter !== "all" ? " of type: " + typeFilter : "") + ".\nManagers can add events with `/add-schedule`.");
        return;
      }
      const typeIcon = { match: "🏆", friendly: "⚽", scrim: "⚔️", practice: "🏋️" };
      const embed = pjaEmbed("📅 PJA Schedule" + (typeFilter !== "all" ? " — " + typeFilter.toUpperCase() : ""))
        .setDescription(events.slice(0, 15).map(e =>
          (typeIcon[(e.type || "").toLowerCase()] || "📌") + " **" + (e.opponent || e.name || e.title || "TBD") +
          "** | " + (e.date || "TBD") + " @ " + (e.time || "TBD") +
          (e.notes && e.notes !== "None" ? " | " + e.notes : "")
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
      const eventType = interaction.options.getString("type");
      const event = {
        id:       makeId(),
        type:     eventType,
        opponent: interaction.options.getString("opponent"),
        date:     interaction.options.getString("date"),
        time:     interaction.options.getString("time"),
        notes:    interaction.options.getString("notes") || "None",
      };
      scheduleList.push(event);

      // Also post RSVP embed to channel for matches/scrims/friendlies
      if (["Match", "Friendly", "Scrim"].includes(eventType)) {
        try {
          const id = makeId();
          const matchData = {
            opponent: event.opponent,
            date:     event.date,
            time:     event.time,
            notes:    event.notes,
            type:     eventType,
            going:    new Set(),
            maybe:    new Set(),
            cantGo:   new Set(),
            responses: new Map(),
          };
          friendlies.set(id, matchData);
          const embed   = buildMatchRsvpEmbed(matchData);
          const buttons = buildRsvpButtons(id);
          await interaction.channel.send({ embeds: [embed], components: [buttons] });
        } catch(e) { console.error("Could not post RSVP embed:", e.message); }
      }

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
      const sessionLog  = attendanceLogs.get(session);
      const statusIcon  = { Present: "✅", Late: "🕐", Absent: "❌", Excused: "🟡" };
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
        const lineupData = { id, formation: formation || "TBD", players: players || "TBD", bench: bench || "None", notes: notes || "None", setBy: user.tag, date: new Date().toISOString() };
        lineups.set(id, lineupData);
        try {
          await apiPost("lineups", { id, name: id, formation: formation || "TBD", positions: "[]", notes: notes || "None", source: "discord" });
        } catch (e) {}
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
      let lineup = lineups.get(id);
      if (!lineup) {
        const liveLineups = await apiGet("lineups");
        const found = liveLineups.find(l => l.name === id || l.id === id);
        if (found) lineup = { formation: found.formation || "TBD", players: found.players || "TBD", bench: found.bench || "None", notes: found.notes || "None", setBy: found.setBy || "Manager" };
      }
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
        .setFooter({ text: "Set by " + (lineup.setBy || "Manager") + " | Project Azure (PJA)" });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /chemistry ─────────────────────────────────────────
    if (commandName === "chemistry") {
      await interaction.deferReply();
      const p1 = interaction.options.getString("player1");
      const p2 = interaction.options.getString("player2");
      const liveStats = await apiGet("stats");
      const s1 = liveStats.find(s => (s.player || s.name || s.ign || "").toLowerCase() === p1.toLowerCase());
      const s2 = liveStats.find(s => (s.player || s.name || s.ign || "").toLowerCase() === p2.toLowerCase());
      let score = 0, reasons = [];
      if (s1 && s2) {
        if ((s1.matches || 0) > 0 && (s2.matches || 0) > 0) { score += 30; reasons.push("Both have match experience"); }
        if ((s1.motms || 0) > 0  && (s2.motms || 0) > 0)   { score += 20; reasons.push("Both have MOTM awards"); }
        if ((s1.goals || 0) > 0  && (s2.assists || 0) > 0)  { score += 25; reasons.push(p1 + " scores, " + p2 + " assists"); }
        if ((s2.goals || 0) > 0  && (s1.assists || 0) > 0)  { score += 25; reasons.push(p2 + " scores, " + p1 + " assists"); }
        score = Math.min(score, 100);
      } else {
        score = Math.floor(Math.random() * 40) + 40;
        reasons.push("No shared match data — estimated score");
      }
      const bar   = "█".repeat(Math.floor(score / 10)) + "░".repeat(10 - Math.floor(score / 10));
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
      const player    = interaction.options.getString("player");
      const liveStats = await apiGet("stats");
      if (liveStats.length < 2) {
        await interaction.editReply("📊 Not enough player data yet. Stats build up after match reports.");
        return;
      }
      const playerStats = liveStats.find(s => (s.player || s.name || s.ign || "").toLowerCase() === player.toLowerCase());
      let bestPartner = null, bestScore = -1;
      for (const s of liveStats) {
        const ign = s.player || s.name || s.ign || "Unknown";
        if (ign.toLowerCase() === player.toLowerCase()) continue;
        let score = 0;
        if (playerStats) {
          if ((playerStats.goals || 0) > 0 && (s.assists || 0) > 0) score += 30;
          if ((playerStats.assists || 0) > 0 && (s.goals || 0) > 0) score += 30;
          if ((s.motms || 0) > 0) score += 20;
          if ((s.matches || 0) > 0) score += 20;
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
      if (!isAdmin(member)) {
        await interaction.editReply("❌ This command is for Managers only.");
        return;
      }
      const player   = interaction.options.getString("player");
      const role     = interaction.options.getString("role");
      const position = interaction.options.getString("position");
      const notes    = interaction.options.getString("notes") || "Welcome to the squad!";
      const id       = makeId();
      contracts.push({ id, player, role, position, notes, signedBy: user.tag, date: new Date().toISOString() });
      const embed = pjaEmbed("📝 New Signing — " + player, 0x22c55e)
        .setDescription("🎉 **Project Azure** is delighted to announce the signing of **" + player + "**!")
        .addFields(
          { name: "👤 Player",   value: player,   inline: true },
          { name: "🎽 Role",     value: role,     inline: true },
          { name: "📍 Position", value: position, inline: true },
          { name: "📝 Message",  value: notes },
        )
        .setFooter({ text: "Signed by " + user.tag + " | Project Azure (PJA)" });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /best-lineup ───────────────────────────────────────
    if (commandName === "best-lineup") {
      await interaction.deferReply();
      const formation = interaction.options.getString("formation") || "4-3-3";
      const [liveRoster, liveStats] = await Promise.all([apiGet("roster"), apiGet("stats")]);
      if (liveRoster.length === 0) {
        await interaction.editReply("📋 The roster is empty. No lineup can be suggested.");
        return;
      }
      const sorted = [...liveRoster].sort((a, b) => {
        const na = a.name || a.ign || "";
        const nb = b.name || b.ign || "";
        const sa = liveStats.find(s => (s.player || s.name || s.ign || "").toLowerCase() === na.toLowerCase());
        const sb = liveStats.find(s => (s.player || s.name || s.ign || "").toLowerCase() === nb.toLowerCase());
        const scoreA = sa ? (Number(sa.goals)||0) + (Number(sa.assists)||0) + (Number(sa.saves)||0) + (Number(sa.motms)||0)*2 : 0;
        const scoreB = sb ? (Number(sb.goals)||0) + (Number(sb.assists)||0) + (Number(sb.saves)||0) + (Number(sb.motms)||0)*2 : 0;
        return scoreB - scoreA;
      });
      const starters = sorted.slice(0, 11);
      const bench    = sorted.slice(11, 16);
      const embed = pjaEmbed("📋 Suggested Best Lineup — " + formation, 0x2563eb)
        .addFields(
          { name: "🗂️ Formation",  value: formation, inline: true },
          { name: "👥 Starting XI", value: starters.map((p, i) => (i + 1) + ". **" + (p.name || p.ign || "Unknown") + "** — " + (p.position || "?")).join("\n") },
          { name: "🪑 Bench",       value: bench.length > 0 ? bench.map(p => "• " + (p.name || p.ign || "Unknown") + " — " + (p.position || "?")).join("\n") : "None" },
        )
        .setFooter({ text: "Based on website stats | Project Azure (PJA)" });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /timezone-check ────────────────────────────────────
    if (commandName === "timezone-check") {
      await interaction.deferReply();
      const timeStr   = interaction.options.getString("time");
      const fromTz    = interaction.options.getString("from").toUpperCase();
      const dateStr   = interaction.options.getString("date") || new Date().toDateString();
      const offsets   = {
        "GMT":0,"UTC":0,"BST":1,"CET":1,"CEST":2,"EET":2,"EEST":3,
        "MSK":3,"GST":4,"PKT":5,"IST":5.5,"WIB":7,"CST":8,"JST":9,
        "AEST":10,"AEDT":11,"NZST":12,"EST":-5,"EDT":-4,
        "CDT":-5,"MST":-7,"MDT":-6,"PST":-8,"PDT":-7,
      };
      const fromOffset = offsets[fromTz];
      if (fromOffset === undefined) {
        await interaction.editReply("❌ Unknown timezone: **" + fromTz + "**\nSupported: GMT, UTC, BST, CET, EST, PST, IST, JST, AEST and more.");
        return;
      }
      const hourMatch = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
      if (!hourMatch) {
        await interaction.editReply("❌ Could not parse time: **" + timeStr + "**\nTry formats like `7pm`, `19:00`, `7:30pm`");
        return;
      }
      let hours = parseInt(hourMatch[1]);
      const mins  = parseInt(hourMatch[2] || "0");
      const ampm  = hourMatch[3];
      if (ampm) {
        if (ampm.toLowerCase() === "pm" && hours !== 12) hours += 12;
        if (ampm.toLowerCase() === "am" && hours === 12) hours = 0;
      }
      const baseDate    = new Date(dateStr + " " + hours + ":" + (mins < 10 ? "0" : "") + mins + ":00 UTC");
      const adjustedMs  = baseDate.getTime() - (fromOffset * 3600000);
      const unixSeconds = Math.floor(adjustedMs / 1000);
      const showZones   = ["GMT","BST","CET","EST","PST","IST","JST","AEST"];
      const conversions = showZones.map(tz => {
        const off = offsets[tz];
        if (off === undefined) return null;
        const d = new Date(adjustedMs + (off * 3600000));
        const h = d.getUTCHours(), m = d.getUTCMinutes();
        const ap = h >= 12 ? "pm" : "am";
        const h12 = h % 12 || 12;
        return "**" + tz + ":** " + h12 + ":" + (m < 10 ? "0" : "") + m + ap;
      }).filter(Boolean);
      const embed = pjaEmbed("🌍 Timezone Converter", 0x2563eb)
        .setDescription("**" + timeStr + " " + fromTz + "** on " + dateStr)
        .addFields(
          { name: "🕐 Conversions",       value: conversions.join("\n") },
          { name: "⏰ Discord Timestamp", value: "<t:" + unixSeconds + ":F> — `<t:" + unixSeconds + ":F>`" },
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /remind-team ───────────────────────────────────────
    if (commandName === "remind-team") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) {
        await interaction.editReply("❌ This command is for Managers only.");
        return;
      }
      const message   = interaction.options.getString("message");
      const inStr     = interaction.options.getString("in");
      const repeatStr = interaction.options.getString("repeat");
      const timeUnits = { m: 60000, h: 3600000, d: 86400000 };
      const inMatch   = inStr.match(/^(\d+)(m|h|d)$/i);
      if (!inMatch) {
        await interaction.editReply("❌ Invalid time format: **" + inStr + "**\nUse formats like `30m`, `2h`, `1d`");
        return;
      }
      const inMs = parseInt(inMatch[1]) * (timeUnits[inMatch[2].toLowerCase()] || 60000);
      let repeatMs = null;
      if (repeatStr) {
        const repMatch = repeatStr.match(/^(\d+)(m|h|d)$/i);
        if (repMatch) repeatMs = parseInt(repMatch[1]) * (timeUnits[repMatch[2].toLowerCase()] || 60000);
      }
      const reminderId  = makeId();
      const triggerAt   = Date.now() + inMs;
      const channelId   = interaction.channelId;
      reminders.set(reminderId, { message, channelId, triggerAt, repeatMs, userId: user.id });
      const unixSeconds = Math.floor(triggerAt / 1000);
      await interaction.editReply("⏰ Reminder set!\n**Message:** " + message + "\n**Fires at:** <t:" + unixSeconds + ":F>" + (repeatMs ? "\n**Repeats every:** " + inStr : "") + "\n**ID:** " + reminderId);
      return;
    }

    // ════════════════════════════════════════════════════════
    // ── NEW COMMANDS ─────────────────────────────────────────
    // ════════════════════════════════════════════════════════

    // ── /profile ───────────────────────────────────────────
    if (commandName === "profile") {
      await interaction.deferReply();
      const ign        = interaction.options.getString("ign");
      const [liveRoster, liveStats, liveAwards] = await Promise.all([
        apiGet("roster"), apiGet("stats"), apiGet("awards"),
      ]);

      const player = liveRoster.find(p => (p.name || p.ign || "").toLowerCase() === ign.toLowerCase());
      const stats  = liveStats.find(s => (s.player || s.name || s.ign || "").toLowerCase() === ign.toLowerCase());

      // Also check local awards
      const localAwards  = playerAwards.get(ign.toLowerCase()) || [];
      const remoteAwards = (liveAwards || []).filter(a => (a.player || "").toLowerCase() === ign.toLowerCase());
      const allAwards    = [...localAwards, ...remoteAwards];

      if (!player) {
        await interaction.editReply("❌ Player **" + ign + "** not found on the roster. Make sure the IGN is exact.");
        return;
      }

      const roleEmoji = { Captain: "👑", "Co-Captain": "🥈", Starter: "🔵", Backup: "🟡", Trialist: "🔬", Academy: "🎓" };
      const embed = pjaEmbed("🪪 Player Profile — " + (player.name || player.ign), 0x2563eb)
        .addFields(
          { name: "🎮 VRFS Name",       value: player.name || player.ign || "—",  inline: true },
          { name: "📍 Position",         value: player.position || "—",             inline: true },
          { name: "🔄 Backup Position",  value: player.backup || "—",              inline: true },
          { name: (roleEmoji[player.role] || "🎽") + " Role", value: player.role || "—", inline: true },
          { name: "🏆 Team Priority",    value: player.teamMain || "—",            inline: true },
          { name: "🌍 Timezone",         value: player.timezone || "—",            inline: true },
          { name: "📊 Stats",
            value: stats
              ? `⚽ Goals: **${stats.goals||0}** | 🎯 Assists: **${stats.assists||0}** | 🧤 Saves: **${stats.saves||0}** | 🏆 MOTMs: **${stats.motms||0}** | 🎮 Matches: **${stats.matches||0}**`
              : "No stats recorded yet",
            inline: false },
          { name: "🏅 Awards (" + allAwards.length + ")",
            value: allAwards.length > 0
              ? allAwards.slice(0, 5).map(a => "🏅 **" + (a.award || a.name) + "** — " + (a.reason || "")).join("\n")
              : "No awards yet",
            inline: false },
          { name: "📝 Bio", value: player.bio || "No bio set.", inline: false },
        )
        .setFooter({ text: "Project Azure (PJA) — " + (player.role || "Player") });

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /id-card ───────────────────────────────────────────
    if (commandName === "id-card") {
      await interaction.deferReply();
      const ign = interaction.options.getString("ign");
      const [liveRoster, liveStats, liveAwards] = await Promise.all([
        apiGet("roster"), apiGet("stats"), apiGet("awards"),
      ]);

      const player = liveRoster.find(p => (p.name || p.ign || "").toLowerCase() === ign.toLowerCase());
      if (!player) {
        await interaction.editReply("❌ Player **" + ign + "** not found on the roster.");
        return;
      }
      const stats = liveStats.find(s => (s.player || s.name || s.ign || "").toLowerCase() === ign.toLowerCase());
      const awards = [...(playerAwards.get(ign.toLowerCase()) || []),
                      ...(liveAwards || []).filter(a => (a.player || "").toLowerCase() === ign.toLowerCase())];

      const roleColors = { Captain: 0xf59e0b, "Co-Captain": 0xa78bfa, Starter: 0x2563eb, Backup: 0x6b7280, Trialist: 0x22c55e, Academy: 0x60a5fa };
      const cardColor  = roleColors[player.role] || 0x2563eb;
      const roleEmoji  = { Captain: "👑", "Co-Captain": "🥈", Starter: "⭐", Backup: "🔵", Trialist: "🔬", Academy: "🎓" };

      const embed = new EmbedBuilder()
        .setTitle("🆔  PROJECT AZURE — PLAYER CARD")
        .setColor(cardColor)
        .setDescription(
          "```\n" +
          "╔══════════════════════════════╗\n" +
          "║  " + "PJA".padEnd(28) + "║\n" +
          "║  " + (player.name || player.ign || "Unknown").substring(0,28).padEnd(28) + "║\n" +
          "║  " + ((roleEmoji[player.role] || "") + " " + (player.role || "Player")).substring(0,28).padEnd(28) + "║\n" +
          "╚══════════════════════════════╝\n" +
          "```"
        )
        .addFields(
          { name: "📍 Position",      value: (player.position || "—") + (player.backup ? " / " + player.backup : ""), inline: true },
          { name: "🏆 Priority",      value: player.teamMain || "—",  inline: true },
          { name: "🌍 Timezone",      value: player.timezone || "—",  inline: true },
          { name: "📊 Career Stats",
            value: stats
              ? `⚽ **${stats.goals||0}** G  |  🎯 **${stats.assists||0}** A  |  🧤 **${stats.saves||0}** S  |  🏆 **${stats.motms||0}** MOTM  |  🎮 **${stats.matches||0}** Matches`
              : "No stats yet",
            inline: false },
          { name: "🏅 Awards",        value: awards.length + " award(s) earned",  inline: true },
          { name: "📅 Joined",        value: player.joinedDate || player.created_at ? new Date(player.created_at || player.joinedDate).toDateString() : "Unknown", inline: true },
        )
        .setFooter({ text: "Project Azure (PJA) Official Player Card" })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /request ───────────────────────────────────────────
    if (commandName === "request") {
      await interaction.deferReply({ ephemeral: true });
      const reqType = interaction.options.getString("type");
      const details = interaction.options.getString("details");
      const ign     = interaction.options.getString("ign") || user.username;
      const reqId   = makeId();

      const req = {
        id:        reqId,
        userId:    user.id,
        username:  user.tag,
        ign,
        type:      reqType,
        details,
        status:    "pending",
        createdAt: new Date().toISOString(),
      };
      playerRequests.set(reqId, req);

      // Post to channel for managers to see
      const embed = pjaEmbed("📩 Player Request — " + reqType, 0xf59e0b)
        .addFields(
          { name: "👤 From",      value: "<@" + user.id + "> (" + ign + ")", inline: true },
          { name: "📋 Type",      value: reqType,                              inline: true },
          { name: "🆔 Request ID", value: reqId,                              inline: true },
          { name: "📝 Details",   value: details,                             inline: false },
          { name: "🕐 Status",    value: "⏳ Pending Manager Review",         inline: false },
        )
        .setFooter({ text: "Player Request System | Project Azure (PJA)" });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("req_accept_"  + reqId).setLabel("✅ Accept")          .setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("req_deny_"    + reqId).setLabel("❌ Deny")             .setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("req_moreinfo_"+ reqId).setLabel("❓ Needs More Info")  .setStyle(ButtonStyle.Secondary),
      );

      await interaction.channel.send({ embeds: [embed], components: [row] });
      await interaction.editReply("✅ Your **" + reqType + "** request has been sent to the managers!\n**Request ID:** " + reqId + "\nYou will be notified when they respond.");
      return;
    }

    // ── /trial-review ──────────────────────────────────────
    if (commandName === "trial-review") {
      await interaction.deferReply();
      if (!isAdmin(member)) {
        await interaction.editReply("❌ This command is for Managers only.");
        return;
      }
      const trialPlayer   = interaction.options.getString("player");
      const mechanics     = interaction.options.getInteger("mechanics");
      const positioning   = interaction.options.getInteger("positioning");
      const communication = interaction.options.getInteger("communication");
      const teamwork      = interaction.options.getInteger("teamwork");
      const consistency   = interaction.options.getInteger("consistency");
      const gamesense     = interaction.options.getInteger("gamesense");
      const notes         = interaction.options.getString("notes") || "None";

      const avg = ((mechanics + positioning + communication + teamwork + consistency + gamesense) / 6).toFixed(1);
      const avgNum = parseFloat(avg);

      let recommendation, recColor, recEmoji;
      if      (avgNum >= 8)   { recommendation = "Accept";            recColor = 0x22c55e; recEmoji = "✅"; }
      else if (avgNum >= 6.5) { recommendation = "Trial Longer";      recColor = 0x2563eb; recEmoji = "🔵"; }
      else if (avgNum >= 5)   { recommendation = "Needs More Clips";  recColor = 0xf59e0b; recEmoji = "🎬"; }
      else                    { recommendation = "Deny";              recColor = 0xef4444; recEmoji = "❌"; }

      const scoreBar = (score) => "█".repeat(score) + "░".repeat(10 - score);

      const embed = pjaEmbed("🔬 Trial Review — " + trialPlayer, recColor)
        .addFields(
          { name: "⚙️ Mechanics",      value: mechanics     + "/10  `" + scoreBar(mechanics)     + "`", inline: false },
          { name: "📍 Positioning",    value: positioning   + "/10  `" + scoreBar(positioning)   + "`", inline: false },
          { name: "🗣️ Communication", value: communication  + "/10  `" + scoreBar(communication) + "`", inline: false },
          { name: "🤝 Teamwork",       value: teamwork      + "/10  `" + scoreBar(teamwork)      + "`", inline: false },
          { name: "🎯 Consistency",    value: consistency   + "/10  `" + scoreBar(consistency)   + "`", inline: false },
          { name: "🧠 Game Sense",     value: gamesense     + "/10  `" + scoreBar(gamesense)     + "`", inline: false },
          { name: "📊 Average Score",  value: "**" + avg + "/10**",                                      inline: true },
          { name: recEmoji + " Recommendation", value: "**" + recommendation + "**",                     inline: true },
          { name: "📝 Notes",          value: notes,                                                      inline: false },
        )
        .setFooter({ text: "Trial Review by " + user.tag + " | Project Azure (PJA)" });

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /award-give ────────────────────────────────────────
    if (commandName === "award-give") {
      await interaction.deferReply();
      if (!isAdmin(member)) {
        await interaction.editReply("❌ This command is for Managers only.");
        return;
      }
      const awardPlayer = interaction.options.getString("player");
      const awardName   = interaction.options.getString("award");
      const reason      = interaction.options.getString("reason");
      const awardId     = makeId();
      const awardData   = {
        id:       awardId,
        player:   awardPlayer,
        award:    awardName,
        reason,
        givenBy:  user.tag,
        date:     new Date().toISOString(),
      };

      // Store locally
      const key = awardPlayer.toLowerCase();
      if (!playerAwards.has(key)) playerAwards.set(key, []);
      playerAwards.get(key).push(awardData);

      // Save to website
      try { await apiPost("awards", awardData); } catch(e) {}

      const embed = pjaEmbed("🏅 Award Presented — " + awardName, 0xf59e0b)
        .setDescription("🎉 **" + awardPlayer + "** has been awarded the **" + awardName + "**!")
        .addFields(
          { name: "👤 Player",   value: awardPlayer,      inline: true },
          { name: "🏅 Award",    value: awardName,        inline: true },
          { name: "📅 Date",     value: new Date().toDateString(), inline: true },
          { name: "📝 Reason",   value: reason,           inline: false },
          { name: "🎙️ Given by", value: user.tag,         inline: true },
        )
        .setFooter({ text: "Award System | Project Azure (PJA)" });

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /awards ────────────────────────────────────────────
    if (commandName === "awards") {
      await interaction.deferReply();
      const awardPlayer  = interaction.options.getString("player");
      const liveAwards   = await apiGet("awards");
      const localAwards  = playerAwards.get(awardPlayer.toLowerCase()) || [];
      const remoteAwards = (liveAwards || []).filter(a => (a.player || "").toLowerCase() === awardPlayer.toLowerCase());
      const allAwards    = [...localAwards];
      // Merge remote, avoid duplicates by id
      remoteAwards.forEach(ra => {
        if (!allAwards.find(la => la.id === ra.id)) allAwards.push(ra);
      });

      if (allAwards.length === 0) {
        await interaction.editReply("🏅 **" + awardPlayer + "** has no awards yet.");
        return;
      }

      const embed = pjaEmbed("🏅 Awards — " + awardPlayer, 0xf59e0b)
        .setDescription(allAwards.map((a, i) =>
          (i + 1) + ". 🏅 **" + (a.award || a.name || "Award") + "**\n" +
          "   📝 " + (a.reason || "—") + "\n" +
          "   📅 " + (a.date ? new Date(a.date).toDateString() : "Unknown")
        ).join("\n\n"))
        .addFields({ name: "📊 Total Awards", value: allAwards.length + " award(s)", inline: true })
        .setFooter({ text: "Award History | Project Azure (PJA)" });

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /activity-check ────────────────────────────────────
    if (commandName === "activity-check") {
      await interaction.deferReply();
      if (!isCaptain(member)) {
        await interaction.editReply("❌ This command is for Managers and Captains only.");
        return;
      }
      const message  = interaction.options.getString("message") || "Check in to confirm you are active this week!";
      const deadline = interaction.options.getString("deadline") || "No deadline set";
      const checkId  = makeId();

      const checkData = {
        id:       checkId,
        message,
        deadline,
        active:   new Set(),
        postedBy: user.tag,
      };
      activityChecks.set(checkId, checkData);

      const embed = buildActivityEmbed(checkData);
      const row   = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("activity_confirm_" + checkId)
          .setLabel("✅ I'm Active!")
          .setStyle(ButtonStyle.Success),
      );

      await interaction.editReply({ embeds: [embed], components: [row] });
      return;
    }

    // ── /team-vote ─────────────────────────────────────────
    if (commandName === "team-vote") {
      await interaction.deferReply();
      if (!isCaptain(member)) {
        await interaction.editReply("❌ This command is for Managers and Captains only.");
        return;
      }
      const question = interaction.options.getString("question");
      const opt1     = interaction.options.getString("option1");
      const opt2     = interaction.options.getString("option2");
      const opt3     = interaction.options.getString("option3");
      const opt4     = interaction.options.getString("option4");
      const voteId   = makeId();

      const options = [
        { label: opt1, voters: new Set() },
        { label: opt2, voters: new Set() },
        ...(opt3 ? [{ label: opt3, voters: new Set() }] : []),
        ...(opt4 ? [{ label: opt4, voters: new Set() }] : []),
      ];

      const voteData = { id: voteId, question, options, userVotes: new Map(), postedBy: user.tag };
      teamVotes.set(voteId, voteData);

      const embed = buildVoteEmbed(voteData);
      const row   = new ActionRowBuilder().addComponents(
        options.map((opt, i) =>
          new ButtonBuilder()
            .setCustomId("vote_" + voteId + "_" + i)
            .setLabel(opt.label.substring(0, 80))
            .setStyle(ButtonStyle.Primary)
        )
      );

      await interaction.editReply({ embeds: [embed], components: [row] });
      return;
    }

    // ── /giveaway ──────────────────────────────────────────
    if (commandName === "giveaway") {
      await interaction.deferReply();
      if (!isAdmin(member)) {
        await interaction.editReply("❌ This command is for Managers only.");
        return;
      }
      const prize        = interaction.options.getString("prize");
      const durationStr  = interaction.options.getString("duration");
      const winnersCount = interaction.options.getInteger("winners");
      const requirements = interaction.options.getString("requirements") || null;
      const notes        = interaction.options.getString("notes") || null;

      const timeUnits = { m: 60000, h: 3600000, d: 86400000 };
      const durMatch  = durationStr.match(/^(\d+)(m|h|d)$/i);
      if (!durMatch) {
        await interaction.editReply("❌ Invalid duration format: **" + durationStr + "**\nUse formats like `30m`, `2h`, `1d`, `7d`");
        return;
      }
      const durationMs = parseInt(durMatch[1]) * (timeUnits[durMatch[2].toLowerCase()] || 3600000);
      const endsAt     = Date.now() + durationMs;
      const giveId     = makeId();

      const giveData = {
        id:           giveId,
        prize,
        winnersCount,
        requirements,
        notes,
        hostedBy:     user.tag,
        endsAt,
        entries:      new Set(),
        ended:        false,
        channelId:    interaction.channelId,
        messageId:    null,
      };
      giveaways.set(giveId, giveData);

      const embed   = buildGiveawayEmbed(giveData);
      const buttons = buildGiveawayButton(giveId, false);
      const msg     = await interaction.editReply({ embeds: [embed], components: [buttons] });
      giveData.messageId = msg?.id || null;

      // Auto-end timer
      setTimeout(async () => {
        const give = giveaways.get(giveId);
        if (!give || give.ended) return;
        give.ended = true;
        await endGiveaway(give, interaction.channel);
      }, durationMs);

      return;
    }

    // ── /giveaway-end ──────────────────────────────────────
    if (commandName === "giveaway-end") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) {
        await interaction.editReply("❌ This command is for Managers only.");
        return;
      }
      const giveId = interaction.options.getString("id").toUpperCase();
      const give   = giveaways.get(giveId);
      if (!give) {
        await interaction.editReply("❌ Giveaway **" + giveId + "** not found.");
        return;
      }
      if (give.ended) {
        await interaction.editReply("⚠️ Giveaway **" + giveId + "** has already ended.");
        return;
      }
      give.ended = true;
      const channel = await client.channels.fetch(give.channelId).catch(() => null);
      await endGiveaway(give, channel);
      await interaction.editReply("✅ Giveaway **" + giveId + "** ended!");
      return;
    }

    // ── /giveaway-reroll ───────────────────────────────────
    if (commandName === "giveaway-reroll") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) {
        await interaction.editReply("❌ This command is for Managers only.");
        return;
      }
      const giveId = interaction.options.getString("id").toUpperCase();
      const give   = giveaways.get(giveId);
      if (!give) {
        await interaction.editReply("❌ Giveaway **" + giveId + "** not found.");
        return;
      }
      if (!give.ended) {
        await interaction.editReply("⚠️ The giveaway is still active! End it first with `/giveaway-end`.");
        return;
      }
      if (give.entries.size === 0) {
        await interaction.editReply("❌ No entries to reroll from.");
        return;
      }
      const newWinners = pickWinners(give.entries, give.winnersCount);
      const channel = await client.channels.fetch(give.channelId).catch(() => null);
      if (channel) {
        const rerollEmbed = pjaEmbed("🎲 Giveaway Reroll — " + give.prize, 0x2563eb)
          .setDescription("🎉 New winner(s) have been selected!\n\n" + newWinners.map(w => "🏆 <@" + w + ">").join("\n"))
          .addFields({ name: "🎁 Prize", value: give.prize, inline: true })
          .setFooter({ text: "Giveaway ID: " + giveId + " | Project Azure (PJA)" });
        await channel.send({ embeds: [rerollEmbed] });
      }
      await interaction.editReply("✅ Rerolled! New winner(s): " + newWinners.map(w => "<@" + w + ">").join(", "));
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

// ── GIVEAWAY END HELPER ───────────────────────────────────────
async function endGiveaway(give, channel) {
  try {
    if (!channel) return;

    const entries = give.entries;
    let winnersStr;

    if (entries.size === 0) {
      winnersStr = "😔 No one entered the giveaway.";
    } else if (entries.size < give.winnersCount) {
      const allWinners = [...entries];
      winnersStr = "🏆 " + allWinners.map(w => "<@" + w + ">").join(", ") + " (only " + allWinners.length + " entered)";
    } else {
      const winners = pickWinners(entries, give.winnersCount);
      winnersStr = winners.map(w => "🏆 <@" + w + ">").join("\n");
    }

    const endEmbed = pjaEmbed("🎉 Giveaway Ended — " + give.prize, 0x22c55e)
      .setDescription("The giveaway has ended!\n\n" + winnersStr)
      .addFields(
        { name: "🎁 Prize",      value: give.prize,                      inline: true },
        { name: "👥 Entries",    value: give.entries.size + " total",    inline: true },
        { name: "🏆 Winners",    value: give.winnersCount + " selected", inline: true },
        { name: "🎙️ Hosted by", value: give.hostedBy,                   inline: true },
      )
      .setFooter({ text: "Giveaway ID: " + give.id + " | Project Azure (PJA)" });

    await channel.send({ embeds: [endEmbed] });

    // Update original message to disable button
    if (give.messageId) {
      try {
        const origMsg = await channel.messages.fetch(give.messageId).catch(() => null);
        if (origMsg) {
          const updatedEmbed = buildGiveawayEmbed(give);
          const disabledBtn  = buildGiveawayButton(give.id, true);
          await origMsg.edit({ embeds: [updatedEmbed], components: [disabledBtn] });
        }
      } catch(e) { console.error("Could not update giveaway message:", e.message); }
    }
  } catch (e) {
    console.error("endGiveaway error:", e.message);
  }
}

// ── BUTTON HANDLER ────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  try {
    const { customId, user, member } = interaction;
    const parts = customId.split("_");

    // ── RSVP buttons (going / maybe / cantgo) ─────────────
    if (parts[0] === "going" || parts[0] === "maybe" || parts[0] === "cantgo") {
      await interaction.deferUpdate();
      const action     = parts[0];
      const friendlyId = parts[1];
      const data       = friendlies.get(friendlyId);
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

      const isMatch = data.type && data.type !== "Friendly";
      const embed   = isMatch ? buildMatchRsvpEmbed(data) : buildFriendlyEmbed(data);
      await interaction.editReply({ embeds: [embed], components: [buildRsvpButtons(friendlyId)] });
      return;
    }

    // ── Application decision buttons ──────────────────────
    if (parts[0] === "app") {
      await interaction.deferUpdate();
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

    // ── Player request buttons ─────────────────────────────
    if (parts[0] === "req") {
      await interaction.deferUpdate();
      if (!isAdmin(member)) {
        await interaction.followUp({ content: "❌ You don't have permission to do this.", ephemeral: true });
        return;
      }
      const action = parts[1]; // accept / deny / moreinfo
      const reqId  = parts[2];
      const req    = playerRequests.get(reqId);
      if (!req) {
        await interaction.followUp({ content: "❌ Request not found.", ephemeral: true });
        return;
      }

      const statusMap  = { accept: "✅ Accepted", deny: "❌ Denied", moreinfo: "❓ Needs More Info" };
      const statusVal  = statusMap[action] || action;
      req.status = statusVal;

      // DM the requester
      try {
        const requester = await client.users.fetch(req.userId).catch(() => null);
        if (requester) {
          const dmMessages = {
            accept:   "✅ Your **" + req.type + "** request has been **accepted** by management!",
            deny:     "❌ Your **" + req.type + "** request has been **denied** by management.",
            moreinfo: "❓ Management needs **more information** about your **" + req.type + "** request. Please contact a manager.",
          };
          await requester.send({ embeds: [
            pjaEmbed("📩 Request Update — " + req.type, action === "accept" ? 0x22c55e : action === "deny" ? 0xef4444 : 0xf59e0b)
              .setDescription(dmMessages[action] || "Your request status has been updated.")
          ]});
        }
      } catch(e) {}

      await interaction.followUp({ content: "Request from **" + req.ign + "** marked as: " + statusVal, ephemeral: true });
      return;
    }

    // ── Activity check button ──────────────────────────────
    if (parts[0] === "activity" && parts[1] === "confirm") {
      await interaction.deferUpdate();
      const checkId = parts[2];
      const check   = activityChecks.get(checkId);
      if (!check) return;

      const name = member ? member.displayName : user.username;
      check.active.add(name);

      await interaction.editReply({ embeds: [buildActivityEmbed(check)], components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("activity_confirm_" + checkId)
            .setLabel("✅ I'm Active! (" + check.active.size + ")")
            .setStyle(ButtonStyle.Success)
        )
      ]});
      return;
    }

    // ── Team vote buttons ──────────────────────────────────
    if (parts[0] === "vote") {
      await interaction.deferUpdate();
      const voteId  = parts[1];
      const optIdx  = parseInt(parts[2]);
      const vote    = teamVotes.get(voteId);
      if (!vote) return;

      const name     = member ? member.displayName : user.username;
      const prevVote = vote.userVotes.get(user.id);

      // Remove previous vote
      if (prevVote !== undefined && vote.options[prevVote]) {
        vote.options[prevVote].voters.delete(name);
      }

      // Toggle — if same option clicked again, remove vote
      if (prevVote === optIdx) {
        vote.userVotes.delete(user.id);
      } else {
        vote.options[optIdx].voters.add(name);
        vote.userVotes.set(user.id, optIdx);
      }

      const row = new ActionRowBuilder().addComponents(
        vote.options.map((opt, i) =>
          new ButtonBuilder()
            .setCustomId("vote_" + voteId + "_" + i)
            .setLabel(opt.label.substring(0, 80))
            .setStyle(vote.userVotes.get(user.id) === i ? ButtonStyle.Success : ButtonStyle.Primary)
        )
      );

      await interaction.editReply({ embeds: [buildVoteEmbed(vote)], components: [row] });
      return;
    }

    // ── Giveaway enter button ──────────────────────────────
    if (parts[0] === "giveaway" && parts[1] === "enter") {
      await interaction.deferUpdate();
      const giveId = parts[2];
      const give   = giveaways.get(giveId);
      if (!give) return;

      if (give.ended) {
        await interaction.followUp({ content: "❌ This giveaway has ended!", ephemeral: true });
        return;
      }

      if (give.entries.has(user.id)) {
        // Already entered — toggle (remove)
        give.entries.delete(user.id);
        await interaction.followUp({ content: "👋 You have left the giveaway for **" + give.prize + "**.", ephemeral: true });
      } else {
        give.entries.add(user.id);
        await interaction.followUp({ content: "🎉 You have entered the giveaway for **" + give.prize + "**! Good luck!", ephemeral: true });
      }

      // Update embed with new entry count
      await interaction.editReply({ embeds: [buildGiveawayEmbed(give)], components: [buildGiveawayButton(giveId, false)] });
      return;
    }

  } catch (err) {
    console.error("Button handler error:", err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: "❌ Something went wrong.", ephemeral: true });
      }
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
      } catch (e) {
        console.error("Reminder error:", e.message);
        reminders.delete(id);
      }
    }
  }
}, 30000);

// ── CRASH PREVENTION ─────────────────────────────────────────
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});
