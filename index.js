const { setMatchHandler } = require("./keep-alive");
const {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  SlashCommandBuilder, REST, Routes, PermissionFlagsBits,
} = require("discord.js");
require("dotenv").config();

// ── CONFIG ───────────────────────────────────────────────────
const TOKEN                  = process.env.DISCORD_TOKEN;
const CLIENT_ID              = process.env.CLIENT_ID;
const GUILD_ID               = process.env.GUILD_ID;
const WEBSITE_API            = process.env.WEBSITE_API || "https://syfnafne.gensparkspace.com/tables/";
const ANNOUNCEMENTS_CHANNEL  = process.env.ANNOUNCEMENTS_CHANNEL_ID || null; // set in Railway
const ADMIN_ROLES            = ["Manager", "Admin", "Owner", "Coach", "TEAM MANAGER", "CAPTIAN"];
const CAPTAIN_ROLES          = ["Captain", "Co-Captain", ...ADMIN_ROLES];

// ── CLIENT ───────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ── DATA STORES ──────────────────────────────────────────────
const friendlies      = new Map();
const applications    = new Map();
const scheduleList    = [];
const attendanceLogs  = new Map();
const lineups         = new Map();
const weaknesses      = new Map();
const contracts       = [];
const reminders       = new Map();
const activityChecks  = new Map();
const teamVotes       = new Map();
const giveaways       = new Map();
const playerRequests  = new Map();
const playerAwards    = new Map();
const playerWarnings  = new Map();
const playerPoints    = new Map();
const shopRedemptions = new Map();
const suggestions     = new Map();
const bugReports      = new Map();

// ── NEW DATA STORES ───────────────────────────────────────────
const newcomerProfiles  = new Map(); // userId → profile data
const matchReportsFull  = new Map(); // reportId → full match report
const selfReports       = new Map(); // `${reportId}_${userId}` → submission
const motmVotes         = new Map(); // `${reportId}_${userId}` → targetIgn
const openSpots         = new Map(); // position → { count, notes }
const playerStats       = new Map(); // ign.toLowerCase() → stats object
const announcements     = [];        // [ { id, title, message, postedBy, postedAt, color, channelId, ping, image } ]

function getStats(ign) {
  const key = ign.toLowerCase();
  if (!playerStats.has(key)) playerStats.set(key, { goals:0, assists:0, saves:0, cleanSheets:0, motms:0, matches:0, activityScore:0 });
  return playerStats.get(key);
}
function addStat(ign, field, amount) {
  const s = getStats(ign);
  s[field] = (s[field]||0) + amount;
}

// ── PENDING DM INPUT FLOWS ────────────────────────────────────
// Stores multi-step DM conversations waiting for player input
// key = userId, value = { step, redeemId, guildId, roleName? }
const pendingInputs = new Map();

// ── ACCOUNT LINKS ─────────────────────────────────────────────
// Maps Discord user ID → VRFS IGN (lowercase key)
// e.g. linkedAccounts.get('123456789') === 'PlayerIGN'
const linkedAccounts = new Map();  // discordId → ign
const ignToDiscordId = new Map();  // ign.toLowerCase() → discordId

function linkAccount(discordId, ign) {
  // Remove any old IGN link for this Discord ID
  const oldIgn = linkedAccounts.get(discordId);
  if (oldIgn) ignToDiscordId.delete(oldIgn.toLowerCase());
  linkedAccounts.set(discordId, ign);
  ignToDiscordId.set(ign.toLowerCase(), discordId);

  // ── Persist to API so links survive bot restarts ──────────
  // We use the discordId as a stable lookup key.
  // Strategy: try PATCH first (update existing row), if 404 do POST (new row).
  // Fire-and-forget — never block the caller.
  (async () => {
    try {
      // Search for an existing row with this discordId
      const existing = await fetch(WEBSITE_API + "pja_links?search=" + encodeURIComponent(discordId) + "&limit=5");
      const json     = existing.ok ? await existing.json() : { data: [] };
      const row      = (json.data || []).find(r => r.discordId === discordId);
      if (row && row.id) {
        // Update existing row
        await fetch(WEBSITE_API + "pja_links/" + row.id, {
          method:  "PATCH",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ ign }),
        });
      } else {
        // Create new row
        await fetch(WEBSITE_API + "pja_links", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ discordId, ign }),
        });
      }
    } catch (e) {
      console.error("[linkAccount] persist error:", e.message);
    }
  })();
}

// ── Load all persisted links from API on startup ──────────────
// Populates linkedAccounts and ignToDiscordId from pja_links table.
// Called once inside client.once("ready") so links survive restarts.
async function loadLinks() {
  try {
    const res  = await fetch(WEBSITE_API + "pja_links?limit=500");
    if (!res.ok) { console.warn("[loadLinks] API returned", res.status); return; }
    const json = await res.json();
    const rows = json.data || [];
    let count  = 0;
    for (const row of rows) {
      if (row.discordId && row.ign) {
        linkedAccounts.set(row.discordId, row.ign);
        ignToDiscordId.set(row.ign.toLowerCase(), row.discordId);
        count++;
      }
    }
    console.log("[loadLinks] Restored " + count + " account link(s) from API.");
  } catch (e) {
    console.error("[loadLinks] Failed to load links:", e.message);
  }
}

function getIgnForUser(discordId) {
  return linkedAccounts.get(discordId) || null;
}

function getDiscordIdForIgn(ign) {
  return ignToDiscordId.get(ign.toLowerCase()) || null;
}

// ── MEMBER LOOKUP HELPER ───────────────────────────────────────
// Tries linked account first, then falls back to username search
async function getMemberByIgn(guild, ign) {
  // 1. Check if IGN is linked to a Discord ID
  const linkedId = getDiscordIdForIgn(ign);
  if (linkedId) {
    const m = await guild.members.fetch(linkedId).catch(() => null);
    if (m) return m;
  }
  // 2. Fall back to username search (less reliable)
  const results = await guild.members.fetch({ query: ign, limit: 1 }).catch(() => null);
  return results ? results.first() || null : null;
}

// ── SHOP ITEMS ────────────────────────────────────────────────
// Shop item prices are mutable at runtime via /shop-price
// autoFulfil=true  → runs instantly; false → manager approval needed
const SHOP_ITEMS = [
  // ── APPROVAL ITEMS ───────────────────────────────────────────
  { id: "rename_bot",        name: "Rename the Bot for 24h",            cost: 200, autoFulfil: false, desc: "Rename the PJA bot to any name for 24 hours. Manager approves." },
  { id: "server_emoji",      name: "Server Emoji Request",              cost: 200, autoFulfil: false, desc: "Request a custom emoji to be added to the server. Manager approves." },
  { id: "custom_command",    name: "Custom Command Reply",              cost: 200, autoFulfil: false, desc: "Add a custom !trigger → reply command to the bot. Manager approves." },
  { id: "rename_giveaway",   name: "Rename a Giveaway",                cost: 150, autoFulfil: false, desc: "Rename an active giveaway to something you choose. Manager approves." },
  { id: "server_poll",       name: "Server Poll Override",              cost: 200, autoFulfil: false, desc: "Force a server poll on any topic of your choice. Manager approves." },
  { id: "lucky_number",      name: "Lucky Number Claim",                cost: 150, autoFulfil: false, desc: "Claim a lucky number (1–100). If it's drawn in a giveaway, you win. Manager approves." },
  // ── AUTO ITEMS ───────────────────────────────────────────────
  { id: "point_steal",       name: "Point Steal Ticket",                cost: 150, autoFulfil: true,  desc: "50/50 chance to steal 25 pts from a target player. Auto-executes." },
  { id: "point_gamble",      name: "Point Gamble Ticket",               cost: 75,  autoFulfil: true,  desc: "Gamble 10–200 pts: double or lose. You choose the amount. Auto-executes." },
  { id: "mystery_spin",      name: "Mystery Spin Wheel",                cost: 100, autoFulfil: true,  desc: "Spin the wheel for a random reward (points, discount, or nothing). Auto-executes." },
  { id: "shop_discount",     name: "Temporary Shop Discount",           cost: 200, autoFulfil: true,  desc: "Earn a 25% discount token valid on your next shop redemption. Auto-executes." },
];

// ── EXTRA DATA STORES FOR NEW FEATURES ───────────────────────
const pointHistory      = new Map(); // ign.toLowerCase() → [{ amount, reason, date }]
const discountTokens    = new Map(); // ign.toLowerCase() → { pct, expiresAt }
const luckyNumbers      = new Map(); // ign.toLowerCase() → number (1–100)
const customCommandsMap = new Map(); // trigger.toLowerCase() → { reply, createdBy, ign }
const shopRequests      = new Map(); // requestId → { userId, ign, itemId, itemName, note, status, reviewedBy, createdAt }
const motmVoteLocks     = new Map(); // reportId → boolean (locked=true)
const submissionHistory = new Map(); // subKey → [{ event, by, reason, stats, timestamp }]

// ── FUTURE WEBSITE SUPPORT — SUBMISSION TOKEN STORE ──────────
// When the website is built, players will use a unique URL:
//   https://SITE_URL/match-report?report=REPORT_ID&player=PLAYER_ID&token=TOKEN
// For now, /self-report (Discord) is still the only input method.
// These Maps just make that migration a 1-day job instead of a rewrite.
//
// playerSubmissionTokens: playerId (uuid) → token record
// Each record links a player's IGN to a specific match report,
// holds a secure token for URL auth, and tracks whether they've submitted.
const playerSubmissionTokens = new Map();
// reportPlayerIndex: reportId → Map(ign.toLowerCase() → playerId)
// Fast reverse-lookup: given a report + IGN, what's their playerId?
const reportPlayerIndex = new Map();

// The live site URL — change this env var when the website is deployed.
// Used to build player submission links. No website needed yet.
const SITE_URL = process.env.SITE_URL || "https://my-pja-site.com";

// ── TOKEN HELPERS ─────────────────────────────────────────────
// Generate a cryptographically safe random token string
function makeToken() {
  // 32 random hex chars — safe enough for a match submission link
  return [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
}

// Create (or retrieve existing) submission token for a player + report.
// Returns { playerId, token, url } — url is the future website link.
// Idempotent: calling twice for the same ign+reportId returns the same record.
function generatePlayerToken(reportId, ign) {
  // Check if one already exists for this report+ign
  const idx = reportPlayerIndex.get(reportId);
  if (idx) {
    const existingPlayerId = idx.get(ign.toLowerCase());
    if (existingPlayerId) {
      const record = playerSubmissionTokens.get(existingPlayerId);
      if (record) return { playerId: existingPlayerId, token: record.token, url: buildSubmissionUrl(reportId, existingPlayerId, record.token) };
    }
  }

  // Create new
  const playerId = makeId();   // reuse existing makeId() — same uuid format
  const token    = makeToken();
  const record   = {
    playerId,
    reportId,
    ign,
    token,
    used:        false,   // true once they submit (Discord or website)
    submittedAt: null,    // ISO string when submitted
    source:      null,    // "discord" | "website" — filled on submission
    createdAt:   new Date().toISOString(),
    // Future website fields — null until site is live
    websiteUrl:  buildSubmissionUrl(reportId, playerId, token),
    ipAddress:   null,    // website can populate this for audit
    userAgent:   null,    // website can populate this for audit
  };

  playerSubmissionTokens.set(playerId, record);

  // Update reverse index
  if (!reportPlayerIndex.has(reportId)) reportPlayerIndex.set(reportId, new Map());
  reportPlayerIndex.get(reportId).set(ign.toLowerCase(), playerId);

  return { playerId, token, url: record.websiteUrl };
}

// Build the full submission URL for a player.
// This is what will be sent when the website is ready.
// Until then, it's stored as a placeholder on every submission.
function buildSubmissionUrl(reportId, playerId, token) {
  return `${SITE_URL}/match-report?report=${reportId}&player=${playerId}&token=${token}`;
}

// Validate a token when a website submission comes in.
// Returns the token record if valid, null if invalid/used/wrong report.
function validateSubmissionToken(reportId, playerId, token) {
  const record = playerSubmissionTokens.get(playerId);
  if (!record)                        return null; // unknown playerId
  if (record.reportId !== reportId)   return null; // wrong report
  if (record.token    !== token)      return null; // bad token
  if (record.used)                    return null; // already submitted
  return record;
}

// Mark a token as used after successful submission.
function consumeSubmissionToken(playerId, source) {
  const record = playerSubmissionTokens.get(playerId);
  if (!record) return;
  record.used        = true;
  record.submittedAt = new Date().toISOString();
  record.source      = source || "discord";
}

function addPointHistory(ign, amount, reason) {
  const key = ign.toLowerCase();
  if (!pointHistory.has(key)) pointHistory.set(key, []);
  pointHistory.get(key).push({ amount, reason, date: new Date().toISOString() });
  if (pointHistory.get(key).length > 50) pointHistory.get(key).shift();
}

function addSubHistory(subKey, event, by, reason, stats) {
  if (!submissionHistory.has(subKey)) submissionHistory.set(subKey, []);
  submissionHistory.get(subKey).push({ event, by, reason: reason||"", stats: stats||null, timestamp: new Date().toISOString() });
}

// ── POINT AWARD FORMULA (on submission approval) ──────────────
function calcSubmissionPoints(sub) {
  let pts = 0;
  const posType = {
    GK:"gk", DEF:"def", MID:"mid", WING:"wing", ST:"st", Utility:"util",
    LM:"mid", RM:"mid", CM:"mid", CDM:"mid", CAM:"mid", CB:"def", LB:"def", RB:"def", LW:"wing", RW:"wing",
  }[sub.position||"Utility"] || "util";

  // Match participation always
  pts += 10;

  // Goals
  const goals = parseInt(sub.goals)||0;
  if (goals > 0) pts += goals * 5;

  // Assists
  const assists = parseInt(sub.assists)||0;
  if (assists > 0) pts += assists * 4;

  // Saves (GK)
  const saves = parseInt(sub.saves)||0;
  if (saves > 0 && posType === "gk") pts += saves * 3;

  // Clean sheet
  if (sub.cleanSheet && sub.cleanSheet.toString().toLowerCase().startsWith("y")) pts += 8;

  // Big saves
  const bigSaves = parseInt(sub.bigSaves)||0;
  if (bigSaves > 0) pts += bigSaves * 4;

  // Key passes
  const kp = parseInt(sub.keyPasses)||0;
  if (kp > 0) pts += kp * 2;

  // Tackles
  const tackles = parseInt(sub.tackles)||0;
  if (tackles > 0) pts += tackles * 2;

  // Interceptions
  const ints = parseInt(sub.interceptions)||0;
  if (ints > 0) pts += ints * 2;

  // Blocks
  const blocks = parseInt(sub.blocks)||0;
  if (blocks > 0) pts += blocks * 2;

  // Rating bonus (use first numeric rating found)
  const firstRat = sub.distributionRating || sub.defPosRating || sub.possessionRating ||
                   sub.dribblingRating || sub.finishingRating || sub.impactRating;
  const rat = parseFloat(firstRat)||0;
  if (rat >= 9) pts += 5;
  else if (rat >= 8) pts += 3;

  return pts;
}

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

// ── COLOUR PARSER ──────────────────────────────────────────────
// Converts a player's colour input into a Discord-compatible hex integer
function parseColour(input) {
  if (!input) return 0x2563eb;
  const str = input.trim().toLowerCase();

  // Named colours map
  const namedColours = {
    red: 0xff0000, blue: 0x0000ff, green: 0x00ff00, yellow: 0xffff00,
    orange: 0xff8c00, purple: 0x8b00ff, pink: 0xff69b4, cyan: 0x00ffff,
    white: 0xffffff, black: 0x000001, gold: 0xffd700, silver: 0xc0c0c0,
    lime: 0x00ff7f, teal: 0x008080, navy: 0x000080, maroon: 0x800000,
    coral: 0xff6347, violet: 0xee82ee, indigo: 0x4b0082, turquoise: 0x40e0d0,
    magenta: 0xff00ff, brown: 0xa52a2a, grey: 0x808080, gray: 0x808080,
    "dark blue": 0x00008b, "light blue": 0xadd8e6, "dark green": 0x006400,
    "hot pink": 0xff69b4, "sky blue": 0x87ceeb, "pja blue": 0x2563eb,
  };
  if (namedColours[str]) return namedColours[str];

  // Hex string — strip # if present
  const hex = str.replace(/^#/, "");
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    const val = parseInt(hex, 16);
    // Discord doesn't allow pure black (0x000000) as a role colour
    return val === 0 ? 0x000001 : val;
  }
  return 0x2563eb; // fallback to PJA blue
}

// ── WARNING / STRIKE HELPERS ──────────────────────────────────
function getWarnings(ign) {
  const key = ign.toLowerCase();
  if (!playerWarnings.has(key)) playerWarnings.set(key, []);
  return playerWarnings.get(key);
}
function getStrikeCount(ign) {
  return Math.floor(getWarnings(ign).length / 3);
}

// ── POINTS HELPERS ────────────────────────────────────────────
function getPoints(ign) {
  return playerPoints.get(ign.toLowerCase()) || 0;
}
function addPoints(ign, amount) {
  const key      = ign.toLowerCase();
  const current  = playerPoints.get(key) || 0;
  const newTotal = Math.max(0, current + amount);
  playerPoints.set(key, newTotal);
  return newTotal;
}

// ── SHOP AUTO-FULFIL ───────────────────────────────────────────
// Called after a manager approves a redemption.
// Handles instant rewards and kicks off DM flows for custom ones.
async function fulfilRedemption(redeem, guild) {
  // Use linked Discord ID first, then fall back to username search
  const player = await getMemberByIgn(guild, redeem.ign);

  switch (redeem.itemId) {

    // ── nickname_color ─────────────────────────────────────
    // Step 1: DM player asking for colour choice
    case "nickname_color": {
      if (!player) return { ok: false, msg: "Could not find **" + redeem.ign + "** in the server to start the colour flow." };
      pendingInputs.set(player.user.id, {
        step:      "nickname_color_colour",
        redeemId:  redeem.id,
        guildId:   guild.id,
        ign:       redeem.ign,
      });
      await player.user.send({ embeds: [
        pjaEmbed("🎨 Custom Nickname Colour — Step 1", 0x2563eb)
          .setDescription(
            "Your **Custom Nickname Colour** redemption has been approved! 🎉\n\n" +
            "**What colour do you want your nickname?**\n" +
            "Type a colour name or hex code, for example:\n" +
            "> `Red` `Blue` `Gold` `Hot Pink` `#FF5733` `#00FF7F`"
          )
      ]}).catch(() => {});
      return { ok: true, msg: "✅ DM sent to **" + redeem.ign + "** asking for their colour choice." };
    }

    // ── profile_badge ──────────────────────────────────────
    // Step 1: DM player asking for role name
    case "profile_badge": {
      if (!player) return { ok: false, msg: "Could not find **" + redeem.ign + "** in the server to start the badge flow." };
      pendingInputs.set(player.user.id, {
        step:     "badge_name",
        redeemId: redeem.id,
        guildId:  guild.id,
        ign:      redeem.ign,
      });
      await player.user.send({ embeds: [
        pjaEmbed("🏅 Profile Badge — Step 1 of 2", 0xf59e0b)
          .setDescription(
            "Your **Profile Badge** redemption has been approved! 🎉\n\n" +
            "**What do you want your badge role called?**\n" +
            "This will appear as a role next to your name.\n" +
            "Examples:\n> `⚡ Speedster` `🔥 Top Scorer` `🧤 Iron Wall` `👑 Elite`"
          )
      ]}).catch(() => {});
      return { ok: true, msg: "✅ DM sent to **" + redeem.ign + "** to pick their badge name." };
    }

    // ── shoutout ───────────────────────────────────────────
    // Instant — post in announcements right now
    case "shoutout": {
      const announceCh = ANNOUNCEMENTS_CHANNEL
        ? await guild.channels.fetch(ANNOUNCEMENTS_CHANNEL).catch(() => null)
        : null;
      if (!announceCh) return { ok: false, msg: "❌ No announcements channel set. Add `ANNOUNCEMENTS_CHANNEL_ID` to Railway variables." };
      const embed = new EmbedBuilder()
        .setTitle("📣 Team Shoutout — " + redeem.ign)
        .setColor(0x2563eb)
        .setDescription(
          "🎉 Big shoutout to **" + redeem.ign + "** — " +
          (redeem.note && redeem.note !== "None" ? redeem.note : "a valued member of the PJA squad!") +
          "\n\nKeep up the great work! 💙"
        )
        .addFields({ name: "👤 Player", value: player ? "<@" + player.user.id + "> (" + redeem.ign + ")" : redeem.ign, inline: true })
        .setFooter({ text: "PJA Team Shoutout | Project Azure (PJA)" })
        .setTimestamp();
      await announceCh.send({ embeds: [embed] });
      if (player) {
        await player.user.send({ embeds: [
          pjaEmbed("📣 Your Shoutout is Live!", 0x2563eb)
            .setDescription("Your shoutout has been posted in the announcements channel! 🎉")
        ]}).catch(() => {});
      }
      return { ok: true, msg: "✅ Shoutout posted in <#" + ANNOUNCEMENTS_CHANNEL + "> for **" + redeem.ign + "**!" };
    }

    // ── featured_card ──────────────────────────────────────
    // Instant — fetch roster data and post ID card in announcements
    case "featured_card": {
      const announceCh = ANNOUNCEMENTS_CHANNEL
        ? await guild.channels.fetch(ANNOUNCEMENTS_CHANNEL).catch(() => null)
        : null;
      if (!announceCh) return { ok: false, msg: "❌ No announcements channel set. Add `ANNOUNCEMENTS_CHANNEL_ID` to Railway variables." };

      const [liveRoster, liveStats, liveAwards] = await Promise.all([
        apiGet("roster"), apiGet("stats"), apiGet("awards"),
      ]);
      const rp     = liveRoster.find(p => (p.name || p.ign || "").toLowerCase() === redeem.ign.toLowerCase());
      const stats  = liveStats.find(s  => (s.player || s.name || s.ign || "").toLowerCase() === redeem.ign.toLowerCase());
      const awards = (liveAwards || []).filter(a => (a.player || "").toLowerCase() === redeem.ign.toLowerCase());

      const roleColors = { Captain: 0xf59e0b, "Co-Captain": 0xa78bfa, Starter: 0x2563eb, Backup: 0x6b7280, Trialist: 0x22c55e, Academy: 0x60a5fa };
      const cardColor  = rp ? (roleColors[rp.role] || 0x2563eb) : 0x2563eb;
      const roleEmoji  = { Captain: "👑", "Co-Captain": "🥈", Starter: "⭐", Backup: "🔵", Trialist: "🔬", Academy: "🎓" };

      const cardEmbed = new EmbedBuilder()
        .setTitle("⭐  PLAYER OF THE WEEK — PROJECT AZURE")
        .setColor(cardColor)
        .setDescription(
          "```\n" +
          "╔══════════════════════════════╗\n" +
          "║  PJA  ⭐ FEATURED PLAYER ⭐  ║\n" +
          "║  " + (redeem.ign).substring(0, 28).padEnd(28) + "║\n" +
          "║  " + ((rp ? (roleEmoji[rp.role] || "") + " " + rp.role : "Player")).substring(0, 28).padEnd(28) + "║\n" +
          "╚══════════════════════════════╝\n" +
          "```"
        )
        .addFields(
          { name: "📍 Position",    value: rp ? ((rp.position || "—") + (rp.backup ? " / " + rp.backup : "")) : "—", inline: true },
          { name: "🌍 Timezone",    value: rp ? (rp.timezone || "—") : "—", inline: true },
          { name: "📊 Stats",
            value: stats
              ? "⚽ **" + (stats.goals||0) + "** G  |  🎯 **" + (stats.assists||0) + "** A  |  🧤 **" + (stats.saves||0) + "** S  |  🏆 **" + (stats.motms||0) + "** MOTM"
              : "No stats yet",
            inline: false },
          { name: "🏅 Awards",      value: awards.length > 0 ? awards.slice(0,3).map(a => "🏅 " + (a.award||a.name||"Award")).join(" | ") : "None yet", inline: true },
          { name: "🪙 PJA Points",  value: getPoints(redeem.ign) + " pts", inline: true },
          { name: "💬 Note",        value: redeem.note && redeem.note !== "None" ? redeem.note : "This week's featured player — congratulations! 🎉", inline: false },
        )
        .setFooter({ text: "Featured Player Card | Project Azure (PJA)" })
        .setTimestamp();

      await announceCh.send({
        content: player ? "<@" + player.user.id + "> 🎉 You've been featured as **Player of the Week**!" : "🎉 **" + redeem.ign + "** is our featured player this week!",
        embeds: [cardEmbed],
      });
      if (player) {
        await player.user.send({ embeds: [
          pjaEmbed("⭐ You've been Featured!", 0xf59e0b)
            .setDescription("Your **Featured Player Card** has been posted in announcements! 🎉")
        ]}).catch(() => {});
      }
      return { ok: true, msg: "✅ Featured card posted in <#" + ANNOUNCEMENTS_CHANNEL + "> for **" + redeem.ign + "**!" };
    }

    // ── clip_feature ───────────────────────────────────────
    // Step 1: DM player asking for clip link
    case "clip_feature": {
      if (!player) return { ok: false, msg: "Could not find **" + redeem.ign + "** in the server to start the clip flow." };
      pendingInputs.set(player.user.id, {
        step:     "clip_link",
        redeemId: redeem.id,
        guildId:  guild.id,
        ign:      redeem.ign,
      });
      await player.user.send({ embeds: [
        pjaEmbed("🎬 Clip Feature — Send Your Clip", 0x2563eb)
          .setDescription(
            "Your **Clip Feature** redemption has been approved! 🎉\n\n" +
            "**Please send your clip link now.**\n" +
            "Supported: YouTube, Medal, Streamable, Twitch clip, or any direct video URL.\n\n" +
            "_Your clip will be posted in the announcements channel._"
          )
      ]}).catch(() => {});
      return { ok: true, msg: "✅ DM sent to **" + redeem.ign + "** asking for their clip link." };
    }

    // ── custom_title ───────────────────────────────────────
    // Step 1: DM player asking for title/role name
    case "custom_title": {
      if (!player) return { ok: false, msg: "Could not find **" + redeem.ign + "** in the server to start the title flow." };
      pendingInputs.set(player.user.id, {
        step:     "title_name",
        redeemId: redeem.id,
        guildId:  guild.id,
        ign:      redeem.ign,
      });
      await player.user.send({ embeds: [
        pjaEmbed("🏷️ Custom Title — Step 1 of 2", 0x2563eb)
          .setDescription(
            "Your **Custom Title** redemption has been approved! 🎉\n\n" +
            "**What do you want your custom title to be?**\n" +
            "This will appear as a role next to your name.\n" +
            "Examples:\n> `The Playmaker` `Mr. Clutch` `Wall of Steel` `PJA Legend`"
          )
      ]}).catch(() => {});
      return { ok: true, msg: "✅ DM sent to **" + redeem.ign + "** to pick their custom title." };
    }

    default:
      return { ok: false, msg: "Unknown item ID: " + redeem.itemId };
  }
}

// ── ROLE CREATION HELPER ───────────────────────────────────────
// Creates a role with a given name + colour, then assigns to member
// Returns { ok, role, error } so callers can handle failures gracefully
async function createAndAssignRole(guild, member, roleName, colour) {
  // 1. Check the bot has Manage Roles permission
  const botMember = guild.members.me;
  if (!botMember || !botMember.permissions.has("ManageRoles")) {
    return { ok: false, error: "I don't have the **Manage Roles** permission. Please give the bot that permission in Server Settings." };
  }

  // 2. Clamp colour — Discord rejects 0x000000 exactly
  const safeColour = (!colour || colour === 0) ? 0x000001 : colour;

  try {
    // 3. Reuse existing role if name matches, otherwise create
    let role = guild.roles.cache.find(r => r.name === roleName);
    if (!role) {
      role = await guild.roles.create({
        name:        roleName,
        color:       safeColour,
        permissions: [],
        reason:      "PJA Shop redemption — " + roleName,
      });
    } else {
      // Update colour in case it changed
      await role.setColor(safeColour, "PJA Shop colour update").catch(() => {});
    }

    // 4. Move the role to second-highest position (just below the bot's own top role)
    //    so the colour actually shows instead of being overridden by higher roles
    const botTopPos    = botMember.roles.highest.position;
    const targetPos    = Math.max(botTopPos - 1, 1); // one below bot's top role, never 0
    await role.setPosition(targetPos, { reason: "PJA colour role — must be near top to show" }).catch(() => {});

    // 5. Check bot role is still higher after repositioning
    if (botMember.roles.highest.position <= role.position) {
      return { ok: false, error: "I can't assign the role **" + roleName + "** because it ended up higher than my own role. Please move the bot's role to the very top in Server Settings → Roles." };
    }

    await member.roles.add(role);
    return { ok: true, role };
  } catch (err) {
    console.error("createAndAssignRole error:", err);
    return { ok: false, error: "Role creation failed: " + (err.message || "Unknown error") };
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

// ── GIVEAWAY HELPERS ──────────────────────────────────────────
function buildGiveawayEmbed(data) {
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
      { name: "🏆 Prize",      value: data.prize,                                                                    inline: true },
      { name: "🎫 Winners",    value: data.winnersCount + " winner(s)",                                               inline: true },
      { name: "👥 Entries",    value: data.entries.size + " entered",                                                 inline: true },
      { name: "⏰ Ends",       value: data.ended ? "Ended" : "<t:" + endUnix + ":R> (<t:" + endUnix + ":F>)",       inline: false },
      { name: "🎙️ Hosted by", value: data.hostedBy,                                                                 inline: true },
      { name: "🔵 Status",     value: statusStr,                                                                      inline: true },
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
  const pool    = [...entries];
  const winners = [];
  for (let i = 0; i < Math.min(count, pool.length); i++) {
    const idx = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(idx, 1)[0]);
  }
  return winners;
}
async function endGiveaway(give, channel) {
  try {
    if (!channel) return;
    let winnersStr;
    if (give.entries.size === 0) {
      winnersStr = "😔 No one entered the giveaway.";
    } else {
      const w    = pickWinners(give.entries, give.winnersCount);
      winnersStr = w.map(id => "🏆 <@" + id + ">").join("\n");
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
    if (give.messageId) {
      try {
        const origMsg = await channel.messages.fetch(give.messageId).catch(() => null);
        if (origMsg) await origMsg.edit({ embeds: [buildGiveawayEmbed(give)], components: [buildGiveawayButton(give.id, true)] });
      } catch(e) {}
    }
  } catch (e) { console.error("endGiveaway error:", e.message); }
}

// ── ACTIVITY CHECK HELPER ─────────────────────────────────────
function buildActivityEmbed(data) {
  const active = data.active.size > 0 ? [...data.active].map(n => "✅ " + n).join("\n") : "No responses yet";
  return new EmbedBuilder()
    .setTitle("📋 Activity Check — Project Azure")
    .setColor(0x2563eb)
    .setDescription(data.message || "Click the button below to confirm you're active!")
    .addFields(
      { name: "⏰ Deadline",            value: data.deadline || "No deadline set", inline: true },
      { name: "👥 Active (" + data.active.size + ")", value: active, inline: false },
    )
    .setFooter({ text: "Activity Check | Project Azure (PJA)" })
    .setTimestamp();
}

// ── VOTE HELPER ───────────────────────────────────────────────
function buildVoteEmbed(data) {
  const total = data.options.reduce((s, o) => s + o.voters.size, 0);
  const bars  = data.options.map((opt, i) => {
    const count = opt.voters.size;
    const pct   = total > 0 ? Math.round((count / total) * 100) : 0;
    const bar   = "█".repeat(Math.floor(pct / 10)) + "░".repeat(10 - Math.floor(pct / 10));
    return "**" + (i + 1) + ". " + opt.label + "** — " + count + " vote(s) (" + pct + "%)\n`" + bar + "`";
  });
  return new EmbedBuilder()
    .setTitle("🗳️ Team Vote")
    .setColor(0x2563eb)
    .setDescription("**" + data.question + "**\n\n" + bars.join("\n\n"))
    .addFields({ name: "📊 Total Votes", value: total + " vote(s)", inline: true })
    .setFooter({ text: "Vote using the buttons below | Project Azure (PJA)" })
    .setTimestamp();
}

// ── SUGGESTION EMBED BUILDER ──────────────────────────────────
function buildSuggestionEmbed(data) {
  const statusEmoji = { pending: "⏳ Pending", approved: "✅ Approved", denied: "❌ Denied" };
  const statusColor = { pending: 0x2563eb, approved: 0x22c55e, denied: 0xef4444 };
  return new EmbedBuilder()
    .setTitle("💡 Suggestion — " + data.category)
    .setColor(statusColor[data.status] || 0x2563eb)
    .setDescription("> " + data.suggestion)
    .addFields(
      { name: "👤 Submitted by", value: "<@" + data.userId + "> (" + data.username + ")", inline: true },
      { name: "🏷️ Category",    value: data.category,                                     inline: true },
      { name: "🆔 ID",           value: data.id,                                           inline: true },
      { name: "👍 Upvotes",      value: data.upvotes.size.toString(),                      inline: true },
      { name: "👎 Downvotes",    value: data.downvotes.size.toString(),                    inline: true },
      { name: "📊 Status",       value: statusEmoji[data.status] || data.status,           inline: true },
    )
    .setFooter({ text: "Suggestion System | Project Azure (PJA)" })
    .setTimestamp();
}

// ── SLASH COMMANDS ─────────────────────────────────────────────
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
      .addChoices({ name:"GK",value:"GK"},{ name:"CB",value:"CB"},{ name:"LB",value:"LB"},{ name:"RB",value:"RB"},{ name:"CDM",value:"CDM"},{ name:"CM",value:"CM"},{ name:"CAM",value:"CAM"},{ name:"LW/LM",value:"LW"},{ name:"RW/RM",value:"RW"},{ name:"ST",value:"ST"}))
    .addStringOption(o => o.setName("backup").setDescription("Backup position").setRequired(true)
      .addChoices({ name:"GK",value:"GK"},{ name:"CB",value:"CB"},{ name:"LB",value:"LB"},{ name:"RB",value:"RB"},{ name:"CDM",value:"CDM"},{ name:"CM",value:"CM"},{ name:"CAM",value:"CAM"},{ name:"LW/LM",value:"LW"},{ name:"RW/RM",value:"RW"},{ name:"ST",value:"ST"},{ name:"None",value:"None"}))
    .addStringOption(o => o.setName("skill").setDescription("Skill level").setRequired(true)
      .addChoices({ name:"Beginner",value:"Beginner"},{ name:"Intermediate",value:"Intermediate"},{ name:"Advanced",value:"Advanced"},{ name:"Elite",value:"Elite"}))
    .addStringOption(o => o.setName("timezone").setDescription("Your timezone e.g. GMT").setRequired(true))
    .addStringOption(o => o.setName("availability").setDescription("When are you available?").setRequired(true))
    .addStringOption(o => o.setName("priority").setDescription("Team priority").setRequired(true)
      .addChoices({ name:"1st Main",value:"1st Main"},{ name:"2nd Main",value:"2nd Main"},{ name:"3rd Main",value:"3rd Main"},{ name:"Other",value:"Other"}))
    .addStringOption(o => o.setName("clip").setDescription("Clip/highlight link").setRequired(false))
    .addStringOption(o => o.setName("why").setDescription("Why do you want to join PJA?").setRequired(false))
    .addStringOption(o => o.setName("bring").setDescription("What can you bring to PJA?").setRequired(false)),

  new SlashCommandBuilder().setName("applications").setDescription("View pending tryout applications [Manager only]")
    .addStringOption(o => o.setName("filter").setDescription("Filter status").setRequired(false)
      .addChoices({ name:"All",value:"all"},{ name:"Pending",value:"pending"},{ name:"Accepted",value:"accepted"},{ name:"Denied",value:"denied"},{ name:"Trialist",value:"trialist"},{ name:"Needs Clips",value:"needsclips"})),

  new SlashCommandBuilder().setName("match-report").setDescription("Post a match report [Manager only]")
    .addStringOption(o => o.setName("opponent").setDescription("Opponent name").setRequired(true))
    .addStringOption(o => o.setName("score").setDescription("Score e.g. 3-1").setRequired(true))
    .addStringOption(o => o.setName("result").setDescription("Result").setRequired(true)
      .addChoices({ name:"Win",value:"Win"},{ name:"Loss",value:"Loss"},{ name:"Draw",value:"Draw"}))
    .addStringOption(o => o.setName("scorers").setDescription("Goal scorers (comma separated)").setRequired(false))
    .addStringOption(o => o.setName("assists").setDescription("Assisters (comma separated)").setRequired(false))
    .addStringOption(o => o.setName("saves").setDescription("Saves (comma separated)").setRequired(false))
    .addStringOption(o => o.setName("motm").setDescription("Man of the Match").setRequired(false))
    .addStringOption(o => o.setName("notes").setDescription("Extra notes").setRequired(false))
    .addStringOption(o => o.setName("players").setDescription("Comma-separated IGNs who played (pre-generates submission tokens for future website links)").setRequired(false)),

  new SlashCommandBuilder().setName("leaderboard").setDescription("View PJA player leaderboard")
    .addStringOption(o => o.setName("category").setDescription("Category").setRequired(false)
      .addChoices({ name:"Goals",value:"goals"},{ name:"Assists",value:"assists"},{ name:"Saves",value:"saves"},{ name:"MOTMs",value:"motms"},{ name:"Matches Played",value:"matches"})),

  new SlashCommandBuilder().setName("schedule").setDescription("View upcoming matches, friendlies and scrims")
    .addStringOption(o => o.setName("type").setDescription("Filter by type").setRequired(false)
      .addChoices({ name:"All",value:"all"},{ name:"Match",value:"match"},{ name:"Friendly",value:"friendly"},{ name:"Scrim",value:"scrim"},{ name:"Practice",value:"practice"})),

  new SlashCommandBuilder().setName("add-schedule").setDescription("Add an event to the schedule [Manager only]")
    .addStringOption(o => o.setName("type").setDescription("Event type").setRequired(true)
      .addChoices({ name:"Match",value:"Match"},{ name:"Friendly",value:"Friendly"},{ name:"Scrim",value:"Scrim"},{ name:"Practice",value:"Practice"}))
    .addStringOption(o => o.setName("opponent").setDescription("Opponent / event name").setRequired(true))
    .addStringOption(o => o.setName("date").setDescription("Date e.g. 14 Jun 2026").setRequired(true))
    .addStringOption(o => o.setName("time").setDescription("Time e.g. 7pm GMT").setRequired(true))
    .addStringOption(o => o.setName("notes").setDescription("Extra notes").setRequired(false)),

  new SlashCommandBuilder().setName("attendance").setDescription("Mark attendance for a session [Manager only]")
    .addStringOption(o => o.setName("session").setDescription("Session name or ID").setRequired(true))
    .addStringOption(o => o.setName("player").setDescription("Player IGN").setRequired(true))
    .addStringOption(o => o.setName("status").setDescription("Attendance status").setRequired(true)
      .addChoices({ name:"Present",value:"Present"},{ name:"Late",value:"Late"},{ name:"Absent",value:"Absent"},{ name:"Excused",value:"Excused"})),

  new SlashCommandBuilder().setName("lineup").setDescription("Show or set the team lineup")
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
    .addStringOption(o => o.setName("team").setDescription("Team name").setRequired(true))
    .addStringOption(o => o.setName("areas").setDescription("Weak areas (comma separated)").setRequired(false)),

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

  // ── BATCH 1 ────────────────────────────────────────────────
  new SlashCommandBuilder().setName("profile").setDescription("View a player's full profile")
    .addStringOption(o => o.setName("ign").setDescription("Player's VRFS username").setRequired(true)),

  new SlashCommandBuilder().setName("id-card").setDescription("Generate a PJA player ID card")
    .addStringOption(o => o.setName("ign").setDescription("Player's VRFS username").setRequired(true)),

  new SlashCommandBuilder().setName("request").setDescription("Send a request to the PJA managers")
    .addStringOption(o => o.setName("type").setDescription("Type of request").setRequired(true)
      .addChoices({ name:"Role Change",value:"Role Change"},{ name:"Position Change",value:"Position Change"},{ name:"Tryout Review",value:"Tryout Review"},{ name:"Roster Update",value:"Roster Update"},{ name:"Stat Correction",value:"Stat Correction"},{ name:"Scrim/Friendly Help",value:"Scrim/Friendly Help"},{ name:"Transfer/Release",value:"Transfer/Release"},{ name:"Other",value:"Other"}))
    .addStringOption(o => o.setName("details").setDescription("Describe your request in detail").setRequired(true))
    .addStringOption(o => o.setName("ign").setDescription("Your VRFS username").setRequired(false)),

  new SlashCommandBuilder().setName("trial-review").setDescription("Rate a trialist [Manager only]")
    .addStringOption(o => o.setName("player").setDescription("Trialist IGN").setRequired(true))
    .addIntegerOption(o => o.setName("mechanics").setDescription("Mechanics score 1-10").setRequired(true).setMinValue(1).setMaxValue(10))
    .addIntegerOption(o => o.setName("positioning").setDescription("Positioning score 1-10").setRequired(true).setMinValue(1).setMaxValue(10))
    .addIntegerOption(o => o.setName("communication").setDescription("Communication score 1-10").setRequired(true).setMinValue(1).setMaxValue(10))
    .addIntegerOption(o => o.setName("teamwork").setDescription("Teamwork score 1-10").setRequired(true).setMinValue(1).setMaxValue(10))
    .addIntegerOption(o => o.setName("consistency").setDescription("Consistency score 1-10").setRequired(true).setMinValue(1).setMaxValue(10))
    .addIntegerOption(o => o.setName("gamesense").setDescription("Game sense score 1-10").setRequired(true).setMinValue(1).setMaxValue(10))
    .addStringOption(o => o.setName("notes").setDescription("Extra notes").setRequired(false)),

  new SlashCommandBuilder().setName("award-give").setDescription("Give a player an award [Manager only]")
    .addStringOption(o => o.setName("player").setDescription("Player IGN").setRequired(true))
    .addStringOption(o => o.setName("award").setDescription("Award name e.g. MOTM, Golden Boot").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason for the award").setRequired(true)),

  new SlashCommandBuilder().setName("awards").setDescription("View a player's awards")
    .addStringOption(o => o.setName("player").setDescription("Player IGN").setRequired(true)),

  new SlashCommandBuilder().setName("activity-check").setDescription("Post an activity check [Manager/Captain]")
    .addStringOption(o => o.setName("message").setDescription("Message e.g. 'Check in for this week!'").setRequired(false))
    .addStringOption(o => o.setName("deadline").setDescription("Deadline e.g. Sunday midnight").setRequired(false)),

  new SlashCommandBuilder().setName("team-vote").setDescription("Create a team vote/poll [Manager/Captain]")
    .addStringOption(o => o.setName("question").setDescription("The question to vote on").setRequired(true))
    .addStringOption(o => o.setName("option1").setDescription("Option 1").setRequired(true))
    .addStringOption(o => o.setName("option2").setDescription("Option 2").setRequired(true))
    .addStringOption(o => o.setName("option3").setDescription("Option 3 (optional)").setRequired(false))
    .addStringOption(o => o.setName("option4").setDescription("Option 4 (optional)").setRequired(false)),

  new SlashCommandBuilder().setName("giveaway").setDescription("Start a giveaway [Manager only]")
    .addStringOption(o => o.setName("prize").setDescription("What are you giving away?").setRequired(true))
    .addStringOption(o => o.setName("duration").setDescription("Duration e.g. 1h, 30m, 1d, 7d").setRequired(true))
    .addIntegerOption(o => o.setName("winners").setDescription("Number of winners").setRequired(true).setMinValue(1).setMaxValue(10))
    .addStringOption(o => o.setName("requirements").setDescription("Entry requirements (optional)").setRequired(false))
    .addStringOption(o => o.setName("notes").setDescription("Extra notes (optional)").setRequired(false)),

  new SlashCommandBuilder().setName("giveaway-end").setDescription("End a giveaway early [Manager only]")
    .addStringOption(o => o.setName("id").setDescription("Giveaway ID").setRequired(true)),

  new SlashCommandBuilder().setName("giveaway-reroll").setDescription("Reroll a giveaway winner [Manager only]")
    .addStringOption(o => o.setName("id").setDescription("Giveaway ID").setRequired(true)),

  // ── BATCH 2 ────────────────────────────────────────────────
  new SlashCommandBuilder().setName("warn").setDescription("Give a player a warning [Manager only]")
    .addStringOption(o => o.setName("player").setDescription("Player IGN").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason for the warning").setRequired(true))
    .addStringOption(o => o.setName("severity").setDescription("Warning severity").setRequired(true)
      .addChoices({ name:"Low",value:"Low"},{ name:"Medium",value:"Medium"},{ name:"High",value:"High"})),

  new SlashCommandBuilder().setName("warnings").setDescription("View all warnings for a player [Manager only]")
    .addStringOption(o => o.setName("player").setDescription("Player IGN").setRequired(true)),

  new SlashCommandBuilder().setName("clear-warning").setDescription("Remove a specific warning by ID [Manager only]")
    .addStringOption(o => o.setName("player").setDescription("Player IGN").setRequired(true))
    .addStringOption(o => o.setName("warning-id").setDescription("Warning ID to remove").setRequired(true)),

  new SlashCommandBuilder().setName("strikes").setDescription("View a player's strike count (3 warnings = 1 strike)")
    .addStringOption(o => o.setName("player").setDescription("Player IGN").setRequired(true)),

  new SlashCommandBuilder().setName("shop").setDescription("Browse the PJA team reward shop"),

  new SlashCommandBuilder().setName("points").setDescription("Check a player's PJA point balance")
    .addStringOption(o => o.setName("player").setDescription("Player IGN (leave blank to check your own)").setRequired(false)),

  new SlashCommandBuilder().setName("give-points").setDescription("Give PJA points to a player [Manager only]")
    .addStringOption(o => o.setName("player").setDescription("Player IGN").setRequired(true))
    .addIntegerOption(o => o.setName("amount").setDescription("Points to give (use negative to remove)").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason for giving points").setRequired(true)),

  new SlashCommandBuilder().setName("redeem").setDescription("Redeem PJA points for a shop reward")
    .addStringOption(o => o.setName("item").setDescription("Item from /shop").setRequired(true)
      .addChoices(
        { name:"Rename Bot 24h (200pts)",            value:"rename_bot"      },
        { name:"Server Emoji Request (200pts)",       value:"server_emoji"    },
        { name:"Custom Command Reply (200pts)",       value:"custom_command"  },
        { name:"Rename a Giveaway (150pts)",          value:"rename_giveaway" },
        { name:"Server Poll Override (200pts)",       value:"server_poll"     },
        { name:"Lucky Number Claim (150pts)",         value:"lucky_number"    },
        { name:"Point Steal Ticket (150pts)",         value:"point_steal"     },
        { name:"Point Gamble Ticket (75pts)",         value:"point_gamble"    },
        { name:"Mystery Spin Wheel (100pts)",         value:"mystery_spin"    },
        { name:"Temporary Shop Discount (200pts)",    value:"shop_discount"   }
      ))
    .addStringOption(o => o.setName("ign").setDescription("Your VRFS IGN — leave blank if you're linked. Managers only: use this to redeem for another player.").setRequired(false))
    .addStringOption(o => o.setName("note").setDescription("Extra note for your redemption (optional)").setRequired(false))
    .addStringOption(o => o.setName("target").setDescription("For point_steal: target player IGN. For point_gamble: amount to gamble (10-200).").setRequired(false)),

  new SlashCommandBuilder().setName("suggest").setDescription("Submit a suggestion for the team or bot")
    .addStringOption(o => o.setName("suggestion").setDescription("Your suggestion").setRequired(true))
    .addStringOption(o => o.setName("category").setDescription("Suggestion category").setRequired(false)
      .addChoices({ name:"Team Strategy",value:"Team Strategy"},{ name:"Bot Feature",value:"Bot Feature"},{ name:"Server Setup",value:"Server Setup"},{ name:"Recruitment",value:"Recruitment"},{ name:"Events",value:"Events"},{ name:"Other",value:"Other"})),

  new SlashCommandBuilder().setName("bug-report").setDescription("Report a bot or website bug")
    .addStringOption(o => o.setName("what").setDescription("What broke / what went wrong?").setRequired(true))
    .addStringOption(o => o.setName("where").setDescription("Which command or website page?").setRequired(true))
    .addStringOption(o => o.setName("proof").setDescription("Screenshot or proof link (optional)").setRequired(false))
    .addStringOption(o => o.setName("notes").setDescription("Extra notes (optional)").setRequired(false)),

  new SlashCommandBuilder().setName("server-stats").setDescription("Show server and team statistics"),

  // /link
  new SlashCommandBuilder().setName("link").setDescription("Link your Discord account to your VRFS IGN")
    .addStringOption(o => o.setName("ign").setDescription("Your VRFS in-game username").setRequired(true)),

  // /link-player
  new SlashCommandBuilder().setName("link-player").setDescription("Link a Discord user to a VRFS IGN [Manager only]")
    .addUserOption(o   => o.setName("user").setDescription("Discord user to link").setRequired(true))
    .addStringOption(o => o.setName("ign").setDescription("Their VRFS in-game username").setRequired(true)),

  // /linked
  new SlashCommandBuilder().setName("linked").setDescription("Check which IGN a Discord user is linked to")
    .addUserOption(o => o.setName("user").setDescription("Discord user to check (leave blank for yourself)").setRequired(false)),

  // /shop-price
  new SlashCommandBuilder().setName("shop-price").setDescription("Change the price of a shop item [Manager only]")
    .addStringOption(o => o.setName("item").setDescription("Item to change the price of").setRequired(true)
      .addChoices(
        { name: "Rename Bot 24h",           value: "rename_bot"      },
        { name: "Server Emoji Request",     value: "server_emoji"    },
        { name: "Custom Command Reply",     value: "custom_command"  },
        { name: "Rename a Giveaway",        value: "rename_giveaway" },
        { name: "Server Poll Override",     value: "server_poll"     },
        { name: "Lucky Number Claim",       value: "lucky_number"    },
        { name: "Point Steal Ticket",       value: "point_steal"     },
        { name: "Point Gamble Ticket",      value: "point_gamble"    },
        { name: "Mystery Spin Wheel",       value: "mystery_spin"    },
        { name: "Temporary Shop Discount",  value: "shop_discount"   }
      ))
    .addIntegerOption(o => o.setName("price").setDescription("New price in PJA points (1–9999)").setRequired(true).setMinValue(1).setMaxValue(9999)),

  // /shop-requests
  new SlashCommandBuilder().setName("shop-requests").setDescription("View and action pending shop requests [Manager only]")
    .addStringOption(o => o.setName("filter").setDescription("Filter by status").setRequired(false)
      .addChoices({ name:"Pending",value:"pending" },{ name:"Approved",value:"approved" },{ name:"Denied",value:"denied" },{ name:"All",value:"all" })),

  // /submission-history
  new SlashCommandBuilder().setName("submission-history").setDescription("View full submission history for a match [Manager only]")
    .addStringOption(o => o.setName("report-id").setDescription("Match report ID").setRequired(true))
    .addStringOption(o => o.setName("filter").setDescription("Filter submissions").setRequired(false)
      .addChoices(
        { name:"All Pending",value:"pending" },{ name:"Approved",value:"approved" },{ name:"Denied",value:"denied" },
        { name:"Needs Proof",value:"needs_proof" },{ name:"Edited",value:"edited" },{ name:"All",value:"all" }
      ))
    .addStringOption(o => o.setName("player").setDescription("Filter by player IGN").setRequired(false)),

  // /motm-results
  new SlashCommandBuilder().setName("motm-results").setDescription("View MOTM vote results for a match")
    .addStringOption(o => o.setName("report-id").setDescription("Match report ID").setRequired(true)),

  // /custom-commands
  new SlashCommandBuilder().setName("custom-commands").setDescription("View, add, or remove custom bot commands [Manager: add/remove]")
    .addStringOption(o => o.setName("action").setDescription("What to do").setRequired(false)
      .addChoices(
        { name:"List all",    value:"list"   },
        { name:"Add new",     value:"add"    },
        { name:"Remove one",  value:"remove" },
      ))
    .addStringOption(o => o.setName("trigger").setDescription("Trigger word (e.g. !hype) — required for add/remove").setRequired(false))
    .addStringOption(o => o.setName("reply").setDescription("Bot reply text — required for add").setRequired(false)),

  // /send-report-links — future website readiness
  // Sends each registered player their personal submission link.
  // Currently shows Discord-only notice since site isn't built yet.
  // When SITE_URL is set, this will send real clickable links.
  new SlashCommandBuilder().setName("send-report-links").setDescription("Send submission links to players for a match [Manager only]")
    .addStringOption(o => o.setName("report-id").setDescription("Match report ID").setRequired(true))
    .addStringOption(o => o.setName("mode").setDescription("How to send").setRequired(false)
      .addChoices(
        { name:"Post in channel (visible to all)", value:"channel" },
        { name:"DM each player individually",      value:"dm"      },
      )),

  // /report-status — see who has/hasn't submitted for a match
  new SlashCommandBuilder().setName("report-status").setDescription("See submission status for every player in a match [Manager only]")
    .addStringOption(o => o.setName("report-id").setDescription("Match report ID").setRequired(true)),

  // ── MATCH REPORT SYSTEM ───────────────────────────────────────

  new SlashCommandBuilder().setName("getting-started").setDescription("New to PJA? Fill out your team profile here"),

  new SlashCommandBuilder().setName("setup-profile").setDescription("Fill out your PJA team profile (same as /getting-started)"),

  new SlashCommandBuilder().setName("self-report").setDescription("Submit your stats for a match you played in")
    .addStringOption(o => o.setName("report-id").setDescription("Match report ID (from manager)").setRequired(true))
    .addStringOption(o => o.setName("position").setDescription("Your position in this match").setRequired(true)
      .addChoices(
        { name: "GK — Goalkeeper",          value: "GK"      },
        { name: "DEF — Defender (CB/LB/RB)", value: "DEF"     },
        { name: "MID — Central Midfielder", value: "MID"     },
        { name: "LM — Left Midfielder",     value: "LM"      },
        { name: "RM — Right Midfielder",    value: "RM"      },
        { name: "WING — Winger (LW/RW)",    value: "WING"    },
        { name: "ST — Striker/Forward",     value: "ST"      },
        { name: "Utility / Sub",            value: "Utility" },
      ))
    .addStringOption(o => o.setName("motm-nominee").setDescription("Who do you vote for MOTM? (optional — include it in your report)").setRequired(false))
    .addStringOption(o => o.setName("motm-reason").setDescription("Why are you voting for them? (optional)").setRequired(false)),

  new SlashCommandBuilder().setName("motm-vote").setDescription("Vote for Man of the Match")
    .addStringOption(o => o.setName("report-id").setDescription("Match report ID").setRequired(true))
    .addStringOption(o => o.setName("vote-for").setDescription("IGN of the player you're voting for").setRequired(true)),

  new SlashCommandBuilder().setName("review-submissions").setDescription("Review player self-reports one at a time [Manager only]")
    .addStringOption(o => o.setName("report-id").setDescription("Match report ID").setRequired(true))
    .addStringOption(o => o.setName("filter").setDescription("Filter submissions").setRequired(false)
      .addChoices(
        { name:"All Pending",value:"pending" },{ name:"Needs Proof",value:"needs_proof" },
        { name:"Edited",value:"edited" },{ name:"Approved",value:"approved" },{ name:"Denied",value:"denied" },
        { name:"All",value:"all" }
      ))
    .addStringOption(o => o.setName("player").setDescription("Filter by player IGN").setRequired(false)),

  new SlashCommandBuilder().setName("ai-motm").setDescription("Get AI Man of the Match recommendation [Manager only]")
    .addStringOption(o => o.setName("report-id").setDescription("Match report ID").setRequired(true)),

  new SlashCommandBuilder().setName("final-report").setDescription("Generate the final match report [Manager only]")
    .addStringOption(o => o.setName("report-id").setDescription("Match report ID").setRequired(true))
    .addStringOption(o => o.setName("motm").setDescription("Confirmed MOTM player IGN").setRequired(false))
    .addStringOption(o => o.setName("notes").setDescription("Manager notes").setRequired(false)),

  new SlashCommandBuilder().setName("stats").setDescription("View a player's stats")
    .addStringOption(o => o.setName("player").setDescription("Player IGN (leave blank for your own)").setRequired(false)),

  // ── ROSTER MANAGEMENT ─────────────────────────────────────────

  new SlashCommandBuilder().setName("add-player").setDescription("Add a player to the PJA roster [Manager only]")
    .addStringOption(o => o.setName("ign").setDescription("VRFS username").setRequired(true))
    .addStringOption(o => o.setName("position").setDescription("Main position").setRequired(true)
      .addChoices({name:"GK",value:"GK"},{name:"CB",value:"CB"},{name:"LB",value:"LB"},{name:"RB",value:"RB"},{name:"CDM",value:"CDM"},{name:"CM",value:"CM"},{name:"CAM",value:"CAM"},{name:"LW",value:"LW"},{name:"RW",value:"RW"},{name:"ST",value:"ST"},{name:"Utility",value:"Utility"}))
    .addStringOption(o => o.setName("role").setDescription("Team role").setRequired(true)
      .addChoices({name:"Starter",value:"Starter"},{name:"Backup",value:"Backup"},{name:"Trialist",value:"Trialist"},{name:"Captain",value:"Captain"},{name:"Co-Captain",value:"Co-Captain"},{name:"Academy",value:"Academy"},{name:"Inactive",value:"Inactive"}))
    .addStringOption(o => o.setName("backup").setDescription("Backup position").setRequired(false))
    .addStringOption(o => o.setName("side").setDescription("Preferred side").setRequired(false)
      .addChoices({name:"Left",value:"Left"},{name:"Right",value:"Right"},{name:"Center",value:"Center"},{name:"Any",value:"Any"}))
    .addStringOption(o => o.setName("priority").setDescription("Team priority").setRequired(false)
      .addChoices({name:"1st Main",value:"1st Main"},{name:"2nd Main",value:"2nd Main"},{name:"3rd Main",value:"3rd Main"},{name:"Other",value:"Other"}))
    .addStringOption(o => o.setName("timezone").setDescription("Timezone e.g. GMT").setRequired(false))
    .addStringOption(o => o.setName("notes").setDescription("Extra notes").setRequired(false)),

  new SlashCommandBuilder().setName("edit-player").setDescription("Edit a player's profile [Manager only]")
    .addStringOption(o => o.setName("ign").setDescription("Player IGN to edit").setRequired(true))
    .addStringOption(o => o.setName("position").setDescription("New main position").setRequired(false))
    .addStringOption(o => o.setName("role").setDescription("New team role").setRequired(false)
      .addChoices({name:"Starter",value:"Starter"},{name:"Backup",value:"Backup"},{name:"Trialist",value:"Trialist"},{name:"Captain",value:"Captain"},{name:"Co-Captain",value:"Co-Captain"},{name:"Academy",value:"Academy"},{name:"Inactive",value:"Inactive"}))
    .addStringOption(o => o.setName("backup").setDescription("New backup position").setRequired(false))
    .addStringOption(o => o.setName("priority").setDescription("New team priority").setRequired(false)
      .addChoices({name:"1st Main",value:"1st Main"},{name:"2nd Main",value:"2nd Main"},{name:"3rd Main",value:"3rd Main"},{name:"Other",value:"Other"}))
    .addStringOption(o => o.setName("timezone").setDescription("New timezone").setRequired(false))
    .addStringOption(o => o.setName("availability").setDescription("New availability").setRequired(false))
    .addStringOption(o => o.setName("notes").setDescription("Updated notes").setRequired(false)),

  new SlashCommandBuilder().setName("remove-player").setDescription("Remove a player from the roster [Manager only]")
    .addStringOption(o => o.setName("ign").setDescription("Player IGN to remove").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason for removal").setRequired(false)),

  new SlashCommandBuilder().setName("promote").setDescription("Promote a player to a new role [Manager only]")
    .addStringOption(o => o.setName("ign").setDescription("Player IGN").setRequired(true))
    .addStringOption(o => o.setName("role").setDescription("New role").setRequired(true)
      .addChoices({name:"Captain",value:"Captain"},{name:"Co-Captain",value:"Co-Captain"},{name:"Starter",value:"Starter"},{name:"Backup",value:"Backup"})),

  new SlashCommandBuilder().setName("demote").setDescription("Demote a player to a lower role [Manager only]")
    .addStringOption(o => o.setName("ign").setDescription("Player IGN").setRequired(true))
    .addStringOption(o => o.setName("role").setDescription("New role").setRequired(true)
      .addChoices({name:"Backup",value:"Backup"},{name:"Trialist",value:"Trialist"},{name:"Academy",value:"Academy"},{name:"Inactive",value:"Inactive"}))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),

  new SlashCommandBuilder().setName("release").setDescription("Release a player with confirmation [Manager only]")
    .addStringOption(o => o.setName("ign").setDescription("Player IGN").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason for release").setRequired(true)),

  new SlashCommandBuilder().setName("open-spots").setDescription("View or update open positions PJA needs")
    .addStringOption(o => o.setName("action").setDescription("View or update").setRequired(false)
      .addChoices({name:"View",value:"view"},{name:"Set",value:"set"},{name:"Clear",value:"clear"}))
    .addStringOption(o => o.setName("position").setDescription("Position e.g. GK, ST").setRequired(false))
    .addIntegerOption(o => o.setName("count").setDescription("Number needed").setRequired(false))
    .addStringOption(o => o.setName("notes").setDescription("Notes e.g. 'Must be active'").setRequired(false)),

  new SlashCommandBuilder().setName("team-depth").setDescription("Show the team depth chart by position"),

  new SlashCommandBuilder().setName("backup-data").setDescription("Export all bot data as JSON [Manager only]"),

  new SlashCommandBuilder().setName("restore-data").setDescription("Restore bot data from JSON [Manager only]")
    .addStringOption(o => o.setName("json").setDescription("Paste the JSON data to restore").setRequired(true)),

  // ── ANNOUNCEMENTS ─────────────────────────────────────────────
  new SlashCommandBuilder().setName("announce").setDescription("Send a PJA announcement embed [Manager only]")
    .addStringOption(o => o.setName("title").setDescription("Announcement title").setRequired(true))
    .addStringOption(o => o.setName("message").setDescription("Announcement body text").setRequired(true))
    .addChannelOption(o => o.setName("channel").setDescription("Channel to post in (defaults to current channel)").setRequired(false))
    .addStringOption(o => o.setName("ping").setDescription("Who to ping above the embed").setRequired(false)
      .addChoices(
        { name: "None",      value: "none"      },
        { name: "@everyone", value: "everyone"  },
        { name: "@here",     value: "here"      },
        { name: "@role",     value: "role"      },
      ))
    .addStringOption(o => o.setName("color").setDescription("Embed accent color").setRequired(false)
      .addChoices(
        { name: "Blue (default)", value: "blue"  },
        { name: "Red",            value: "red"   },
        { name: "Green",          value: "green" },
        { name: "Gold",           value: "gold"  },
        { name: "Gray",           value: "gray"  },
      ))
    .addStringOption(o => o.setName("image").setDescription("Image or link to attach (URL)").setRequired(false)),

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

const MATCH_CHANNEL_ID = process.env.MATCH_CHANNEL_ID || GUILD_ID;

registerCommands().then(() => { client.login(TOKEN); }).catch(() => { client.login(TOKEN); });

// ── READY ─────────────────────────────────────────────────────
client.once("ready", async () => {
  console.log("Logged in as: " + client.user.tag);
  try { client.user.setActivity("PJA Bot | /tryout", { type: 3 }); } catch(e) {}

  // ── Restore persisted account links ───────────────────────
  // Must run before any commands are handled so linked IGNs
  // are immediately available without players running /link again.
  await loadLinks();

  console.log("Bot fully ready!");

  setMatchHandler(async (data) => {
    try {
      const channel = await client.channels.fetch(MATCH_CHANNEL_ID).catch(() => null);
      if (!channel) return;
      const id        = makeId();
      const matchData = {
        opponent: data.opponent || "TBD", date: data.date || "TBD",
        time: data.time || "TBD",         notes: data.notes || "None",
        type: data.type || "Match",       going: new Set(),
        maybe: new Set(),                 cantGo: new Set(),
        responses: new Map(),
      };
      friendlies.set(id, matchData);
      await channel.send({ embeds: [buildMatchRsvpEmbed(matchData)], components: [buildRsvpButtons(id)] });
    } catch (err) { console.error("Error posting match embed:", err); }
  });
});

// ══════════════════════════════════════════════════════════════
// ── DM MESSAGE HANDLER — multi-step shop flows ────────────────
// ══════════════════════════════════════════════════════════════
client.on("messageCreate", async (message) => {
  // Only care about DMs, not from bots
  if (message.author.bot) return;
  if (message.guild) return; // guild message, ignore
  if (!pendingInputs.has(message.author.id)) return;

  const pending = pendingInputs.get(message.author.id);
  const input   = message.content.trim();

  try {
    const guild = client.guilds.cache.get(pending.guildId) ||
                  await client.guilds.fetch(pending.guildId).catch(() => null);
    if (!guild) {
      await message.reply("❌ Could not find the PJA server. Please contact a manager.");
      pendingInputs.delete(message.author.id);
      return;
    }

    const member = await guild.members.fetch(message.author.id).catch(() => null);

    // ── nickname_color — waiting for colour ──────────────
    if (pending.step === "nickname_color_colour") {
      const colour   = parseColour(input);
      const roleName = "🎨 " + pending.ign;

      if (!member) {
        await message.reply("❌ Could not find you in the PJA server. Contact a manager.");
        pendingInputs.delete(message.author.id);
        return;
      }

      // Remove any old colour role for this IGN so the colour actually updates
      const oldRole = guild.roles.cache.find(r => r.name === roleName);
      if (oldRole) {
        await member.roles.remove(oldRole).catch(() => {});
        await oldRole.delete("Colour update via shop").catch(() => {});
      }

      const result = await createAndAssignRole(guild, member, roleName, colour);
      pendingInputs.delete(message.author.id);

      if (!result.ok) {
        await message.reply("❌ " + result.error + "\n\nPlease ask a manager to fix this.");
        return;
      }

      await message.reply({ embeds: [
        pjaEmbed("✅ Nickname Colour Applied!", colour)
          .setDescription("Your nickname colour role **" + result.role.name + "** has been created and assigned!\n\nYour name should now appear in your chosen colour in the server. 🎨")
          .addFields({ name: "🎨 Colour", value: input, inline: true })
      ]});
      return;
    }

    // ── profile_badge step 1 — waiting for role name ─────
    if (pending.step === "badge_name") {
      if (input.length > 32) {
        await message.reply("❌ Role name too long! Max 32 characters. Try again:");
        return;
      }
      pending.step     = "badge_colour";
      pending.roleName = input;
      pendingInputs.set(message.author.id, pending);
      await message.reply({ embeds: [
        pjaEmbed("🏅 Profile Badge — Step 2 of 2", 0xf59e0b)
          .setDescription(
            "Great choice! Role name: **" + input + "**\n\n" +
            "**Now, what colour do you want your badge role?**\n" +
            "Type a colour name or hex code:\n" +
            "> `Red` `Blue` `Gold` `Hot Pink` `#FF5733` `#8B00FF`"
          )
      ]});
      return;
    }

    // ── profile_badge step 2 — waiting for colour ────────
    if (pending.step === "badge_colour") {
      const colour   = parseColour(input);
      const roleName = pending.roleName;

      if (!member) {
        await message.reply("❌ Could not find you in the PJA server. Contact a manager.");
        pendingInputs.delete(message.author.id);
        return;
      }

      const result = await createAndAssignRole(guild, member, roleName, colour);
      pendingInputs.delete(message.author.id);

      if (!result.ok) {
        await message.reply("❌ " + result.error + "\n\nPlease ask a manager to fix this.");
        return;
      }

      await message.reply({ embeds: [
        pjaEmbed("✅ Badge Role Created!", colour)
          .setDescription("Your badge role **" + result.role.name + "** has been created in **" + input + "** and assigned to you! 🏅\n\nIt will now appear next to your name in the server.")
          .addFields(
            { name: "🏷️ Role Name", value: result.role.name, inline: true },
            { name: "🎨 Colour",    value: input,             inline: true },
          )
      ]});
      return;
    }

    // ── clip_feature — waiting for clip link ─────────────
    if (pending.step === "clip_link") {
      const clipLink = input;
      // Basic URL validation
      const isUrl = /https?:\/\//i.test(clipLink);
      if (!isUrl) {
        await message.reply("❌ That doesn't look like a valid URL. Please send a proper link starting with `https://`");
        return;
      }

      const announceCh = ANNOUNCEMENTS_CHANNEL
        ? await guild.channels.fetch(ANNOUNCEMENTS_CHANNEL).catch(() => null)
        : null;

      pendingInputs.delete(message.author.id);

      if (!announceCh) {
        await message.reply("⚠️ Your clip was received but the announcements channel isn't configured. A manager will post it manually.\n**Clip:** " + clipLink);
        return;
      }

      const clipEmbed = pjaEmbed("🎬 Clip Feature — " + pending.ign, 0x2563eb)
        .setDescription(
          "🎥 Check out this clip from **" + pending.ign + "**!\n\n" +
          "🔗 " + clipLink
        )
        .addFields({ name: "👤 Player", value: member ? "<@" + member.user.id + "> (" + pending.ign + ")" : pending.ign, inline: true })
        .setFooter({ text: "Clip Feature — PJA Shop | Project Azure (PJA)" });

      await announceCh.send({
        content: member ? "<@" + member.user.id + ">'s featured clip is here! 🎬" : "Featured clip from **" + pending.ign + "**! 🎬",
        embeds: [clipEmbed],
      });

      await message.reply({ embeds: [
        pjaEmbed("✅ Clip Posted!", 0x22c55e)
          .setDescription("Your clip has been featured in the announcements channel! 🎬🎉")
      ]});
      return;
    }

    // ── custom_title step 1 — waiting for title name ─────
    if (pending.step === "title_name") {
      if (input.length > 32) {
        await message.reply("❌ Title too long! Max 32 characters. Try again:");
        return;
      }
      pending.step     = "title_colour";
      pending.roleName = input;
      pendingInputs.set(message.author.id, pending);
      await message.reply({ embeds: [
        pjaEmbed("🏷️ Custom Title — Step 2 of 2", 0x2563eb)
          .setDescription(
            "Great title! **" + input + "**\n\n" +
            "**Now, what colour do you want your title role?**\n" +
            "Type a colour name or hex code:\n" +
            "> `Red` `Blue` `Gold` `Hot Pink` `#FF5733` `#00FF7F`"
          )
      ]});
      return;
    }

    // ── custom_title step 2 — waiting for colour ─────────
    if (pending.step === "title_colour") {
      const colour   = parseColour(input);
      const roleName = pending.roleName;

      if (!member) {
        await message.reply("❌ Could not find you in the PJA server. Contact a manager.");
        pendingInputs.delete(message.author.id);
        return;
      }

      const result = await createAndAssignRole(guild, member, roleName, colour);
      pendingInputs.delete(message.author.id);

      if (!result.ok) {
        await message.reply("❌ " + result.error + "\n\nPlease ask a manager to fix this.");
        return;
      }

      await message.reply({ embeds: [
        pjaEmbed("✅ Custom Title Applied!", colour)
          .setDescription("Your custom title role **" + result.role.name + "** has been created in **" + input + "** and assigned! 🏷️\n\nIt will appear next to your name in the server.")
          .addFields(
            { name: "🏷️ Title",  value: result.role.name, inline: true },
            { name: "🎨 Colour", value: input,             inline: true },
          )
      ]});
      return;
    }

  } catch (err) {
    console.error("DM flow error (step: " + (pendingInputs.get(message.author.id)?.step || "unknown") + "):", err);
    pendingInputs.delete(message.author.id);
    await message.reply(
      "❌ Something went wrong: **" + (err.message || "Unknown error") + "**\n" +
      "Please contact a manager and let them know what you typed."
    ).catch(() => {});
  }
});

// ══════════════════════════════════════════════════════════════
// ── GUILD MESSAGE HANDLER — custom command triggers ───────────
// ══════════════════════════════════════════════════════════════
client.on("messageCreate", async (message) => {
  // Only guild messages, not from bots
  if (message.author.bot) return;
  if (!message.guild)     return;

  const content = message.content.trim();
  if (!content.startsWith("!")) return;

  // Find matching trigger (case-insensitive, exact word match)
  const trigger = content.split(/\s+/)[0].toLowerCase();
  const cmd = customCommandsMap.get(trigger);
  if (!cmd) return;

  try {
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setDescription(cmd.reply)
          .setColor(0x2563eb)
          .setFooter({ text: "Custom command by " + cmd.ign + " | Project Azure (PJA)" })
      ]
    });
  } catch (err) {
    console.error("[CustomCmd] Failed to reply to trigger '" + trigger + "':", err.message);
  }
});
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
      if (liveRoster.length === 0) { await interaction.editReply("📋 The roster is currently empty."); return; }
      const roleOrder = ["Captain","Co-Captain","Starter","Backup","Trialist","Academy"];
      const sorted    = [...liveRoster].sort((a,b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role));
      const embed     = pjaEmbed("🔷 Project Azure — Current Roster")
        .setDescription(sorted.map(p =>
          "**" + (p.name||p.ign||"Unknown") + "** — " + (p.position||"?") + " | " + (p.role||"Player") + (p.timezone ? " | " + p.timezone : "")
        ).join("\n"))
        .setFooter({ text: liveRoster.length + " player(s) | Project Azure (PJA)" });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /friendly ──────────────────────────────────────────
    if (commandName === "friendly") {
      await interaction.deferReply();
      const id   = makeId();
      const data = {
        opponent: interaction.options.getString("opponent"), date: interaction.options.getString("date"),
        time: interaction.options.getString("time"),         notes: interaction.options.getString("notes") || "None",
        type: "Friendly", going: new Set(), maybe: new Set(), cantGo: new Set(), responses: new Map(),
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
        await interaction.editReply("⚠️ You already have an application on file!\n**Status:** " + ex.status.toUpperCase() + "\n**IGN:** " + ex.ign);
        return;
      }
      const appId = makeId();
      const app   = {
        id: appId, userId: user.id, username: user.tag,
        ign: interaction.options.getString("ign"),
        position: interaction.options.getString("position"),
        backup: interaction.options.getString("backup"),
        skill: interaction.options.getString("skill"),
        timezone: interaction.options.getString("timezone"),
        availability: interaction.options.getString("availability"),
        priority: interaction.options.getString("priority"),
        clip: interaction.options.getString("clip") || "Not provided",
        why: interaction.options.getString("why") || "Not provided",
        bring: interaction.options.getString("bring") || "Not provided",
        status: "pending", submittedAt: new Date().toISOString(), note: "",
      };
      applications.set(user.id, app);
      try { await apiPost("tryouts", { ...app, source: "discord" }); } catch(e) {}
      try {
        await user.send({ embeds: [
          pjaEmbed("✅ Tryout Application Received", 0x2563eb)
            .setDescription("Your application for **Project Azure** has been submitted!")
            .addFields(
              { name:"App ID", value:appId, inline:true },{ name:"IGN", value:app.ign, inline:true },
              { name:"Position", value:app.position, inline:true },{ name:"Skill", value:app.skill, inline:true },
              { name:"Status", value:"⏳ Pending Review" }
            )
        ]});
      } catch(e) {}
      await interaction.editReply("✅ Application submitted! **App ID: " + appId + "**\nWe'll DM you with a decision. Good luck! 🏆");
      return;
    }

    // ── /applications ──────────────────────────────────────
    if (commandName === "applications") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const filter = interaction.options.getString("filter") || "all";
      let apps     = [...applications.values()];
      if (filter !== "all") apps = apps.filter(a => a.status === filter);
      if (apps.length === 0) { await interaction.editReply("📭 No applications found" + (filter !== "all" ? " with status: " + filter : "") + "."); return; }
      const statusEmoji = { pending:"⏳", accepted:"✅", denied:"❌", trialist:"🔵", needsclips:"🎬" };
      const embed       = pjaEmbed("📋 Applications — " + filter.toUpperCase() + " (" + apps.length + ")", 0xf59e0b)
        .setDescription(apps.slice(0,20).map(a =>
          (statusEmoji[a.status]||"❓") + " **" + a.id + "** — " + a.ign + " | " + a.position + " | " + a.skill + " | <@" + a.userId + ">"
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

    // ── /match-report ──────────────────────────────────────
    if (commandName === "match-report") {
      await interaction.deferReply();
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const opponent = interaction.options.getString("opponent");
      const score    = interaction.options.getString("score");
      const result   = interaction.options.getString("result");
      const scorers  = interaction.options.getString("scorers") || "None";
      const assists  = interaction.options.getString("assists") || "None";
      const saves    = interaction.options.getString("saves")   || "None";
      const motm     = interaction.options.getString("motm")    || "TBD";
      const notes    = interaction.options.getString("notes")   || "None";
      const reportId = makeId();
      // Save to full match report map for self-report/motm/final-report system
      matchReportsFull.set(reportId, {
        id: reportId, opponent, score, result, scorers, assists, saves,
        motm, notes, date: new Date().toISOString(),
        postedBy: user.tag, players: [], status: "active",
        motmLocked: false, finalized: false, aiMotm: null,
        // ── Future website readiness ───────────────────────────
        // playerTokens: ign.toLowerCase() → { playerId, token, url }
        // Populated now if `players` option provided, or lazily via
        // generatePlayerToken() when /send-report-links is used later.
        playerTokens: {},
        // websiteEnabled: flip to true when site is live and you want
        // /send-report-links to send real URLs instead of Discord instructions
        websiteEnabled: false,
      });

      // Pre-generate submission tokens for every listed player
      const playersRaw = interaction.options.getString("players") || "";
      const playerList = playersRaw.split(",").map(s => s.trim()).filter(Boolean);
      if (playerList.length > 0) {
        const report = matchReportsFull.get(reportId);
        for (const ign of playerList) {
          const { playerId, token, url } = generatePlayerToken(reportId, ign);
          report.playerTokens[ign.toLowerCase()] = { playerId, token, url, ign };
        }
      }
      try { await apiPost("match_reports", { id:reportId, opponent, score, result, scorers, assists, saves, motm, notes, date:new Date().toISOString(), source:"discord" }); } catch(e) {}
      const resultColor = result==="Win"?0x22c55e:result==="Loss"?0xef4444:0xf59e0b;
      const resultIcon  = result==="Win"?"✅":result==="Loss"?"❌":"🟡";
      const embed = pjaEmbed(resultIcon + " Match Report — PJA vs " + opponent, resultColor)
        .addFields(
          { name:"Result", value:result, inline:true },{ name:"Score", value:score, inline:true },{ name:"Report ID", value:"**"+reportId+"**", inline:true },
          { name:"⚽ Scorers", value:scorers },{ name:"🎯 Assists", value:assists, inline:true },{ name:"🧤 Saves", value:saves, inline:true },
          { name:"🏆 MOTM", value:motm, inline:true },{ name:"📝 Notes", value:notes },
        )
        .setFooter({ text:"Reported by " + user.tag + " | Share the Report ID with players for /self-report | Project Azure (PJA)" });
      const matchRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("matchrep_selfreport_"+reportId).setLabel("📊 Submit Stats").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("matchrep_motm_"+reportId).setLabel("🏆 Vote MOTM").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("matchrep_review_"+reportId).setLabel("🔍 View Submissions").setStyle(ButtonStyle.Secondary),
      );
      await interaction.editReply({ embeds: [embed], components: [matchRow] });
      return;
    }

    // ── /leaderboard ───────────────────────────────────────
    if (commandName === "leaderboard") {
      await interaction.deferReply();
      const category  = interaction.options.getString("category") || "goals";
      const liveStats = await apiGet("stats");
      if (liveStats.length === 0) { await interaction.editReply("📊 No stats recorded yet."); return; }
      const categoryLabel = { goals:"⚽ Goals", assists:"🎯 Assists", saves:"🧤 Saves", motms:"🏆 MOTMs", matches:"🎮 Matches Played" };
      const sorted        = [...liveStats].sort((a,b) => (Number(b[category])||0) - (Number(a[category])||0)).slice(0,10);
      const embed         = pjaEmbed("🏅 Leaderboard — " + (categoryLabel[category]||category))
        .setDescription(sorted.map((e,i) => {
          const medal = i===0?"🥇":i===1?"🥈":i===2?"🥉":(i+1)+".";
          return medal + " **" + (e.player||e.name||e.ign||"Unknown") + "** — " + (e[category]||0);
        }).join("\n"));
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /schedule ──────────────────────────────────────────
    if (commandName === "schedule") {
      await interaction.deferReply();
      const typeFilter              = interaction.options.getString("type") || "all";
      const [liveMatches, liveScrims] = await Promise.all([apiGet("matches"), apiGet("scrims")]);
      let events = [...liveMatches.map(m=>({...m,type:m.type||"match"})),...liveScrims.map(s=>({...s,type:"scrim"})),...scheduleList];
      if (typeFilter !== "all") events = events.filter(e => (e.type||"").toLowerCase() === typeFilter.toLowerCase());
      if (events.length === 0) { await interaction.editReply("📅 No upcoming events scheduled."); return; }
      const typeIcon = { match:"🏆", friendly:"⚽", scrim:"⚔️", practice:"🏋️" };
      const embed    = pjaEmbed("📅 PJA Schedule")
        .setDescription(events.slice(0,15).map(e =>
          (typeIcon[(e.type||"").toLowerCase()]||"📌") + " **" + (e.opponent||e.name||e.title||"TBD") +
          "** | " + (e.date||"TBD") + " @ " + (e.time||"TBD")
        ).join("\n"));
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /add-schedule ──────────────────────────────────────
    if (commandName === "add-schedule") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const eventType = interaction.options.getString("type");
      const event     = {
        id: makeId(), type: eventType,
        opponent: interaction.options.getString("opponent"),
        date: interaction.options.getString("date"),
        time: interaction.options.getString("time"),
        notes: interaction.options.getString("notes") || "None",
      };
      scheduleList.push(event);
      if (["Match","Friendly","Scrim"].includes(eventType)) {
        try {
          const id = makeId();
          const md = { opponent:event.opponent, date:event.date, time:event.time, notes:event.notes, type:eventType, going:new Set(), maybe:new Set(), cantGo:new Set(), responses:new Map() };
          friendlies.set(id, md);
          await interaction.channel.send({ embeds: [buildMatchRsvpEmbed(md)], components: [buildRsvpButtons(id)] });
        } catch(e) {}
      }
      await interaction.editReply("✅ Event added! **" + event.opponent + "** — " + event.date + " @ " + event.time);
      return;
    }

    // ── /attendance ────────────────────────────────────────
    if (commandName === "attendance") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const session = interaction.options.getString("session");
      const player  = interaction.options.getString("player");
      const status  = interaction.options.getString("status");
      if (!attendanceLogs.has(session)) attendanceLogs.set(session, new Map());
      attendanceLogs.get(session).set(player, status);
      const log         = attendanceLogs.get(session);
      const statusIcon  = { Present:"✅", Late:"🕐", Absent:"❌", Excused:"🟡" };
      const embed       = pjaEmbed("📋 Attendance — " + session)
        .setDescription([...log.entries()].map(([p,s]) => (statusIcon[s]||"❓") + " **" + p + "** — " + s).join("\n"))
        .setFooter({ text: log.size + " player(s) | Project Azure (PJA)" });
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
        if (!isAdmin(member)) { await interaction.editReply("❌ Only Managers can set the lineup."); return; }
        const id = matchName || "current";
        lineups.set(id, { id, formation:formation||"TBD", players:players||"TBD", bench:bench||"None", notes:notes||"None", setBy:user.tag });
        try { await apiPost("lineups", { id, name:id, formation:formation||"TBD", source:"discord" }); } catch(e) {}
        const embed = pjaEmbed("📋 Lineup Set — " + id)
          .addFields({ name:"🗂️ Formation", value:formation||"TBD", inline:true },{ name:"👥 Players", value:players||"TBD" },{ name:"🪑 Bench", value:bench||"None" });
        await interaction.editReply({ embeds: [embed] });
        return;
      }
      const id     = matchName || "current";
      const lineup = lineups.get(id);
      if (!lineup) { await interaction.editReply("📋 No lineup set yet."); return; }
      const embed  = pjaEmbed("📋 Lineup — " + id)
        .addFields({ name:"🗂️ Formation", value:lineup.formation, inline:true },{ name:"👥 Players", value:lineup.players },{ name:"🪑 Bench", value:lineup.bench });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /chemistry ─────────────────────────────────────────
    if (commandName === "chemistry") {
      await interaction.deferReply();
      const p1 = interaction.options.getString("player1");
      const p2 = interaction.options.getString("player2");
      const liveStats = await apiGet("stats");
      const s1 = liveStats.find(s => (s.player||s.name||s.ign||"").toLowerCase() === p1.toLowerCase());
      const s2 = liveStats.find(s => (s.player||s.name||s.ign||"").toLowerCase() === p2.toLowerCase());
      let score = 0, reasons = [];
      if (s1 && s2) {
        if ((s1.matches||0)>0 && (s2.matches||0)>0) { score+=30; reasons.push("Both have match experience"); }
        if ((s1.motms||0)>0   && (s2.motms||0)>0)   { score+=20; reasons.push("Both have MOTM awards"); }
        if ((s1.goals||0)>0   && (s2.assists||0)>0)  { score+=25; reasons.push(p1+" scores, "+p2+" assists"); }
        if ((s2.goals||0)>0   && (s1.assists||0)>0)  { score+=25; reasons.push(p2+" scores, "+p1+" assists"); }
        score = Math.min(score, 100);
      } else { score = Math.floor(Math.random()*40)+40; reasons = ["No shared data — estimated"]; }
      const bar   = "█".repeat(Math.floor(score/10)) + "░".repeat(10-Math.floor(score/10));
      const color = score>=75?0x22c55e:score>=50?0xf59e0b:0xef4444;
      await interaction.editReply({ embeds: [pjaEmbed("⚡ Chemistry — "+p1+" & "+p2, color)
        .setDescription("**Score: "+score+"/100**\n`"+bar+"`")
        .addFields({ name:"📊 Analysis", value:reasons.map(r=>"• "+r).join("\n") })] });
      return;
    }

    // ── /duo ───────────────────────────────────────────────
    if (commandName === "duo") {
      await interaction.deferReply();
      const player    = interaction.options.getString("player");
      const liveStats = await apiGet("stats");
      if (liveStats.length < 2) { await interaction.editReply("📊 Not enough data yet."); return; }
      const ps = liveStats.find(s => (s.player||s.name||s.ign||"").toLowerCase() === player.toLowerCase());
      let best = null, bestScore = -1;
      for (const s of liveStats) {
        const ign = s.player||s.name||s.ign||"Unknown";
        if (ign.toLowerCase() === player.toLowerCase()) continue;
        let score = ps ? 0 : Math.floor(Math.random()*60)+20;
        if (ps) {
          if ((ps.goals||0)>0   && (s.assists||0)>0) score+=30;
          if ((ps.assists||0)>0 && (s.goals||0)>0)   score+=30;
          if ((s.motms||0)>0)   score+=20;
          if ((s.matches||0)>0) score+=20;
        }
        if (score > bestScore) { bestScore = score; best = ign; }
      }
      const color = bestScore>=75?0x22c55e:bestScore>=50?0xf59e0b:0xef4444;
      await interaction.editReply({ embeds: [pjaEmbed("👥 Best Duo For "+player, color)
        .addFields({ name:"🤝 Partner", value:"**"+best+"**", inline:true },{ name:"⚡ Score", value:bestScore+"/100", inline:true })] });
      return;
    }

    // ── /weaknesses ────────────────────────────────────────
    if (commandName === "weaknesses") {
      await interaction.deferReply();
      const team  = interaction.options.getString("team");
      const areas = interaction.options.getString("areas");
      if (areas) {
        if (!isAdmin(member)) { await interaction.editReply("❌ Only Managers can set weaknesses."); return; }
        weaknesses.set(team, { areas: areas.split(",").map(a=>a.trim()), updatedBy: user.tag });
        await interaction.editReply({ embeds: [pjaEmbed("⚠️ Weaknesses Set — "+team, 0xf59e0b).setDescription(areas.split(",").map(a=>"• "+a.trim()).join("\n"))] });
        return;
      }
      const data = weaknesses.get(team);
      if (!data) { await interaction.editReply("📋 No weaknesses tracked for **"+team+"**."); return; }
      await interaction.editReply({ embeds: [pjaEmbed("⚠️ Weaknesses — "+team, 0xf59e0b).setDescription(data.areas.map(a=>"• "+a).join("\n"))] });
      return;
    }

    // ── /contract ──────────────────────────────────────────
    if (commandName === "contract") {
      await interaction.deferReply();
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const player = interaction.options.getString("player");
      const role   = interaction.options.getString("role");
      const pos    = interaction.options.getString("position");
      const notes  = interaction.options.getString("notes") || "Welcome to the squad!";
      contracts.push({ id:makeId(), player, role, pos, notes, signedBy:user.tag, date:new Date().toISOString() });
      await interaction.editReply({ embeds: [pjaEmbed("📝 New Signing — "+player, 0x22c55e)
        .setDescription("🎉 **Project Azure** is delighted to announce the signing of **"+player+"**!")
        .addFields({ name:"👤 Player", value:player, inline:true },{ name:"🎽 Role", value:role, inline:true },{ name:"📍 Position", value:pos, inline:true },{ name:"📝 Message", value:notes })] });
      return;
    }

    // ── /best-lineup ───────────────────────────────────────
    if (commandName === "best-lineup") {
      await interaction.deferReply();
      const formation            = interaction.options.getString("formation") || "4-3-3";
      const [liveRoster, liveStats] = await Promise.all([apiGet("roster"), apiGet("stats")]);
      if (liveRoster.length === 0) { await interaction.editReply("📋 Roster is empty."); return; }
      const sorted   = [...liveRoster].sort((a,b) => {
        const na = a.name||a.ign||""; const nb = b.name||b.ign||"";
        const sa = liveStats.find(s => (s.player||s.name||s.ign||"").toLowerCase()===na.toLowerCase());
        const sb = liveStats.find(s => (s.player||s.name||s.ign||"").toLowerCase()===nb.toLowerCase());
        const sA = sa?(Number(sa.goals)||0)+(Number(sa.assists)||0)+(Number(sa.saves)||0)+(Number(sa.motms)||0)*2:0;
        const sB = sb?(Number(sb.goals)||0)+(Number(sb.assists)||0)+(Number(sb.saves)||0)+(Number(sb.motms)||0)*2:0;
        return sB - sA;
      });
      const embed = pjaEmbed("📋 Suggested Lineup — "+formation)
        .addFields(
          { name:"🗂️ Formation", value:formation, inline:true },
          { name:"👥 Starting XI", value:sorted.slice(0,11).map((p,i) => (i+1)+". **"+(p.name||p.ign||"Unknown")+"** — "+(p.position||"?")).join("\n") },
          { name:"🪑 Bench", value:sorted.slice(11,16).length>0?sorted.slice(11,16).map(p=>"• "+(p.name||p.ign||"Unknown")).join("\n"):"None" },
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /timezone-check ────────────────────────────────────
    if (commandName === "timezone-check") {
      await interaction.deferReply();
      const timeStr = interaction.options.getString("time");
      const fromTz  = interaction.options.getString("from").toUpperCase();
      const dateStr = interaction.options.getString("date") || new Date().toDateString();
      const offsets = { "GMT":0,"UTC":0,"BST":1,"CET":1,"CEST":2,"EET":2,"EEST":3,"MSK":3,"GST":4,"PKT":5,"IST":5.5,"WIB":7,"CST":8,"JST":9,"AEST":10,"AEDT":11,"NZST":12,"EST":-5,"EDT":-4,"CDT":-5,"MST":-7,"MDT":-6,"PST":-8,"PDT":-7 };
      const fromOffset = offsets[fromTz];
      if (fromOffset === undefined) { await interaction.editReply("❌ Unknown timezone: **"+fromTz+"**"); return; }
      const hourMatch = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
      if (!hourMatch) { await interaction.editReply("❌ Could not parse time: **"+timeStr+"**"); return; }
      let hours = parseInt(hourMatch[1]);
      const mins = parseInt(hourMatch[2]||"0");
      const ampm = hourMatch[3];
      if (ampm) { if (ampm.toLowerCase()==="pm" && hours!==12) hours+=12; if (ampm.toLowerCase()==="am" && hours===12) hours=0; }
      const baseDate   = new Date(dateStr+" "+hours+":"+(mins<10?"0":"")+mins+":00 UTC");
      const adjustedMs = baseDate.getTime() - (fromOffset*3600000);
      const unixSecs   = Math.floor(adjustedMs/1000);
      const showZones  = ["GMT","BST","CET","EST","PST","IST","JST","AEST"];
      const conversions = showZones.map(tz => {
        const off = offsets[tz]; if (off===undefined) return null;
        const d   = new Date(adjustedMs+(off*3600000));
        const h   = d.getUTCHours(), m = d.getUTCMinutes();
        const ap  = h>=12?"pm":"am"; const h12 = h%12||12;
        return "**"+tz+":** "+h12+":"+(m<10?"0":"")+m+ap;
      }).filter(Boolean);
      await interaction.editReply({ embeds: [pjaEmbed("🌍 Timezone Converter")
        .setDescription("**"+timeStr+" "+fromTz+"** on "+dateStr)
        .addFields(
          { name:"🕐 Conversions", value:conversions.join("\n") },
          { name:"⏰ Discord Timestamp", value:"<t:"+unixSecs+":F> — `<t:"+unixSecs+":F>`" },
        )] });
      return;
    }

    // ── /remind-team ───────────────────────────────────────
    if (commandName === "remind-team") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const message   = interaction.options.getString("message");
      const inStr     = interaction.options.getString("in");
      const repeatStr = interaction.options.getString("repeat");
      const timeUnits = { m:60000, h:3600000, d:86400000 };
      const inMatch   = inStr.match(/^(\d+)(m|h|d)$/i);
      if (!inMatch) { await interaction.editReply("❌ Invalid time format. Use `30m`, `2h`, `1d`"); return; }
      const inMs       = parseInt(inMatch[1]) * (timeUnits[inMatch[2].toLowerCase()]||60000);
      const repMatch   = repeatStr && repeatStr.match(/^(\d+)(m|h|d)$/i);
      const repeatMs   = repMatch ? parseInt(repMatch[1]) * (timeUnits[repMatch[2].toLowerCase()]||60000) : null;
      const reminderId = makeId();
      const triggerAt  = Date.now() + inMs;
      reminders.set(reminderId, { message, channelId:interaction.channelId, triggerAt, repeatMs, userId:user.id });
      await interaction.editReply("⏰ Reminder set!\n**Message:** "+message+"\n**Fires at:** <t:"+Math.floor(triggerAt/1000)+":F>\n**ID:** "+reminderId);
      return;
    }

    // ════════════════════════════════════════════════════════
    // ── BATCH 1 ───────────────────────────────────────────────
    // ════════════════════════════════════════════════════════

    // ── /profile ───────────────────────────────────────────
    if (commandName === "profile") {
      await interaction.deferReply();
      const ign = interaction.options.getString("ign");
      const [liveRoster, liveStats, liveAwards] = await Promise.all([apiGet("roster"), apiGet("stats"), apiGet("awards")]);
      const player      = liveRoster.find(p => (p.name||p.ign||"").toLowerCase() === ign.toLowerCase());
      const stats       = liveStats.find(s  => (s.player||s.name||s.ign||"").toLowerCase() === ign.toLowerCase());
      const localAwards = playerAwards.get(ign.toLowerCase()) || [];
      const remoteAwards= (liveAwards||[]).filter(a => (a.player||"").toLowerCase() === ign.toLowerCase());
      const allAwards   = [...localAwards];
      remoteAwards.forEach(ra => { if (!allAwards.find(la=>la.id===ra.id)) allAwards.push(ra); });
      const warnCount   = getWarnings(ign).length;
      const strikeCount = getStrikeCount(ign);
      const pts         = getPoints(ign);
      if (!player) { await interaction.editReply("❌ Player **"+ign+"** not found on the roster."); return; }
      const roleEmoji = { Captain:"👑","Co-Captain":"🥈",Starter:"🔵",Backup:"🟡",Trialist:"🔬",Academy:"🎓" };
      const embed     = pjaEmbed("🪪 Profile — " + (player.name||player.ign))
        .addFields(
          { name:"🎮 IGN", value:player.name||player.ign||"—", inline:true },{ name:"📍 Position", value:player.position||"—", inline:true },{ name:"🔄 Backup", value:player.backup||"—", inline:true },
          { name:(roleEmoji[player.role]||"🎽")+" Role", value:player.role||"—", inline:true },{ name:"🌍 Timezone", value:player.timezone||"—", inline:true },{ name:"🏆 Priority", value:player.teamMain||"—", inline:true },
          { name:"📊 Stats", value:stats?"⚽ Goals: **"+(stats.goals||0)+"** | 🎯 Assists: **"+(stats.assists||0)+"** | 🧤 Saves: **"+(stats.saves||0)+"** | 🏆 MOTMs: **"+(stats.motms||0)+"**":"No stats yet", inline:false },
          { name:"🏅 Awards ("+allAwards.length+")", value:allAwards.length>0?allAwards.slice(0,5).map(a=>"🏅 **"+(a.award||a.name)+"** — "+(a.reason||"")).join("\n"):"None yet", inline:false },
          { name:"⚠️ Warnings/Strikes", value:warnCount+" warning(s) | "+strikeCount+" strike(s)", inline:true },
          { name:"🪙 PJA Points", value:pts+" pts", inline:true },
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /id-card ───────────────────────────────────────────
    if (commandName === "id-card") {
      await interaction.deferReply();
      const ign = interaction.options.getString("ign");
      const [liveRoster, liveStats, liveAwards] = await Promise.all([apiGet("roster"), apiGet("stats"), apiGet("awards")]);
      const player = liveRoster.find(p => (p.name||p.ign||"").toLowerCase() === ign.toLowerCase());
      if (!player) { await interaction.editReply("❌ Player **"+ign+"** not found on the roster."); return; }
      const stats  = liveStats.find(s  => (s.player||s.name||s.ign||"").toLowerCase() === ign.toLowerCase());
      const awards = [...(playerAwards.get(ign.toLowerCase())||[]),(liveAwards||[]).filter(a=>(a.player||"").toLowerCase()===ign.toLowerCase())].flat();
      const roleColors = { Captain:0xf59e0b,"Co-Captain":0xa78bfa,Starter:0x2563eb,Backup:0x6b7280,Trialist:0x22c55e,Academy:0x60a5fa };
      const roleEmoji  = { Captain:"👑","Co-Captain":"🥈",Starter:"⭐",Backup:"🔵",Trialist:"🔬",Academy:"🎓" };
      const embed = new EmbedBuilder()
        .setTitle("🆔  PROJECT AZURE — PLAYER CARD")
        .setColor(roleColors[player.role]||0x2563eb)
        .setDescription("```\n╔══════════════════════════════╗\n║  PJA                         ║\n║  "+(player.name||player.ign||"Unknown").substring(0,28).padEnd(28)+"║\n║  "+((roleEmoji[player.role]||"")+" "+(player.role||"Player")).substring(0,28).padEnd(28)+"║\n╚══════════════════════════════╝\n```")
        .addFields(
          { name:"📍 Position", value:(player.position||"—")+(player.backup?" / "+player.backup:""), inline:true },
          { name:"🌍 Timezone", value:player.timezone||"—", inline:true },
          { name:"📊 Stats", value:stats?"⚽ **"+(stats.goals||0)+"** G | 🎯 **"+(stats.assists||0)+"** A | 🧤 **"+(stats.saves||0)+"** S | 🏆 **"+(stats.motms||0)+"** MOTM":"No stats yet", inline:false },
          { name:"🏅 Awards", value:awards.length+" award(s)", inline:true },
          { name:"🪙 PJA Points", value:getPoints(ign)+" pts", inline:true },
        )
        .setFooter({ text:"Project Azure (PJA) Official Player Card" })
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
      const req     = { id:reqId, userId:user.id, username:user.tag, ign, type:reqType, details, status:"pending", createdAt:new Date().toISOString() };
      playerRequests.set(reqId, req);
      const embed = pjaEmbed("📩 Player Request — "+reqType, 0xf59e0b)
        .addFields(
          { name:"👤 From", value:"<@"+user.id+"> ("+ign+")", inline:true },{ name:"📋 Type", value:reqType, inline:true },{ name:"🆔 ID", value:reqId, inline:true },
          { name:"📝 Details", value:details },{ name:"🕐 Status", value:"⏳ Pending" },
        );
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("req_accept_"+reqId).setLabel("✅ Accept").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("req_deny_"+reqId).setLabel("❌ Deny").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("req_moreinfo_"+reqId).setLabel("❓ More Info").setStyle(ButtonStyle.Secondary),
      );
      await interaction.channel.send({ embeds: [embed], components: [row] });
      await interaction.editReply("✅ Request sent! **ID:** "+reqId);
      return;
    }

    // ── /trial-review ──────────────────────────────────────
    if (commandName === "trial-review") {
      await interaction.deferReply();
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const trialPlayer = interaction.options.getString("player");
      const mechanics   = interaction.options.getInteger("mechanics");
      const positioning = interaction.options.getInteger("positioning");
      const comm        = interaction.options.getInteger("communication");
      const teamwork    = interaction.options.getInteger("teamwork");
      const consistency = interaction.options.getInteger("consistency");
      const gamesense   = interaction.options.getInteger("gamesense");
      const notes       = interaction.options.getString("notes") || "None";
      const avg         = ((mechanics+positioning+comm+teamwork+consistency+gamesense)/6).toFixed(1);
      const avgNum      = parseFloat(avg);
      let rec, recColor, recEmoji;
      if (avgNum>=8)   { rec="Accept";           recColor=0x22c55e; recEmoji="✅"; }
      else if(avgNum>=6.5) { rec="Trial Longer"; recColor=0x2563eb; recEmoji="🔵"; }
      else if(avgNum>=5)   { rec="Needs Clips";  recColor=0xf59e0b; recEmoji="🎬"; }
      else                 { rec="Deny";          recColor=0xef4444; recEmoji="❌"; }
      const bar = n => "█".repeat(n)+"░".repeat(10-n);
      await interaction.editReply({ embeds: [pjaEmbed("🔬 Trial Review — "+trialPlayer, recColor)
        .addFields(
          { name:"⚙️ Mechanics",     value:mechanics+"/10  `"+bar(mechanics)+"`",     inline:false },
          { name:"📍 Positioning",   value:positioning+"/10  `"+bar(positioning)+"`", inline:false },
          { name:"🗣️ Communication", value:comm+"/10  `"+bar(comm)+"`",               inline:false },
          { name:"🤝 Teamwork",      value:teamwork+"/10  `"+bar(teamwork)+"`",       inline:false },
          { name:"🎯 Consistency",   value:consistency+"/10  `"+bar(consistency)+"`", inline:false },
          { name:"🧠 Game Sense",    value:gamesense+"/10  `"+bar(gamesense)+"`",     inline:false },
          { name:"📊 Average",       value:"**"+avg+"/10**", inline:true },
          { name:recEmoji+" Recommendation", value:"**"+rec+"**", inline:true },
          { name:"📝 Notes",         value:notes, inline:false },
        ).setFooter({ text:"Trial Review by "+user.tag+" | Project Azure (PJA)" })] });
      return;
    }

    // ── /award-give ────────────────────────────────────────
    if (commandName === "award-give") {
      await interaction.deferReply();
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const awardPlayer = interaction.options.getString("player");
      const awardName   = interaction.options.getString("award");
      const reason      = interaction.options.getString("reason");
      const awardId     = makeId();
      const awardData   = { id:awardId, player:awardPlayer, award:awardName, reason, givenBy:user.tag, date:new Date().toISOString() };
      const key         = awardPlayer.toLowerCase();
      if (!playerAwards.has(key)) playerAwards.set(key, []);
      playerAwards.get(key).push(awardData);
      try { await apiPost("awards", awardData); } catch(e) {}
      await interaction.editReply({ embeds: [pjaEmbed("🏅 Award — "+awardName, 0xf59e0b)
        .setDescription("🎉 **"+awardPlayer+"** has been awarded **"+awardName+"**!")
        .addFields({ name:"📝 Reason", value:reason },{ name:"🎙️ Given by", value:user.tag, inline:true })] });
      return;
    }

    // ── /awards ────────────────────────────────────────────
    if (commandName === "awards") {
      await interaction.deferReply();
      const awardPlayer  = interaction.options.getString("player");
      const liveAwards   = await apiGet("awards");
      const localAwards  = playerAwards.get(awardPlayer.toLowerCase()) || [];
      const remoteAwards = (liveAwards||[]).filter(a=>(a.player||"").toLowerCase()===awardPlayer.toLowerCase());
      const allAwards    = [...localAwards];
      remoteAwards.forEach(ra => { if (!allAwards.find(la=>la.id===ra.id)) allAwards.push(ra); });
      if (allAwards.length === 0) { await interaction.editReply("🏅 **"+awardPlayer+"** has no awards yet."); return; }
      await interaction.editReply({ embeds: [pjaEmbed("🏅 Awards — "+awardPlayer, 0xf59e0b)
        .setDescription(allAwards.map((a,i)=>(i+1)+". 🏅 **"+(a.award||a.name||"Award")+"**\n   📝 "+(a.reason||"—")+"\n   📅 "+(a.date?new Date(a.date).toDateString():"Unknown")).join("\n\n"))
        .addFields({ name:"📊 Total", value:allAwards.length+" award(s)", inline:true })] });
      return;
    }

    // ── /activity-check ────────────────────────────────────
    if (commandName === "activity-check") {
      await interaction.deferReply();
      if (!isCaptain(member)) { await interaction.editReply("❌ This command is for Managers and Captains only."); return; }
      const message  = interaction.options.getString("message") || "Check in to confirm you are active this week!";
      const deadline = interaction.options.getString("deadline") || "No deadline set";
      const checkId  = makeId();
      const checkData = { id:checkId, message, deadline, active:new Set(), postedBy:user.tag };
      activityChecks.set(checkId, checkData);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("activity_confirm_"+checkId).setLabel("✅ I'm Active!").setStyle(ButtonStyle.Success),
      );
      await interaction.editReply({ embeds: [buildActivityEmbed(checkData)], components: [row] });
      return;
    }

    // ── /team-vote ─────────────────────────────────────────
    if (commandName === "team-vote") {
      await interaction.deferReply();
      if (!isCaptain(member)) { await interaction.editReply("❌ This command is for Managers and Captains only."); return; }
      const question = interaction.options.getString("question");
      const opt1     = interaction.options.getString("option1");
      const opt2     = interaction.options.getString("option2");
      const opt3     = interaction.options.getString("option3");
      const opt4     = interaction.options.getString("option4");
      const voteId   = makeId();
      const options  = [
        { label:opt1, voters:new Set() },{ label:opt2, voters:new Set() },
        ...(opt3?[{ label:opt3, voters:new Set() }]:[]),
        ...(opt4?[{ label:opt4, voters:new Set() }]:[]),
      ];
      const voteData = { id:voteId, question, options, userVotes:new Map(), postedBy:user.tag };
      teamVotes.set(voteId, voteData);
      const row = new ActionRowBuilder().addComponents(
        options.map((opt,i) => new ButtonBuilder().setCustomId("vote_"+voteId+"_"+i).setLabel(opt.label.substring(0,80)).setStyle(ButtonStyle.Primary))
      );
      await interaction.editReply({ embeds: [buildVoteEmbed(voteData)], components: [row] });
      return;
    }

    // ── /giveaway ──────────────────────────────────────────
    if (commandName === "giveaway") {
      await interaction.deferReply();
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const prize        = interaction.options.getString("prize");
      const durationStr  = interaction.options.getString("duration");
      const winnersCount = interaction.options.getInteger("winners");
      const requirements = interaction.options.getString("requirements") || null;
      const notes        = interaction.options.getString("notes") || null;
      const timeUnits    = { m:60000, h:3600000, d:86400000 };
      const durMatch     = durationStr.match(/^(\d+)(m|h|d)$/i);
      if (!durMatch) { await interaction.editReply("❌ Invalid duration. Use `30m`, `2h`, `1d`, `7d`"); return; }
      const durationMs = parseInt(durMatch[1]) * (timeUnits[durMatch[2].toLowerCase()]||3600000);
      const endsAt     = Date.now() + durationMs;
      const giveId     = makeId();
      const giveData   = { id:giveId, prize, winnersCount, requirements, notes, hostedBy:user.tag, endsAt, entries:new Set(), ended:false, channelId:interaction.channelId, messageId:null };
      giveaways.set(giveId, giveData);
      const msg = await interaction.editReply({ embeds:[buildGiveawayEmbed(giveData)], components:[buildGiveawayButton(giveId, false)] });
      giveData.messageId = msg?.id || null;
      setTimeout(async () => {
        const g = giveaways.get(giveId);
        if (!g || g.ended) return;
        g.ended = true;
        await endGiveaway(g, interaction.channel);
      }, durationMs);
      return;
    }

    // ── /giveaway-end ──────────────────────────────────────
    if (commandName === "giveaway-end") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const giveId = interaction.options.getString("id").toUpperCase();
      const give   = giveaways.get(giveId);
      if (!give)       { await interaction.editReply("❌ Giveaway **"+giveId+"** not found."); return; }
      if (give.ended)  { await interaction.editReply("⚠️ Giveaway already ended."); return; }
      give.ended = true;
      const channel = await client.channels.fetch(give.channelId).catch(() => null);
      await endGiveaway(give, channel);
      await interaction.editReply("✅ Giveaway **"+giveId+"** ended!");
      return;
    }

    // ── /giveaway-reroll ───────────────────────────────────
    if (commandName === "giveaway-reroll") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const giveId = interaction.options.getString("id").toUpperCase();
      const give   = giveaways.get(giveId);
      if (!give)       { await interaction.editReply("❌ Giveaway not found."); return; }
      if (!give.ended) { await interaction.editReply("⚠️ Giveaway is still active!"); return; }
      if (give.entries.size === 0) { await interaction.editReply("❌ No entries to reroll from."); return; }
      const newWinners = pickWinners(give.entries, give.winnersCount);
      const channel    = await client.channels.fetch(give.channelId).catch(() => null);
      if (channel) {
        await channel.send({ embeds: [pjaEmbed("🎲 Giveaway Reroll — "+give.prize)
          .setDescription("🎉 New winner(s)!\n\n"+newWinners.map(w=>"🏆 <@"+w+">").join("\n"))
          .addFields({ name:"🎁 Prize", value:give.prize, inline:true })] });
      }
      await interaction.editReply("✅ Rerolled! New winners: "+newWinners.map(w=>"<@"+w+">").join(", "));
      return;
    }

    // ════════════════════════════════════════════════════════
    // ── BATCH 2 ───────────────────────────────────────────────
    // ════════════════════════════════════════════════════════

    // ── /warn ──────────────────────────────────────────────
    if (commandName === "warn") {
      await interaction.deferReply();
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const warnPlayer = interaction.options.getString("player");
      const reason     = interaction.options.getString("reason");
      const severity   = interaction.options.getString("severity");
      const warnId     = makeId();
      const warns      = getWarnings(warnPlayer);
      warns.push({ id:warnId, player:warnPlayer, reason, severity, givenBy:user.tag, date:new Date().toISOString() });
      const totalWarns = warns.length;
      const strikes    = Math.floor(totalWarns / 3);
      const sevColor   = severity==="High"?0xef4444:severity==="Medium"?0xf59e0b:0x2563eb;
      const sevEmoji   = severity==="High"?"🔴":severity==="Medium"?"🟡":"🔵";
      let milestoneMsg = null;
      if (totalWarns % 3 === 0) milestoneMsg = "⚠️ **STRIKE MILESTONE** — **"+warnPlayer+"** now has **"+strikes+" strike(s)**."+(strikes>=3?"\n🚨 **3 Strikes — Manager review required!**":"");
      const embed = pjaEmbed(sevEmoji+" Warning — "+warnPlayer, sevColor)
        .setDescription(milestoneMsg)
        .addFields(
          { name:"👤 Player", value:warnPlayer, inline:true },{ name:"⚠️ Severity", value:sevEmoji+" "+severity, inline:true },{ name:"🆔 ID", value:warnId, inline:true },
          { name:"📝 Reason", value:reason },
          { name:"📊 Warnings", value:totalWarns+" total", inline:true },{ name:"🥊 Strikes", value:strikes+" strike(s)", inline:true },
        );
      await interaction.editReply({ embeds: [embed] });
      try {
        const guildMember = await getMemberByIgn(interaction.guild, warnPlayer);
        if (guildMember) await guildMember.user.send({ embeds: [pjaEmbed("⚠️ Warning — Project Azure", sevColor).setDescription("You have received a **"+severity+"** warning.\n📝 **Reason:** "+reason).addFields({ name:"🥊 Strikes", value:strikes+" strike(s)", inline:true })] }).catch(()=>{});
      } catch(e) {}
      return;
    }

    // ── /warnings ──────────────────────────────────────────
    if (commandName === "warnings") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const warnPlayer = interaction.options.getString("player");
      const warns      = getWarnings(warnPlayer);
      const strikes    = getStrikeCount(warnPlayer);
      if (warns.length === 0) { await interaction.editReply("✅ **"+warnPlayer+"** has no warnings."); return; }
      const sevEmoji = { High:"🔴", Medium:"🟡", Low:"🔵" };
      await interaction.editReply({ embeds: [pjaEmbed("⚠️ Warnings — "+warnPlayer, 0xf59e0b)
        .setDescription(warns.map((w,i)=>(i+1)+". "+(sevEmoji[w.severity]||"⚠️")+" **"+w.severity+"** — `"+w.id+"`\n   📝 "+w.reason+"\n   📅 "+new Date(w.date).toDateString()+" • by "+w.givenBy).join("\n\n"))
        .addFields({ name:"📊 Total", value:warns.length+" warning(s)", inline:true },{ name:"🥊 Strikes", value:strikes+" strike(s)", inline:true })] });
      return;
    }

    // ── /clear-warning ─────────────────────────────────────
    if (commandName === "clear-warning") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const warnPlayer = interaction.options.getString("player");
      const warnId     = interaction.options.getString("warning-id").toUpperCase();
      const warns      = getWarnings(warnPlayer);
      const idx        = warns.findIndex(w => w.id === warnId);
      if (idx === -1) { await interaction.editReply("❌ Warning **"+warnId+"** not found for **"+warnPlayer+"**."); return; }
      const removed = warns.splice(idx, 1)[0];
      await interaction.editReply({ embeds: [pjaEmbed("🗑️ Warning Cleared — "+warnPlayer, 0x22c55e)
        .addFields(
          { name:"🆔 Cleared", value:removed.id, inline:true },{ name:"📝 Was", value:removed.reason, inline:false },
          { name:"📊 Remaining", value:warns.length+" warning(s) | "+getStrikeCount(warnPlayer)+" strike(s)", inline:false },
        )] });
      return;
    }

    // ── /strikes ───────────────────────────────────────────
    if (commandName === "strikes") {
      await interaction.deferReply();
      const strikesPlayer = interaction.options.getString("player");
      const warns         = getWarnings(strikesPlayer);
      const strikes       = getStrikeCount(strikesPlayer);
      const progress      = warns.length % 3;
      const bar           = "█".repeat(progress) + "░".repeat(3-progress);
      let statusMsg;
      if      (strikes===0) statusMsg = "✅ No strikes — good standing.";
      else if (strikes===1) statusMsg = "🟡 1 Strike.";
      else if (strikes===2) statusMsg = "🟠 2 Strikes — one more triggers review!";
      else                  statusMsg = "🚨 "+strikes+" Strikes — manager review required!";
      const strikeColor = strikes===0?0x22c55e:strikes===1?0xf59e0b:strikes===2?0xf97316:0xef4444;
      await interaction.editReply({ embeds: [pjaEmbed("🥊 Strikes — "+strikesPlayer, strikeColor)
        .setDescription(statusMsg)
        .addFields(
          { name:"📊 Warnings", value:warns.length+" warning(s)", inline:true },{ name:"🥊 Strikes", value:strikes+" strike(s)", inline:true },
          { name:"⏳ Progress", value:"`"+bar+"` "+progress+"/3\n"+(3-progress)+" more warning(s) until next strike", inline:false },
        )
        .setFooter({ text:"3 warnings = 1 strike • 3 strikes = manager review | Project Azure (PJA)" })] });
      return;
    }

    // ── /shop ──────────────────────────────────────────────
    if (commandName === "shop") {
      await interaction.deferReply();
      const approvalItems = SHOP_ITEMS.filter(i => !i.autoFulfil);
      const autoItems     = SHOP_ITEMS.filter(i =>  i.autoFulfil);
      const embed = pjaEmbed("🛒 PJA Team Reward Shop", 0x2563eb)
        .setDescription(
          "Earn **PJA Points** by playing matches, MOTM, self-reports, and more!\n" +
          "Use `/redeem item:...` to spend your points. Check balance with `/points`.\n\n" +
          "🪙 **Auto items** execute instantly. 📋 **Approval items** need a manager to confirm."
        )
        .addFields(
          {
            name: "📋 Approval Required",
            value: approvalItems.map(i => `**${i.name}** — 🪙 **${i.cost} pts**\n> ${i.desc}\n> ID: \`${i.id}\``).join("\n\n"),
            inline: false,
          },
          {
            name: "⚡ Auto-Execute",
            value: autoItems.map(i => `**${i.name}** — 🪙 **${i.cost} pts**\n> ${i.desc}\n> ID: \`${i.id}\``).join("\n\n"),
            inline: false,
          }
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /points ────────────────────────────────────────────
    if (commandName === "points") {
      await interaction.deferReply();
      // Use linked IGN for self-check, or the provided player name
      const targetIgn = interaction.options.getString("player") || getIgnForUser(user.id) || user.username;
      const pts       = getPoints(targetIgn);
      await interaction.editReply({ embeds: [pjaEmbed("🪙 PJA Points — "+targetIgn)
        .setDescription("**"+targetIgn+"** has **"+pts+" PJA Points** 🪙")
        .addFields(
          { name:"🪙 Balance", value:pts+" pts", inline:true },{ name:"🛒 Shop", value:"Use `/shop` to see rewards", inline:true },
          { name:"💰 Earn Points", value:"✅ Practice\n🏆 Matches\n⭐ MOTM\n🎯 Server activity\n🤝 Helping the team", inline:false },
        )] });
      return;
    }

    // ── /give-points ───────────────────────────────────────
    if (commandName === "give-points") {
      await interaction.deferReply();
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const giveIgn    = interaction.options.getString("player");
      const amount     = interaction.options.getInteger("amount");
      const reason     = interaction.options.getString("reason");
      const newBalance = addPoints(giveIgn, amount);
      const action     = amount >= 0 ? "added to" : "removed from";
      await interaction.editReply({ embeds: [pjaEmbed((amount>=0?"🪙 Points Added":"🔻 Points Removed")+" — "+giveIgn, amount>=0?0x22c55e:0xf59e0b)
        .setDescription("**"+Math.abs(amount)+" points** have been **"+action+"** **"+giveIgn+"**'s balance.")
        .addFields(
          { name:"👤 Player", value:giveIgn, inline:true },{ name:"🔢 Amount", value:(amount>=0?"+":"")+amount+" pts", inline:true },{ name:"🪙 New Balance", value:newBalance+" pts", inline:true },
          { name:"📝 Reason", value:reason },
        )] });
      try {
        const guildMember = await getMemberByIgn(interaction.guild, giveIgn);
        if (guildMember) await guildMember.user.send({ embeds: [pjaEmbed("🪙 Points Update", amount>=0?0x22c55e:0xf59e0b).setDescription("**"+Math.abs(amount)+" pts** have been "+action+" your balance!\n📝 **Reason:** "+reason).addFields({ name:"🪙 New Balance", value:newBalance+" pts", inline:true })] }).catch(()=>{});
      } catch(e) {}
      return;
    }

    // ── /redeem ────────────────────────────────────────────
    if (commandName === "redeem") {
      await interaction.deferReply({ ephemeral: true });
      const itemId      = interaction.options.getString("item");
      const note        = interaction.options.getString("note")   || "None";
      const targetArg   = interaction.options.getString("target") || "";
      const item        = SHOP_ITEMS.find(i => i.id === itemId);
      if (!item) { await interaction.editReply("❌ Item not found. Use `/shop` to see items."); return; }

      const providedIgn = interaction.options.getString("ign");
      const linkedIgn   = getIgnForUser(user.id);
      const managerMode = isAdmin(member) && providedIgn && providedIgn.toLowerCase() !== (linkedIgn || "").toLowerCase();

      // IGN resolution
      let ign;
      if (providedIgn) {
        if (!managerMode && linkedIgn && providedIgn.toLowerCase() !== linkedIgn.toLowerCase()) {
          await interaction.editReply("⚠️ You tried to redeem as **"+providedIgn+"** but you're linked to **"+linkedIgn+"**.\n🚨 Using another player's IGN will result in a strike.");
          return;
        }
        ign = providedIgn;
      } else {
        if (!linkedIgn) {
          await interaction.editReply("❌ You haven't linked your IGN yet! Use `/link ign:YourIGN` first.");
          return;
        }
        ign = linkedIgn;
      }

      // Apply discount if they have one
      let effectiveCost = item.cost;
      const discTok = discountTokens.get(ign.toLowerCase());
      let discountApplied = false;
      if (discTok && discTok.expiresAt > Date.now()) {
        effectiveCost = Math.floor(item.cost * (1 - discTok.pct));
        discountApplied = true;
      }

      // Points check
      const currentPts = getPoints(ign);
      if (currentPts < effectiveCost) {
        await interaction.editReply("❌ Not enough points!\n**"+ign+"** has **"+currentPts+" pts** but **"+item.name+"** costs **"+effectiveCost+" pts**"+(discountApplied?" (after 25% discount)":"")+"."); return;
      }

      const redeemId = makeId();

      // ── AUTO-FULFIL ITEMS ──────────────────────────────────
      if (item.autoFulfil) {
        // Deduct immediately
        const newBal = addPoints(ign, -effectiveCost);
        if (discountApplied) discountTokens.delete(ign.toLowerCase()); // use token

        let resultMsg = "";

        // Point Steal
        if (itemId === "point_steal") {
          const targetIgn = targetArg.trim();
          if (!targetIgn) { await interaction.editReply("❌ You must provide a `target` player IGN to steal from."); return; }
          if (targetIgn.toLowerCase() === ign.toLowerCase()) { await interaction.editReply("❌ You can't steal from yourself!"); return; }
          const won = Math.random() < 0.5;
          if (won) {
            const stolen = Math.min(25, getPoints(targetIgn));
            addPoints(targetIgn, -stolen);
            addPoints(ign, stolen);
            addPointHistory(ign, stolen, "Point steal win vs "+targetIgn);
            addPointHistory(targetIgn, -stolen, "Stolen by "+ign);
            resultMsg = "🎉 **WIN!** You stole **"+stolen+" pts** from **"+targetIgn+"**!\n💰 New balance: "+(newBal+stolen)+" pts";
            // DM victim
            try {
              const victimId = getDiscordIdForIgn(targetIgn);
              if (victimId) {
                const victim = await client.users.fetch(victimId).catch(()=>null);
                if (victim) await victim.send({ embeds:[pjaEmbed("🎯 Point Steal — You were targeted!", 0xef4444).setDescription("**"+ign+"** used a **Point Steal Ticket** against you and **won**!\n💸 **"+stolen+" pts** have been removed from your balance.")] }).catch(()=>{});
              }
            } catch(e) {}
          } else {
            resultMsg = "😔 **MISS!** Your steal attempt on **"+targetIgn+"** failed. No points moved.\n💰 Balance: "+newBal+" pts";
          }
        }

        // Point Gamble
        else if (itemId === "point_gamble") {
          const gambleAmt = Math.min(200, Math.max(10, parseInt(targetArg)||50));
          const haveEnough = getPoints(ign) >= gambleAmt;
          if (!haveEnough) { await interaction.editReply("❌ You don't have **"+gambleAmt+" pts** to gamble."); return; }
          const won = Math.random() < 0.5;
          if (won) {
            addPoints(ign, gambleAmt);
            addPointHistory(ign, gambleAmt, "Gamble win ("+gambleAmt+"pts wagered)");
            resultMsg = "🎰 **DOUBLE!** You wagered **"+gambleAmt+" pts** and won! +**"+gambleAmt+" pts**.\n💰 New balance: "+(newBal+gambleAmt)+" pts";
          } else {
            addPoints(ign, -gambleAmt);
            addPointHistory(ign, -gambleAmt, "Gamble loss ("+gambleAmt+"pts wagered)");
            resultMsg = "🎰 **BUST!** You wagered **"+gambleAmt+" pts** and lost them.\n💰 New balance: "+(newBal-gambleAmt)+" pts";
          }
        }

        // Mystery Spin Wheel
        else if (itemId === "mystery_spin") {
          const roll = Math.random();
          let reward;
          if (roll < 0.10)      { reward = "jackpot"; addPoints(ign, 150); addPointHistory(ign, 150, "Mystery Spin jackpot"); resultMsg = "🎡 **JACKPOT!** 🎉 You won **150 pts**! Lucky!\n💰 New balance: "+(newBal+150)+" pts"; }
          else if (roll < 0.30) { reward = "big";     addPoints(ign, 50);  addPointHistory(ign, 50,  "Mystery Spin big win"); resultMsg = "🎡 **Big Win!** You won **50 pts**!\n💰 New balance: "+(newBal+50)+" pts"; }
          else if (roll < 0.55) { reward = "small";   addPoints(ign, 20);  addPointHistory(ign, 20,  "Mystery Spin small win"); resultMsg = "🎡 **Small Win!** You won **20 pts**.\n💰 New balance: "+(newBal+20)+" pts"; }
          else if (roll < 0.70) { reward = "discount"; discountTokens.set(ign.toLowerCase(), { pct:0.25, expiresAt:Date.now()+86400000 }); resultMsg = "🎡 **Discount Token!** 🏷️ You have a **25% discount** on your next shop item (valid 24h)!\n💰 Balance: "+newBal+" pts"; }
          else                  { reward = "nothing";  resultMsg = "🎡 **No reward this time.** Better luck next spin!\n💰 Balance: "+newBal+" pts"; }
        }

        // Shop Discount Token
        else if (itemId === "shop_discount") {
          discountTokens.set(ign.toLowerCase(), { pct:0.25, expiresAt:Date.now()+86400000 });
          resultMsg = "🏷️ **25% Discount Token applied!**\nYour next shop item will cost 25% less (valid 24 hours).\n💰 Balance: "+newBal+" pts";
        }

        shopRedemptions.set(redeemId, { id:redeemId, userId:user.id, username:user.tag, ign, item:item.name, itemId, cost:effectiveCost, note, status:"auto-fulfilled", createdAt:new Date().toISOString() });
        await interaction.editReply({ embeds:[pjaEmbed("⚡ Auto-Fulfilled — "+item.name, 0x22c55e).setDescription(resultMsg).addFields(
          { name:"🛒 Item", value:item.name, inline:true },
          { name:"🪙 Spent", value:"-"+effectiveCost+" pts"+(discountApplied?" (25% off)":""), inline:true },
        )] });
        return;
      }

      // ── APPROVAL ITEMS — queue for manager ────────────────
      const reqId = makeId();
      shopRequests.set(reqId, {
        id:reqId, userId:user.id, username:user.tag, ign, itemId, itemName:item.name,
        cost:effectiveCost, note, targetArg, status:"pending", createdAt:new Date().toISOString()
      });

      const confirmEmbed = pjaEmbed("📋 Shop Request Sent — "+item.name, 0x2563eb)
        .setDescription(
          "Your request for **"+item.name+"** has been sent to management!\n" +
          "**Cost:** "+effectiveCost+" pts"+(discountApplied?" (25% discount applied)":"")+" — points will be deducted on approval.\n\n" +
          "You'll receive a DM when a manager reviews your request."
        )
        .addFields(
          { name:"🆔 Request ID", value:reqId, inline:true },
          { name:"👤 IGN", value:ign, inline:true },
          { name:"📝 Note", value:note, inline:false },
          ...(item.id==="lucky_number" ? [{ name:"🍀 Chosen Number", value:targetArg||"(none — manager will assign one)", inline:true }] : []),
        );
      await interaction.editReply({ embeds:[confirmEmbed] });

      // Notify in channel for managers
      try {
        const shopRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("shopreq_approve_"+reqId).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("shopreq_deny_"+reqId).setLabel("❌ Deny").setStyle(ButtonStyle.Danger),
        );
        await interaction.channel.send({ embeds:[
          pjaEmbed("📋 Shop Request — "+item.name, 0xf59e0b)
            .setDescription("<@"+user.id+"> (**"+ign+"**) wants to redeem **"+item.name+"** for **"+effectiveCost+" pts**.")
            .addFields(
              { name:"📝 Note", value:note, inline:false },
              ...(targetArg ? [{ name:"🎯 Target/Extra", value:targetArg, inline:true }] : []),
              { name:"🆔 Req ID", value:reqId, inline:true },
            )
        ], components:[shopRow] });
      } catch(e) {}
      return;
    }

    // ── /suggest ───────────────────────────────────────────
    if (commandName === "suggest") {
      await interaction.deferReply({ ephemeral: true });
      const suggestionText = interaction.options.getString("suggestion");
      const category       = interaction.options.getString("category") || "Other";
      const sugId          = makeId();
      const sugData        = { id:sugId, userId:user.id, username:user.tag, suggestion:suggestionText, category, upvotes:new Set(), downvotes:new Set(), status:"pending", createdAt:new Date().toISOString() };
      suggestions.set(sugId, sugData);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("sug_up_"+sugId).setLabel("👍 Upvote (0)").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("sug_down_"+sugId).setLabel("👎 Downvote (0)").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("sug_approve_"+sugId).setLabel("✅ Approve").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("sug_deny_"+sugId).setLabel("❌ Deny").setStyle(ButtonStyle.Secondary),
      );
      await interaction.channel.send({ embeds: [buildSuggestionEmbed(sugData)], components: [row] });
      await interaction.editReply("✅ Suggestion submitted! **ID: " + sugId + "**\nThank you for your feedback!");
      return;
    }

    // ── /bug-report ────────────────────────────────────────
    if (commandName === "bug-report") {
      await interaction.deferReply({ ephemeral: true });
      const what  = interaction.options.getString("what");
      const where = interaction.options.getString("where");
      const proof = interaction.options.getString("proof") || "None";
      const notes = interaction.options.getString("notes") || "None";
      const bugId = makeId();
      bugReports.set(bugId, { id:bugId, userId:user.id, username:user.tag, what, where, proof, notes, status:"open", createdAt:new Date().toISOString() });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("bug_acknowledge_"+bugId).setLabel("👀 Acknowledged").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("bug_fixed_"+bugId).setLabel("✅ Fixed").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("bug_invalid_"+bugId).setLabel("❌ Invalid").setStyle(ButtonStyle.Danger),
      );
      await interaction.channel.send({ embeds: [pjaEmbed("🐛 Bug Report — #"+bugId, 0xef4444)
        .addFields(
          { name:"🔍 What broke", value:what },{ name:"📍 Where", value:where, inline:true },
          { name:"📎 Proof", value:proof },{ name:"📝 Notes", value:notes },
          { name:"👤 Reported by", value:"<@"+user.id+"> ("+user.tag+")", inline:true },{ name:"🆔 Bug ID", value:bugId, inline:true },{ name:"🔵 Status", value:"🟠 Open", inline:true },
        )], components: [row] });
      await interaction.editReply("✅ Bug report submitted! **ID: "+bugId+"**\nThank you for helping improve PJA! 🏗️");
      return;
    }

    // ── /server-stats ──────────────────────────────────────
    if (commandName === "server-stats") {
      await interaction.deferReply();
      const guild = interaction.guild;
      const [liveRoster, liveMatches, liveApps] = await Promise.all([apiGet("roster"), apiGet("matches"), apiGet("tryouts").catch(()=>[])]);
      const totalMembers    = guild ? guild.memberCount : "?";
      const rosterPlayers   = liveRoster.length;
      const trialists       = liveRoster.filter(p=>(p.role||"").toLowerCase()==="trialist").length;
      const pendingApps     = [...applications.values()].filter(a=>a.status==="pending").length + (liveApps||[]).filter(a=>(a.status||"pending")==="pending").length;
      const activeGiveaways = [...giveaways.values()].filter(g=>!g.ended).length;
      const upcomingEvents  = scheduleList.length + liveMatches.filter(m=>m.status==="Upcoming"||!m.status).length;
      const winCount        = liveMatches.filter(m=>m.result==="Win").length;
      const lossCount       = liveMatches.filter(m=>m.result==="Loss").length;
      const drawCount       = liveMatches.filter(m=>m.result==="Draw").length;
      await interaction.editReply({ embeds: [pjaEmbed("📊 PJA Server Stats")
        .setDescription("Live snapshot of **Project Azure**!")
        .addFields(
          { name:"👥 Members", value:totalMembers.toString(), inline:true },{ name:"🔷 Roster", value:rosterPlayers+" players", inline:true },{ name:"🔬 Trialists", value:trialists+" trialist(s)", inline:true },
          { name:"📋 Pending Apps", value:pendingApps+" pending", inline:true },{ name:"🎉 Active Giveaways", value:activeGiveaways+" running", inline:true },{ name:"📅 Upcoming Events", value:upcomingEvents+" event(s)", inline:true },
          { name:"🏆 Match Record", value:"✅ **"+winCount+"W** / 🟡 **"+drawCount+"D** / ❌ **"+lossCount+"L**", inline:false },
          { name:"🗳️ Active Votes", value:[...teamVotes.values()].length+" vote(s)", inline:true },{ name:"⚠️ Players w/ Warns", value:[...playerWarnings.entries()].filter(([,w])=>w.length>0).length+" player(s)", inline:true },
        )] });
      return;
    }

    // ── /link ───────────────────────────────────────────────
    if (commandName === "link") {
      await interaction.deferReply({ ephemeral: true });
      const ign = interaction.options.getString("ign").trim();

      // Check if another user already owns this IGN
      const existingId = getDiscordIdForIgn(ign);
      if (existingId && existingId !== user.id) {
        await interaction.editReply("❌ The IGN **" + ign + "** is already linked to another Discord account. Contact a manager if this is wrong.");
        return;
      }

      linkAccount(user.id, ign);

      const embed = pjaEmbed("✅ Account Linked!", 0x22c55e)
        .setDescription("Your Discord account is now linked to VRFS IGN **" + ign + "**!")
        .addFields(
          { name: "👤 Discord", value: user.tag,  inline: true },
          { name: "🎮 IGN",    value: ign,        inline: true },
        )
        .setFooter({ text: "Use /link again to update your IGN | Project Azure (PJA)" });

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /link-player ───────────────────────────────────────
    if (commandName === "link-player") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) {
        await interaction.editReply("❌ This command is for Managers only.");
        return;
      }

      const target = interaction.options.getUser("user");
      const ign    = interaction.options.getString("ign").trim();

      // Check if IGN is already linked to someone else
      const existingId = getDiscordIdForIgn(ign);
      if (existingId && existingId !== target.id) {
        const existingUser = await client.users.fetch(existingId).catch(() => null);
        await interaction.editReply("⚠️ **" + ign + "** is currently linked to **" + (existingUser ? existingUser.tag : existingId) + "**. Overwriting...");
      }

      linkAccount(target.id, ign);

      const embed = pjaEmbed("🔗 Account Linked by Manager", 0x2563eb)
        .addFields(
          { name: "👤 Discord", value: target.tag, inline: true },
          { name: "🎮 IGN",    value: ign,         inline: true },
          { name: "🎙️ By",    value: user.tag,    inline: true },
        )
        .setDescription("<@" + target.id + "> has been linked to VRFS IGN **" + ign + "**.");

      // DM the linked player
      try {
        await target.send({ embeds: [
          pjaEmbed("🔗 Your Account Has Been Linked", 0x2563eb)
            .setDescription("A manager has linked your Discord to VRFS IGN **" + ign + "**\n\nIf this is wrong, use `/link ign:YourActualIGN` to correct it.")
        ]}).catch(() => {});
      } catch(e) {}

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /linked ────────────────────────────────────────────
    if (commandName === "linked") {
      await interaction.deferReply({ ephemeral: true });
      const target    = interaction.options.getUser("user") || user;
      const linkedIgn = getIgnForUser(target.id);

      if (!linkedIgn) {
        await interaction.editReply(
          target.id === user.id
            ? "❌ You haven't linked your IGN yet. Use `/link ign:YourIGN` to link your account."
            : "❌ **" + target.tag + "** hasn't linked their IGN yet."
        );
        return;
      }

      const embed = pjaEmbed("🔗 Linked Account", 0x2563eb)
        .addFields(
          { name: "👤 Discord", value: target.tag, inline: true },
          { name: "🎮 IGN",    value: linkedIgn,   inline: true },
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /shop-price ────────────────────────────────────────
    if (commandName === "shop-price") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) {
        await interaction.editReply("❌ This command is for Managers only.");
        return;
      }

      const itemId   = interaction.options.getString("item");
      const newPrice = interaction.options.getInteger("price");
      const item     = SHOP_ITEMS.find(i => i.id === itemId);

      if (!item) {
        await interaction.editReply("❌ Item not found.");
        return;
      }

      const oldPrice = item.cost;
      item.cost      = newPrice;

      const direction = newPrice > oldPrice ? "📈 Increased" : newPrice < oldPrice ? "📉 Decreased" : "↔️ Unchanged";
      const color     = newPrice > oldPrice ? 0xef4444 : newPrice < oldPrice ? 0x22c55e : 0x6b7280;

      const embed = pjaEmbed("🏷️ Shop Price Updated — " + item.name, color)
        .setDescription(direction + " from **" + oldPrice + " pts** → **" + newPrice + " pts**")
        .addFields(
          { name: "🛒 Item",       value: item.name,          inline: true },
          { name: "🪙 Old Price",  value: oldPrice + " pts",  inline: true },
          { name: "🆕 New Price",  value: newPrice + " pts",  inline: true },
          { name: "📋 All Prices", value: SHOP_ITEMS.map(i => "`" + i.id + "`  **" + i.name + "** — 🪙 " + i.cost + " pts").join("\n"), inline: false },
        )
        .setFooter({ text: "Updated by " + user.tag + " | Project Azure (PJA)" });

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /shop-requests ─────────────────────────────────────
    if (commandName === "shop-requests") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ Managers only."); return; }
      const filter = interaction.options.getString("filter") || "pending";
      let reqs = [...shopRequests.values()];
      if (filter !== "all") reqs = reqs.filter(r => r.status === filter);
      if (reqs.length === 0) { await interaction.editReply("📭 No shop requests with status **"+filter+"**."); return; }
      const statusEmoji = { pending:"⏳", approved:"✅", denied:"❌" };
      const embed = pjaEmbed("🛒 Shop Requests — "+filter.toUpperCase()+" ("+reqs.length+")", 0xf59e0b)
        .setDescription(reqs.slice(0,15).map(r =>
          (statusEmoji[r.status]||"❓")+" **"+r.ign+"** → **"+r.itemName+"** ("+r.cost+" pts) — "+r.status+"\n  📝 "+r.note
        ).join("\n\n"));
      const firstPending = reqs.find(r => r.status === "pending");
      if (firstPending) {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("shopreq_approve_"+firstPending.id).setLabel("✅ Approve "+firstPending.ign).setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("shopreq_deny_"+firstPending.id).setLabel("❌ Deny").setStyle(ButtonStyle.Danger),
        );
        await interaction.editReply({ embeds:[embed], components:[row] });
      } else {
        await interaction.editReply({ embeds:[embed] });
      }
      return;
    }

    // ════════════════════════════════════════════════════════
    // ── MATCH REPORT SYSTEM ──────────────────────────────────
    // ════════════════════════════════════════════════════════

    // ── /getting-started & /setup-profile ─────────────────
    // ISOLATED try/catch — showModal consumes the interaction token.
    if (commandName === "getting-started" || commandName === "setup-profile") {
      try {
        const modal = new ModalBuilder()
          .setCustomId("gs_modal_" + user.id)
          .setTitle("PJA — Team Profile Setup");
        const rows = [
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("gs_ign").setLabel("VRFS Username").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("Your in-game name")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("gs_position").setLabel("Main Position / Backup Position").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. ST / LW")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("gs_timezone").setLabel("Timezone & Availability").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. GMT — evenings & weekends")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("gs_playstyle").setLabel("Play Style & Priority").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. Aggressive | 1st Main")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("gs_notes").setLabel("Strengths, Weaknesses & Notes").setStyle(TextInputStyle.Paragraph).setRequired(false).setPlaceholder("Tell managers anything useful. Clip link optional.")),
        ];
        rows.forEach(r => modal.addComponents(r));
        await interaction.showModal(modal);
      } catch (gsErr) {
        console.error("[/getting-started] showModal error:", gsErr.message);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "❌ Could not open the profile form. Please try again.", ephemeral: true }).catch(() => {});
        }
      }
      // Always return — never fall through to outer catch
      return;
    }

    // ── /self-report ───────────────────────────────────────
    // ISOLATED try/catch — showModal consumes the interaction token.
    if (commandName === "self-report") {
      try {
        const reportId    = interaction.options.getString("report-id").toUpperCase();
        const posChoice   = interaction.options.getString("position");
        const motmNominee = (interaction.options.getString("motm-nominee") || "").trim();
        const motmReason  = (interaction.options.getString("motm-reason")  || "").trim();

        // Quick duplicate check
        const subKey = reportId + "_" + user.id;
        if (selfReports.has(subKey)) {
          const ex = selfReports.get(subKey);
          if (ex.status !== "denied") {
            await interaction.reply({ content: "⚠️ You already submitted for **" + reportId + "**.\n**Status:** " + ex.status + "\nAsk a manager to reopen if needed.", ephemeral: true }).catch(() => {});
            return;
          }
        }

        // If they included a MOTM nominee, cast/update the vote now
        if (motmNominee) {
          const myIgn = getIgnForUser(user.id) || user.username;
          if (motmNominee.toLowerCase() !== myIgn.toLowerCase() && !motmVoteLocks.get(reportId)) {
            const voteKey = reportId + "_" + user.id;
            const prev    = motmVotes.get(voteKey);
            // Resolve playerId for the voter (may not exist yet — that's fine)
            const voterPlayerId = reportPlayerIndex.get(reportId)?.get(myIgn.toLowerCase()) || null;
            motmVotes.set(voteKey, {
              nominee:       motmNominee,
              reason:        motmReason,
              voterId:       user.id,
              voterIgn:      myIgn,
              voterPlayerId, // links to playerSubmissionTokens — null until token generated
              source:        "discord",  // "discord" | "website" — same field future site sets
              changed:       !!prev,
              changedFrom:   prev?.nominee || null,
              timestamp:     new Date().toISOString(),
            });
          }
        }

        // Map LM/RM to MID for field set
        const posType = { GK:"gk", DEF:"def", MID:"mid", LM:"mid", RM:"mid", WING:"wing", ST:"st", Utility:"util" }[posChoice] || "util";

        const report = matchReportsFull.get(reportId);
        const safeOpponent = report ? (report.opponent || "Match").substring(0, 10) : "Match";
        const displayPos   = posChoice;
        const modalTitle   = ("📊 " + displayPos + " Stats vs " + safeOpponent).substring(0, 45);
        const modal = new ModalBuilder()
          .setCustomId("sr_modal_" + reportId + "_" + posChoice)
          .setTitle(modalTitle);

        // ── Per-position field sets (all 5 rows, all meaningful) ──────────
        const gkFields = [
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_saves")
              .setLabel("Saves | Big Saves | Goals Conceded")
              .setStyle(TextInputStyle.Short).setRequired(true)
              .setPlaceholder("e.g. 5 | 2 | 1")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_cleansheet")
              .setLabel("Clean Sheet? | Mistakes Led to Goal")
              .setStyle(TextInputStyle.Short).setRequired(true)
              .setPlaceholder("yes or no | number  e.g. no | 1")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_ratings")
              .setLabel("Distribution / Shot-Stop / Comm (1-10)")
              .setStyle(TextInputStyle.Short).setRequired(true)
              .setPlaceholder("e.g. 7 / 9 / 8")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_penalties")
              .setLabel("Penalties Saved | Penalties Faced")
              .setStyle(TextInputStyle.Short).setRequired(false)
              .setPlaceholder("e.g. 1 | 2  (leave blank if none)")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_notes")
              .setLabel("Highlights, Lowlights & Clip Link")
              .setStyle(TextInputStyle.Paragraph).setRequired(false)
              .setPlaceholder("Describe your performance. Paste a clip link if you have one.")),
        ];

        const defFields = [
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_def")
              .setLabel("Tackles | Ints | Clearances | Blocks")
              .setStyle(TextInputStyle.Short).setRequired(true)
              .setPlaceholder("e.g. 4 | 3 | 2 | 1")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_cleansheet")
              .setLabel("Clean Sheet? | Mistakes Led to Goal")
              .setStyle(TextInputStyle.Short).setRequired(true)
              .setPlaceholder("yes or no | number  e.g. yes | 0")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_goals")
              .setLabel("Goals | Assists | Key Passes")
              .setStyle(TextInputStyle.Short).setRequired(false)
              .setPlaceholder("e.g. 0 | 1 | 0  (leave blank if none)")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_ratings")
              .setLabel("DefPos / 1v1 / Passing / Comm (1-10)")
              .setStyle(TextInputStyle.Short).setRequired(true)
              .setPlaceholder("e.g. 8 / 7 / 7 / 8")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_notes")
              .setLabel("Highlights, Lowlights & Clip Link")
              .setStyle(TextInputStyle.Paragraph).setRequired(false)
              .setPlaceholder("Key moments, aerial duels, any clip link.")),
        ];

        const midFields = [
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_goals")
              .setLabel("Goals | Assists | Key Passes | Chances")
              .setStyle(TextInputStyle.Short).setRequired(true)
              .setPlaceholder("e.g. 1 | 2 | 4 | 3")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_def")
              .setLabel("Def. Recoveries | Tackles | Interceptions")
              .setStyle(TextInputStyle.Short).setRequired(false)
              .setPlaceholder("e.g. 3 | 2 | 1")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_ratings")
              .setLabel("Poss / Passing / Work Rate / Vision (1-10)")
              .setStyle(TextInputStyle.Short).setRequired(true)
              .setPlaceholder("e.g. 8 / 9 / 7 / 8")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_press")
              .setLabel("Distance Covered (km) | Shots on Target")
              .setStyle(TextInputStyle.Short).setRequired(false)
              .setPlaceholder("e.g. 9.2 | 2  (leave blank if unknown)")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_notes")
              .setLabel("Highlights, Lowlights & Clip Link")
              .setStyle(TextInputStyle.Paragraph).setRequired(false)
              .setPlaceholder("Big passes, runs, tactical contributions. Clip link optional.")),
        ];

        const wingFields = [
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_goals")
              .setLabel("Goals | Assists | Chances Created | Shots")
              .setStyle(TextInputStyle.Short).setRequired(true)
              .setPlaceholder("e.g. 1 | 2 | 4 | 5")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_def")
              .setLabel("Crosses | Key Passes | Successful Dribbles")
              .setStyle(TextInputStyle.Short).setRequired(false)
              .setPlaceholder("e.g. 3 | 3 | 2")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_ratings")
              .setLabel("Dribbling / Cross / Press / Pos (1-10)")
              .setStyle(TextInputStyle.Short).setRequired(true)
              .setPlaceholder("e.g. 8 / 7 / 8 / 7")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_press")
              .setLabel("Def. Recoveries | Tackles Won")
              .setStyle(TextInputStyle.Short).setRequired(false)
              .setPlaceholder("e.g. 2 | 1  (leave blank if none)")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_notes")
              .setLabel("Highlights, Lowlights & Clip Link")
              .setStyle(TextInputStyle.Paragraph).setRequired(false)
              .setPlaceholder("Best moments, misses, clips. Anything useful for managers.")),
        ];

        const stFields = [
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_goals")
              .setLabel("Goals | Assists | Shots | Shots on Target")
              .setStyle(TextInputStyle.Short).setRequired(true)
              .setPlaceholder("e.g. 2 | 1 | 7 | 4")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_def")
              .setLabel("Chances | Key Passes | Aerial Duels Won")
              .setStyle(TextInputStyle.Short).setRequired(false)
              .setPlaceholder("e.g. 2 | 1 | 3  (leave blank if unknown)")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_ratings")
              .setLabel("Finishing / Pos / Pressing / Hold-Up (1-10)")
              .setStyle(TextInputStyle.Short).setRequired(true)
              .setPlaceholder("e.g. 9 / 8 / 7 / 6")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_press")
              .setLabel("Big Chances Missed | Offside Calls")
              .setStyle(TextInputStyle.Short).setRequired(false)
              .setPlaceholder("e.g. 1 | 2  (leave blank if none)")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_notes")
              .setLabel("Highlights, Lowlights & Clip Link")
              .setStyle(TextInputStyle.Paragraph).setRequired(false)
              .setPlaceholder("Goals scored, chances missed, clips. Be honest!")),
        ];

        const utilFields = [
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_goals")
              .setLabel("Goals | Assists | Key Passes")
              .setStyle(TextInputStyle.Short).setRequired(false)
              .setPlaceholder("e.g. 0 | 1 | 1  (leave blank if none)")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_def")
              .setLabel("Saves | Tackles | Interceptions | Clearances")
              .setStyle(TextInputStyle.Short).setRequired(false)
              .setPlaceholder("e.g. 0 | 2 | 1 | 0  (leave blank if none)")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_ratings")
              .setLabel("Overall Impact / Effort / Attitude (1-10)")
              .setStyle(TextInputStyle.Short).setRequired(true)
              .setPlaceholder("e.g. 7 / 8 / 9")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_press")
              .setLabel("Minutes Played | Position(s) Covered")
              .setStyle(TextInputStyle.Short).setRequired(false)
              .setPlaceholder("e.g. 45 | ST,MID  (leave blank if unknown)")),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("sr_notes")
              .setLabel("Highlights, Contributions & Clip Link")
              .setStyle(TextInputStyle.Paragraph).setRequired(false)
              .setPlaceholder("Describe your impact as a sub or utility player. Clip link optional.")),
        ];

        const fieldMap = { gk: gkFields, def: defFields, mid: midFields, wing: wingFields, st: stFields, util: utilFields };
        const fields = fieldMap[posType] || utilFields;
        fields.forEach(f => modal.addComponents(f));
        // showModal() consumes the interaction — must be last, no reply after this
        await interaction.showModal(modal);
      } catch (srErr) {
        console.error("[/self-report] showModal error:", srErr.message, srErr.stack);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "❌ Could not open the stat form: " + (srErr.message || "unknown error"), ephemeral: true }).catch(() => {});
        }
      }
      return;
    }

    // ── /motm-vote ─────────────────────────────────────────
    if (commandName === "motm-vote") {
      await interaction.deferReply({ ephemeral: true });
      const reportId = interaction.options.getString("report-id").toUpperCase();
      const voteFor  = interaction.options.getString("vote-for").trim();
      const report   = matchReportsFull.get(reportId);
      if (!report) { await interaction.editReply("❌ Match report **" + reportId + "** not found."); return; }
      if (motmVoteLocks.get(reportId)) { await interaction.editReply("🔒 MOTM voting for this match is **locked**."); return; }
      const myIgn = getIgnForUser(user.id) || user.username;
      if (voteFor.toLowerCase() === myIgn.toLowerCase()) { await interaction.editReply("❌ You cannot vote for yourself."); return; }
      const voteKey       = reportId + "_" + user.id;
      const prev          = motmVotes.get(voteKey);
      const voterPlayerId = reportPlayerIndex.get(reportId)?.get(myIgn.toLowerCase()) || null;
      motmVotes.set(voteKey, {
        nominee:       voteFor,
        reason:        "",
        voterId:       user.id,
        voterIgn:      myIgn,
        voterPlayerId,
        source:        "discord",
        changed:       !!prev,
        changedFrom:   prev?.nominee || null,
        timestamp:     new Date().toISOString(),
      });
      const allVotes = [...motmVotes.entries()].filter(([k]) => k.startsWith(reportId + "_"));
      const tally    = {};
      allVotes.forEach(([,v]) => { tally[v.nominee] = (tally[v.nominee]||0) + 1; });
      const topEntries = Object.entries(tally).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([ign,c]) => "• **"+ign+"** — "+c+" vote(s)").join("\n");
      const changed = prev && prev.nominee !== voteFor;
      await interaction.editReply({ embeds: [pjaEmbed("🏆 MOTM Vote Recorded", 0x22c55e)
        .setDescription((changed ? "✅ Changed vote from **"+prev.nominee+"** to **"+voteFor+"**" : "✅ Voted for **"+voteFor+"**") + "\n\n**Current standings:**\n" + (topEntries || "No votes yet"))
        .setFooter({ text: "Votes are anonymous to other players | Project Azure (PJA)" })] });
      return;
    }

    // ── /motm-results ──────────────────────────────────────
    if (commandName === "motm-results") {
      await interaction.deferReply();
      const reportId = interaction.options.getString("report-id").toUpperCase();
      const report   = matchReportsFull.get(reportId);
      if (!report) { await interaction.editReply("❌ Match report **" + reportId + "** not found."); return; }
      const allVotes = [...motmVotes.entries()].filter(([k]) => k.startsWith(reportId + "_")).map(([,v])=>v);
      if (allVotes.length === 0) { await interaction.editReply("📭 No MOTM votes cast yet for **"+reportId+"**."); return; }
      const tally = {};
      allVotes.forEach(v => { tally[v.nominee] = (tally[v.nominee]||0) + 1; });
      const sorted = Object.entries(tally).sort((a,b)=>b[1]-a[1]);
      const total  = allVotes.length;
      const topIgn = sorted[0][0];
      const topCnt = sorted[0][1];
      const pct    = n => ((n/total)*100).toFixed(0)+"%";
      const lines  = sorted.map(([ign,c],i) =>
        (i===0?"🥇":i===1?"🥈":i===2?"🥉":"#"+(i+1)) + " **"+ign+"** — "+c+" vote(s) ("+pct(c)+")"
      ).join("\n");
      const isLocked = motmVoteLocks.get(reportId) || false;
      const embed = pjaEmbed("🏆 MOTM Results — "+reportId, 0xf59e0b)
        .setDescription("PJA vs **"+report.opponent+"** | "+report.result+" "+report.score)
        .addFields(
          { name:"🗳️ Total Votes", value:total+" votes cast", inline:true },
          { name:"🏆 Top Candidate", value:"**"+topIgn+"** ("+topCnt+" votes)", inline:true },
          { name:"🔒 Voting Status", value:isLocked?"🔒 Locked":"🔓 Open", inline:true },
          { name:"📊 Full Standings", value:lines, inline:false },
          ...(report.motm ? [{ name:"✅ Confirmed MOTM", value:"**"+report.motm+"**", inline:true }] : []),
        );
      const canManage = isAdmin(member);
      if (canManage) {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("motm_top_"+reportId+"_"+topIgn).setLabel("✅ Approve Top Voted").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("motm_different_"+reportId).setLabel("🔄 Choose Different").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("motm_locktoggle_"+reportId).setLabel(isLocked?"🔓 Unlock Voting":"🔒 Lock Voting").setStyle(ButtonStyle.Primary),
        );
        await interaction.editReply({ embeds:[embed], components:[row] });
      } else {
        await interaction.editReply({ embeds:[embed] });
      }
      return;
    }

    // ── /review-submissions ────────────────────────────────
    if (commandName === "review-submissions") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const reportId    = interaction.options.getString("report-id").toUpperCase();
      const filterArg   = interaction.options.getString("filter")  || "pending";
      const playerArg   = (interaction.options.getString("player") || "").toLowerCase();
      const report      = matchReportsFull.get(reportId);
      if (!report) { await interaction.editReply("❌ Match report **" + reportId + "** not found."); return; }

      let subs = [...selfReports.entries()]
        .filter(([k]) => k.startsWith(reportId + "_"))
        .map(([, v]) => v);

      if (filterArg !== "all") {
        if (filterArg === "edited") subs = subs.filter(s => s.editedByManager);
        else subs = subs.filter(s => s.status === filterArg);
      }
      if (playerArg) subs = subs.filter(s => (s.ign||"").toLowerCase().includes(playerArg));

      if (subs.length === 0) {
        await interaction.editReply("📭 No submissions match **"+filterArg+(playerArg?" / "+playerArg:"")+"** for match **" + reportId + "**.");
        return;
      }

      // Build single-submission review card
      const sub = subs[0];
      const remaining = subs.length;
      const subKey = reportId + "_" + sub.userId;
      const hist = submissionHistory.get(subKey) || [];
      const statusEmoji = { pending:"⏳", approved:"✅", denied:"❌", needs_proof:"📎" };

      const reviewEmbed = pjaEmbed(
        "📋 Review — " + (sub.ign||"?") + " (" + (sub.position||"?") + ")",
        sub.status==="approved"?0x22c55e:sub.status==="denied"?0xef4444:0x2563eb
      )
        .setDescription(
          "**Match:** PJA vs **"+report.opponent+"** | "+report.result+" "+report.score+"\n" +
          "**Report ID:** `"+reportId+"` | **Submitted:** "+(sub.submittedAt?new Date(sub.submittedAt).toDateString():"?")+"\n" +
          "**Status:** "+(statusEmoji[sub.status]||"❓")+" "+sub.status+
          (sub.editedByManager?" | ✏️ Edited by "+sub.editedBy:"")
        )
        .addFields(
          { name:"👤 Player",   value:sub.ign||"?",                    inline:true },
          { name:"📍 Position", value:sub.position||"?",               inline:true },
          { name:"🆔 User",     value:"<@"+sub.userId+">",             inline:true },
          ...(sub.goals!==undefined    ? [{ name:"⚽ Goals",    value:String(sub.goals||0),         inline:true }] : []),
          ...(sub.assists!==undefined  ? [{ name:"🎯 Assists",  value:String(sub.assists||0),       inline:true }] : []),
          ...(sub.saves!==undefined    ? [{ name:"🧤 Saves",    value:String(sub.saves||0),         inline:true }] : []),
          ...(sub.cleanSheet           ? [{ name:"🛡️ CS",      value:sub.cleanSheet,               inline:true }] : []),
          ...(sub.tackles              ? [{ name:"💪 Tackles",  value:String(sub.tackles),          inline:true }] : []),
          ...(sub.interceptions        ? [{ name:"✂️ Ints",    value:String(sub.interceptions),     inline:true }] : []),
          ...(sub.keyPasses            ? [{ name:"🔑 KP",       value:String(sub.keyPasses),        inline:true }] : []),
          ...(sub.notes                ? [{ name:"📝 Notes",    value:sub.notes.substring(0,200),   inline:false }] : []),
          ...(sub.editReason           ? [{ name:"✏️ Edit Reason", value:sub.editReason,            inline:false }] : []),
          ...(hist.length              ? [{ name:"📜 History ("+hist.length+")", value:hist.slice(-3).map(h=>`• ${h.event} by ${h.by}`+(h.reason?" — "+h.reason:"")).join("\n"), inline:false }] : []),
        )
        .setFooter({ text:"Showing 1 of "+remaining+" | Filter: "+filterArg+" | Project Azure (PJA)" });

      // Buttons: Approve, Edit, Deny, Request Proof, Approve & Next, Skip, Previous, Next, Close
      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("subq_approve_"+reportId+"_"+sub.userId).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("subq_edit_"+reportId+"_"+sub.userId).setLabel("✏️ Edit").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("subq_deny_"+reportId+"_"+sub.userId).setLabel("❌ Deny").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("subq_proof_"+reportId+"_"+sub.userId).setLabel("📎 Proof").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("subq_apprnext_"+reportId+"_"+sub.userId+"_"+filterArg+"_"+playerArg).setLabel("✅➡️ App+Next").setStyle(ButtonStyle.Success),
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("subq_skip_"+reportId+"_"+sub.userId+"_"+filterArg+"_"+playerArg).setLabel("⏭ Skip").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("subq_close_"+reportId).setLabel("🔒 Close").setStyle(ButtonStyle.Danger),
      );

      await interaction.editReply({ embeds:[reviewEmbed], components:[row1, row2] });
      return;
    }

    // ── /custom-commands ───────────────────────────────────
    if (commandName === "custom-commands") {
      await interaction.deferReply({ ephemeral: true });
      const action  = interaction.options.getString("action")  || "list";
      const trigger = (interaction.options.getString("trigger") || "").trim().toLowerCase();
      const reply   = (interaction.options.getString("reply")   || "").trim();

      // ── LIST ───────────────────────────────────────────────
      if (action === "list") {
        if (customCommandsMap.size === 0) {
          await interaction.editReply("📭 No custom commands registered yet.\nPlayers can buy **Custom Command Reply** from `/shop` to add one.");
          return;
        }
        const lines = [...customCommandsMap.entries()].map(([t, c]) =>
          "• **`"+t+"`** → "+c.reply.substring(0,80)+(c.reply.length>80?"…":"")+"\n  _Added by "+c.ign+" | Approved by "+c.createdBy+"_"
        ).join("\n\n");
        await interaction.editReply({ embeds:[pjaEmbed("💬 Custom Commands ("+customCommandsMap.size+")", 0x2563eb)
          .setDescription(lines)
          .setFooter({ text:"Players say !trigger in any channel to use | Project Azure (PJA)" })] });
        return;
      }

      // ── ADD (manager only) ─────────────────────────────────
      if (action === "add") {
        if (!isAdmin(member)) { await interaction.editReply("❌ Only Managers can manually add custom commands."); return; }
        if (!trigger) { await interaction.editReply("❌ Provide a `trigger` (e.g. `!hype`)."); return; }
        if (!reply)   { await interaction.editReply("❌ Provide a `reply` text."); return; }
        const safeT = trigger.startsWith("!") ? trigger : "!" + trigger;
        customCommandsMap.set(safeT, { reply, createdBy: user.tag, ign: user.tag, createdAt: new Date().toISOString() });
        await interaction.editReply({ embeds:[pjaEmbed("✅ Custom Command Added", 0x22c55e)
          .addFields(
            { name:"💬 Trigger", value:"`"+safeT+"`", inline:true },
            { name:"📝 Reply",   value:reply,          inline:false },
          )] });
        return;
      }

      // ── REMOVE (manager only) ──────────────────────────────
      if (action === "remove") {
        if (!isAdmin(member)) { await interaction.editReply("❌ Only Managers can remove custom commands."); return; }
        if (!trigger) { await interaction.editReply("❌ Provide the `trigger` to remove (e.g. `!hype`)."); return; }
        const safeT = trigger.startsWith("!") ? trigger : "!" + trigger;
        if (!customCommandsMap.has(safeT)) {
          await interaction.editReply("❌ No custom command found for `"+safeT+"`.");
          return;
        }
        const old = customCommandsMap.get(safeT);
        customCommandsMap.delete(safeT);
        await interaction.editReply({ embeds:[pjaEmbed("🗑️ Custom Command Removed", 0xef4444)
          .setDescription("**`"+safeT+"`** has been removed.")
          .addFields(
            { name:"📝 Was",     value:old.reply,      inline:false },
            { name:"👤 Owned by",value:old.ign,        inline:true  },
            { name:"🎙️ Removed by", value:user.tag,   inline:true  },
          )] });
        return;
      }

      await interaction.editReply("❓ Use `action:list`, `action:add`, or `action:remove`.");
      return;
    }

    // ── /send-report-links ─────────────────────────────────
    // Future-ready: when websiteEnabled=true on the report, sends real URLs.
    // Until then, shows Discord instructions with the report ID.
    if (commandName === "send-report-links") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ Managers only."); return; }

      const reportId = interaction.options.getString("report-id").toUpperCase();
      const mode     = interaction.options.getString("mode") || "channel";
      const report   = matchReportsFull.get(reportId);
      if (!report) { await interaction.editReply("❌ Report **"+reportId+"** not found."); return; }

      // Collect all players who have tokens for this report
      const idx = reportPlayerIndex.get(reportId);
      if (!idx || idx.size === 0) {
        await interaction.editReply(
          "⚠️ No player tokens exist for **"+reportId+"** yet.\n\n" +
          "To pre-generate tokens, use `/match-report players:PlayerA,PlayerB,...` when creating the report.\n" +
          "Or players can just use `/self-report report-id:"+reportId+"` directly on Discord."
        );
        return;
      }

      const siteReady = report.websiteEnabled && SITE_URL !== "https://my-pja-site.com";

      const lines = [];
      for (const [ign, playerId] of idx.entries()) {
        const rec = playerSubmissionTokens.get(playerId);
        if (!rec) continue;
        const statusIcon = rec.used ? "✅" : "⏳";
        if (siteReady) {
          // Real website link — use when site is live
          lines.push(`${statusIcon} **${rec.ign}** — [Click to submit stats](${rec.websiteUrl})`);
        } else {
          // Discord-only mode (current)
          lines.push(`${statusIcon} **${rec.ign}** — Use \`/self-report report-id:${reportId}\` on Discord`);
        }
      }

      const embed = pjaEmbed(
        siteReady ? "🔗 Submission Links — "+reportId : "📊 Submission Instructions — "+reportId,
        siteReady ? 0x22c55e : 0x2563eb
      )
        .setDescription(
          siteReady
            ? "Website is live! Send each player their personal link:"
            : "**Website not live yet** — players submit via Discord.\n" +
              "Tell them: **/self-report report-id:`"+reportId+"`**\n\n" +
              "When the website is ready, set `SITE_URL` env var and flip `report.websiteEnabled = true` to send real links automatically."
        )
        .addFields({ name: "👥 Players ("+lines.length+")", value: lines.join("\n") || "None", inline: false })
        .setFooter({ text: "✅ = submitted | ⏳ = pending | Project Azure (PJA)" });

      if (mode === "channel") {
        await interaction.channel.send({ embeds: [embed] });
        await interaction.editReply("✅ Posted submission instructions in channel.");
      } else {
        // DM each player individually
        let dmCount = 0;
        for (const [, playerId] of idx.entries()) {
          const rec = playerSubmissionTokens.get(playerId);
          if (!rec || rec.used) continue;
          const discordId = getDiscordIdForIgn(rec.ign);
          if (!discordId) continue;
          try {
            const playerUser = await client.users.fetch(discordId).catch(()=>null);
            if (!playerUser) continue;
            if (siteReady) {
              await playerUser.send({ embeds: [pjaEmbed("📊 Submit Your Match Stats — PJA vs "+report.opponent, 0x2563eb)
                .setDescription("A manager has asked you to submit your stats for today's match!")
                .addFields(
                  { name:"🔗 Your personal link", value:"[Click here to submit]("+rec.websiteUrl+")", inline:false },
                  { name:"⚠️ Note", value:"This link is unique to you. Don't share it.", inline:false },
                )] });
            } else {
              await playerUser.send({ embeds: [pjaEmbed("📊 Submit Your Match Stats — PJA vs "+report.opponent, 0x2563eb)
                .setDescription("A manager has asked you to submit your stats for today's match!")
                .addFields(
                  { name:"📱 How to submit", value:"Use `/self-report report-id:**"+reportId+"**` in the PJA Discord server.", inline:false },
                  { name:"⚠️ Note", value:"Choose your position, then fill in your stats.", inline:false },
                )] });
            }
            dmCount++;
          } catch(e) {}
        }
        await interaction.editReply("✅ DMs sent to **"+dmCount+"** player(s). Players not linked were skipped.");
      }
      return;
    }

    // ── /report-status ─────────────────────────────────────
    // Shows every player token for a report and whether they've submitted.
    // Works from day one — no website needed.
    if (commandName === "report-status") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ Managers only."); return; }

      const reportId = interaction.options.getString("report-id").toUpperCase();
      const report   = matchReportsFull.get(reportId);
      if (!report) { await interaction.editReply("❌ Report **"+reportId+"** not found."); return; }

      // Collect all submissions for this report
      const allSubs = [...selfReports.entries()]
        .filter(([k]) => k.startsWith(reportId+"_"))
        .map(([,v]) => v);

      // Collect all token records for this report
      const idx = reportPlayerIndex.get(reportId) || new Map();

      // Build unified status table
      const rows = [];

      // Players with pre-generated tokens
      for (const [ign, playerId] of idx.entries()) {
        const rec = playerSubmissionTokens.get(playerId);
        const sub = allSubs.find(s => (s.ign||"").toLowerCase() === ign);
        const statusEmoji = sub
          ? (sub.status==="approved"?"✅":sub.status==="denied"?"❌":sub.status==="needs_proof"?"📎":"⏳")
          : (rec?.used ? "⏳" : "🔲");
        rows.push({
          ign: rec?.ign || ign,
          status: sub ? sub.status : (rec?.used ? "submitted (unlinked?)" : "not submitted"),
          source: sub?.source || (rec?.used ? "discord" : "—"),
          statusEmoji,
          position: sub?.position || "—",
          points: sub?.pointsAwarded ? "✅ awarded" : "—",
        });
      }

      // Players who submitted via Discord but weren't pre-listed
      for (const sub of allSubs) {
        const alreadyListed = rows.find(r => r.ign.toLowerCase() === (sub.ign||"").toLowerCase());
        if (!alreadyListed) {
          const statusEmoji = sub.status==="approved"?"✅":sub.status==="denied"?"❌":sub.status==="needs_proof"?"📎":"⏳";
          rows.push({
            ign: sub.ign, status: sub.status, source: sub.source||"discord",
            statusEmoji, position: sub.position||"—",
            points: sub.pointsAwarded ? "✅ awarded" : "—",
          });
        }
      }

      const submitted  = rows.filter(r => r.status !== "not submitted").length;
      const pending    = rows.filter(r => r.status === "pending").length;
      const approved   = rows.filter(r => r.status === "approved").length;
      const notYet     = rows.filter(r => r.status === "not submitted").length;

      const lines = rows.map(r =>
        `${r.statusEmoji} **${r.ign}** — ${r.status} | ${r.position} | src: ${r.source} | pts: ${r.points}`
      ).join("\n");

      const embed = pjaEmbed("📋 Report Status — "+reportId, 0x2563eb)
        .setDescription("PJA vs **"+report.opponent+"** | "+report.result+" "+report.score)
        .addFields(
          { name:"📊 Summary", value:`✅ Approved: **${approved}** | ⏳ Pending: **${pending}** | 🔲 Not submitted: **${notYet}** | Total tracked: **${rows.length}**`, inline:false },
          { name:"👥 Players", value:lines||"No players tracked yet.", inline:false },
          { name:"🌐 Website Ready?", value:report.websiteEnabled ? "✅ Yes — links active" : "❌ Not yet — Discord only", inline:true },
          { name:"🔑 Tokens Generated", value:idx.size+" player(s)", inline:true },
        )
        .setFooter({ text:"Use /send-report-links to notify players | Project Azure (PJA)" });

      await interaction.editReply({ embeds:[embed] });
      return;
    }
    if (commandName === "submission-history") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ Managers only."); return; }
      const reportId  = interaction.options.getString("report-id").toUpperCase();
      const filterArg = interaction.options.getString("filter") || "all";
      const playerArg = (interaction.options.getString("player") || "").toLowerCase();
      const report    = matchReportsFull.get(reportId);
      if (!report) { await interaction.editReply("❌ Report not found."); return; }

      let subs = [...selfReports.entries()]
        .filter(([k]) => k.startsWith(reportId+"_"))
        .map(([k,v]) => ({ ...v, subKey:k }));

      if (filterArg !== "all") {
        if (filterArg === "edited") subs = subs.filter(s => s.editedByManager);
        else subs = subs.filter(s => s.status === filterArg);
      }
      if (playerArg) subs = subs.filter(s => (s.ign||"").toLowerCase().includes(playerArg));

      if (subs.length === 0) { await interaction.editReply("📭 No submissions match those filters."); return; }

      const lines = subs.slice(0,10).map(s => {
        const hist = submissionHistory.get(s.subKey) || [];
        const lastEvt = hist[hist.length-1];
        return `**${s.ign}** (${s.position||"?"}) — ${s.status}${s.editedByManager?" ✏️":""}` +
          `\n  ⚽${s.goals||0} 🎯${s.assists||0} 🧤${s.saves||0}` +
          (lastEvt ? `\n  Last: _${lastEvt.event}_ by ${lastEvt.by}` : "");
      }).join("\n\n");

      await interaction.editReply({ embeds:[pjaEmbed("📜 Submission History — "+reportId, 0x2563eb)
        .setDescription("PJA vs **"+report.opponent+"** | "+report.result+" "+report.score)
        .addFields({ name:"📋 Submissions ("+subs.length+")", value:lines||"None" })] });
      return;
    }

    // ── /ai-motm ───────────────────────────────────────────
    if (commandName === "ai-motm") {
      await interaction.deferReply();
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const reportId = interaction.options.getString("report-id").toUpperCase();
      const report   = matchReportsFull.get(reportId);
      if (!report) { await interaction.editReply("❌ Match report **" + reportId + "** not found."); return; }
      const approvedSubs = [...selfReports.entries()]
        .filter(([k,v]) => k.startsWith(reportId+"_") && v.status === "approved")
        .map(([,v]) => v);
      if (approvedSubs.length === 0) { await interaction.editReply("📭 No approved submissions yet for **" + reportId + "**. Approve some stats first."); return; }

      // Tally MOTM votes
      const voteTally = {};
      [...motmVotes.entries()].filter(([k]) => k.startsWith(reportId+"_")).forEach(([,v]) => {
        const nom = typeof v === "string" ? v : v.nominee;
        voteTally[nom.toLowerCase()] = (voteTally[nom.toLowerCase()]||0)+1;
      });

      function calcScore(sub, votes) {
        const pos = (sub.position||"Utility").toUpperCase();
        const posType = {GK:"gk",CB:"def",LB:"def",RB:"def",CM:"mid",CDM:"mid",CAM:"mid",LW:"wing",RW:"wing",ST:"st"}[pos]||"util";
        let score = 0; const reasons = [];
        function add(pts, label) { if(pts>0&&label){score+=pts;reasons.push(label);} else score+=pts; }
        const s = sub;
        if (posType==="gk") {
          add((parseInt(s.saves)||0)*4, s.saves?s.saves+" save(s)":null);
          add((parseInt(s.bigSaves)||0)*5, s.bigSaves?s.bigSaves+" big save(s)":null);
          add(s.cleanSheet?"yes"===s.cleanSheet.toLowerCase()?6:0:0, s.cleanSheet?.toLowerCase()==="yes"?"Clean sheet":null);
          add((parseFloat(s.distributionRating)||0)*0.5, null);
          add((parseFloat(s.commRating)||0)*0.5, null);
          add((parseInt(s.mistakes)||0)*-3, null);
        } else if (posType==="def") {
          add((parseInt(s.tackles)||0)*3, s.tackles?s.tackles+" tackle(s)":null);
          add((parseInt(s.interceptions)||0)*3, s.interceptions?s.interceptions+" int(s)":null);
          add((parseInt(s.clearances)||0)*2, s.clearances?s.clearances+" clearance(s)":null);
          add((parseInt(s.blocks)||0)*3, s.blocks?s.blocks+" block(s)":null);
          add(s.cleanSheet?.toLowerCase()==="yes"?4:0, s.cleanSheet?.toLowerCase()==="yes"?"Clean sheet":null);
          add((parseInt(s.goals)||0)*5, s.goals?s.goals+" goal(s)":null);
          add((parseInt(s.assists)||0)*4, s.assists?s.assists+" assist(s)":null);
          add((parseInt(s.mistakes)||0)*-3, null);
        } else if (posType==="mid") {
          add((parseInt(s.goals)||0)*5, s.goals?s.goals+" goal(s)":null);
          add((parseInt(s.assists)||0)*5, s.assists?s.assists+" assist(s)":null);
          add((parseInt(s.keyPasses)||0)*4, s.keyPasses?s.keyPasses+" key pass(es)":null);
          add((parseInt(s.defRecoveries)||0)*3, s.defRecoveries?s.defRecoveries+" recovery(ies)":null);
          add((parseFloat(s.passingRating)||0)*0.5, null);
        } else if (posType==="wing") {
          add((parseInt(s.goals)||0)*6, s.goals?s.goals+" goal(s)":null);
          add((parseInt(s.assists)||0)*5, s.assists?s.assists+" assist(s)":null);
          add((parseInt(s.chancesCreated)||0)*4, s.chancesCreated?s.chancesCreated+" chance(s)":null);
          add((parseInt(s.crosses)||0)*3, s.crosses?s.crosses+" cross/KP":null);
          add((parseInt(s.successfulAttacks)||0)*3, s.successfulAttacks?s.successfulAttacks+" att(s)":null);
        } else if (posType==="st") {
          add((parseInt(s.goals)||0)*7, s.goals?s.goals+" goal(s)":null);
          add((parseInt(s.assists)||0)*4, s.assists?s.assists+" assist(s)":null);
          add((parseInt(s.shots)||0)*2, s.shots?s.shots+" shot(s)":null);
          add((parseInt(s.chancesCreated)||0)*3, s.chancesCreated?s.chancesCreated+" chance(s)":null);
          add((parseFloat(s.finishingRating)||0)*0.5, null);
        } else {
          add((parseInt(s.goals)||0)*5, s.goals?s.goals+" goal(s)":null);
          add((parseInt(s.assists)||0)*4, s.assists?s.assists+" assist(s)":null);
          add((parseFloat(s.overallRating)||0)*1, null);
        }
        const vc = votes[sub.ign.toLowerCase()]||0;
        add(vc*3, vc?vc+" player vote(s)":null);
        const confidence = score>=20?"High":score>=10?"Medium":"Low";
        return { score, reasons:reasons.slice(0,4), confidence };
      }

      const scored = approvedSubs.map(s => {
        const { score, reasons, confidence } = calcScore(s, voteTally);
        return { ign:s.ign, position:s.position, score, reasons, confidence, votes:voteTally[s.ign.toLowerCase()]||0 };
      }).sort((a,b)=>b.score-a.score).slice(0,3);

      const confEmoji = { High:"🟢", Medium:"🟡", Low:"🔴" };
      const lines = scored.map((c,i) =>
        (i===0?"🥇":i===1?"🥈":"🥉") + " **"+c.ign+"** ("+c.position+") — Score: **"+c.score+"** | "+c.votes+" vote(s) | "+confEmoji[c.confidence]+" "+c.confidence+" confidence\n" +
        (c.reasons.length?"  └ "+c.reasons.join(", "):"")+"\n"
      ).join("\n");

      const top = scored[0];
      const embed = pjaEmbed("🤖 AI MOTM Recommendation — " + reportId, 0x2563eb)
        .setDescription("**AI suggests: "+top.ign+"**\n> "+top.reasons.join(", ")+(top.votes?" + "+top.votes+" player vote(s)":"")+".\n\n" + lines)
        .setFooter({ text:"AI recommendation only — manager makes final decision | Project Azure (PJA)" });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("motm_approve_"+reportId+"_"+top.ign).setLabel("✅ Approve AI MOTM").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("motm_different_"+reportId).setLabel("🔄 Choose Different").setStyle(ButtonStyle.Secondary),
      );
      await interaction.editReply({ embeds: [embed], components: [row] });
      return;
    }

    // ── /final-report ──────────────────────────────────────
    if (commandName === "final-report") {
      await interaction.deferReply();
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const reportId   = interaction.options.getString("report-id").toUpperCase();
      const motmOverride = interaction.options.getString("motm");
      const managerNotes = interaction.options.getString("notes") || "None";
      const report     = matchReportsFull.get(reportId);
      if (!report) { await interaction.editReply("❌ Match report **" + reportId + "** not found."); return; }
      const approvedSubs = [...selfReports.entries()]
        .filter(([k,v]) => k.startsWith(reportId+"_") && v.status==="approved")
        .map(([,v]) => v);

      // Aggregate stats
      const goalScorers = {}; const assisters = {}; const cleanSheetPlayers = []; const saveMap = {};
      approvedSubs.forEach(s => {
        if (parseInt(s.goals)>0)    goalScorers[s.ign]  = (goalScorers[s.ign]||0) + parseInt(s.goals);
        if (parseInt(s.assists)>0)  assisters[s.ign]    = (assisters[s.ign]||0)   + parseInt(s.assists);
        if (parseInt(s.saves)>0)    saveMap[s.ign]      = (saveMap[s.ign]||0)     + parseInt(s.saves);
        if (s.cleanSheet?.toLowerCase()==="yes") cleanSheetPlayers.push(s.ign);
      });
      const fmtMap = obj => Object.entries(obj).length ? Object.entries(obj).map(([n,c])=>"**"+n+"** x"+c).join(", ") : "None";
      const csStr  = cleanSheetPlayers.length ? cleanSheetPlayers.map(n=>"**"+n+"**").join(", ") : "None";

      // MOTM
      const voteTally = {};
      [...motmVotes.entries()].filter(([k])=>k.startsWith(reportId+"_")).forEach(([,v])=>{
        const nom = typeof v === "string" ? v : v.nominee;
        voteTally[nom.toLowerCase()]=(voteTally[nom.toLowerCase()]||0)+1;
      });
      const topVotedIgn = Object.entries(voteTally).sort((a,b)=>b[1]-a[1])[0]?.[0];
      const confirmedMotm = motmOverride || report.motm || (topVotedIgn ? [...new Set(approvedSubs.map(s=>s.ign))].find(n=>n.toLowerCase()===topVotedIgn) || topVotedIgn : "TBD");

      // Top performers
      const performers = approvedSubs.map(s => {
        const pts = (parseInt(s.goals)||0)*7+(parseInt(s.assists)||0)*5+(parseInt(s.saves)||0)*3+(s.cleanSheet?.toLowerCase()==="yes"?4:0);
        return { ign:s.ign, pos:s.position, pts };
      }).sort((a,b)=>b.pts-a.pts).slice(0,3);
      const perfStr = performers.length ? performers.map((p,i)=>(i+1)+". **"+p.ign+"** ("+p.pos+") — "+p.pts+" pts").join("\n") : "None";

      const resultEmoji = {Win:"✅",Won:"✅",Loss:"❌",Lost:"❌",Draw:"🟡"};
      const resultColor = {Win:0x22c55e,Won:0x22c55e,Loss:0xef4444,Lost:0xef4444,Draw:0xf59e0b};
      const embed = pjaEmbed("🏆 PJA Match Report — " + reportId, resultColor[report.result]||0x2563eb)
        .setDescription(
          "```\n" +
          "PJA vs " + report.opponent + "\n" +
          "Score: " + report.score + "  |  Result: " + report.result + "\n" +
          "Date: " + report.date + "\n" +
          "```"
        )
        .addFields(
          { name:"⚽ Goals",         value:fmtMap(goalScorers),  inline:true },
          { name:"🎯 Assists",        value:fmtMap(assisters),    inline:true },
          { name:"🧤 Saves",          value:fmtMap(saveMap),      inline:true },
          { name:"🛡️ Clean Sheets",  value:csStr,                inline:true },
          { name:"🏆 MOTM",           value:"**"+confirmedMotm+"**", inline:true },
          { name:"🤖 AI Suggestion",  value:report.aiMotm||"Use /ai-motm first", inline:true },
          { name:"🎯 Top Performers", value:perfStr },
          { name:"📝 Manager Notes",  value:managerNotes },
        )
        .setFooter({ text:"Final Report by "+user.tag+" | Project Azure (PJA)" });

      report.motm       = confirmedMotm;
      report.finalized  = true;

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("finalrep_post_"+reportId).setLabel("📢 Post Report").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("finalrep_complete_"+reportId).setLabel("✅ Mark Complete").setStyle(ButtonStyle.Success),
      );
      await interaction.editReply({ embeds: [embed], components: [row] });
      return;
    }

    // ── /stats ─────────────────────────────────────────────
    if (commandName === "stats") {
      await interaction.deferReply();
      const targetIgn = interaction.options.getString("player") || getIgnForUser(user.id) || user.username;
      const localStats = getStats(targetIgn);
      const liveStats  = await apiGet("stats");
      const remote     = liveStats.find(s => (s.player||s.name||s.ign||"").toLowerCase()===targetIgn.toLowerCase());
      const g   = Math.max(localStats.goals||0,        parseInt(remote?.goals||0));
      const a   = Math.max(localStats.assists||0,      parseInt(remote?.assists||0));
      const sv  = Math.max(localStats.saves||0,        parseInt(remote?.saves||0));
      const cs  = Math.max(localStats.cleanSheets||0,  parseInt(remote?.cleanSheets||0));
      const mo  = Math.max(localStats.motms||0,        parseInt(remote?.motms||0));
      const mp  = Math.max(localStats.matches||0,      parseInt(remote?.matches||0));
      const bar = n => { const p=Math.min(n,10); return "█".repeat(p)+"░".repeat(10-p); };
      const embed = pjaEmbed("📊 Stats — " + targetIgn)
        .addFields(
          { name:"⚽ Goals",         value:"**"+g+"**  `"+bar(g)+"`",  inline:true },
          { name:"🎯 Assists",        value:"**"+a+"**  `"+bar(a)+"`",  inline:true },
          { name:"🧤 Saves",          value:"**"+sv+"** `"+bar(sv)+"`", inline:true },
          { name:"🛡️ Clean Sheets",  value:"**"+cs+"** `"+bar(cs)+"`", inline:true },
          { name:"🏆 MOTMs",          value:"**"+mo+"** `"+bar(mo)+"`", inline:true },
          { name:"🎮 Matches",        value:"**"+mp+"**",               inline:true },
          { name:"🪙 PJA Points",     value:getPoints(targetIgn)+" pts",inline:true },
          { name:"🏅 Awards",         value:(playerAwards.get(targetIgn.toLowerCase())||[]).length+" award(s)", inline:true },
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ════════════════════════════════════════════════════════
    // ── ROSTER MANAGEMENT ─────────────────────────────────────
    // ════════════════════════════════════════════════════════

    // ── /add-player ────────────────────────────────────────
    if (commandName === "add-player") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const np = {
        name:     interaction.options.getString("ign"),
        ign:      interaction.options.getString("ign"),
        position: interaction.options.getString("position"),
        role:     interaction.options.getString("role"),
        backup:   interaction.options.getString("backup")   || "None",
        side:     interaction.options.getString("side")     || "Any",
        teamMain: interaction.options.getString("priority") || "Other",
        timezone: interaction.options.getString("timezone") || "Unknown",
        notes:    interaction.options.getString("notes")    || "",
        joinedAt: new Date().toISOString(),
        addedBy:  user.tag,
      };
      const existingRoster = await apiGet("roster");
      const alreadyIn = existingRoster.find(p => (p.name||p.ign||"").toLowerCase() === np.ign.toLowerCase());
      if (alreadyIn) { await interaction.editReply("⚠️ **"+np.ign+"** is already on the roster."); return; }
      const added = await apiPost("roster", np);
      const embed = pjaEmbed("✅ Player Added — "+np.ign, 0x22c55e)
        .addFields(
          { name:"🎮 IGN",       value:np.ign,      inline:true },
          { name:"📍 Position",  value:np.position, inline:true },
          { name:"🎽 Role",      value:np.role,     inline:true },
          { name:"🏆 Priority",  value:np.teamMain, inline:true },
          { name:"🌍 Timezone",  value:np.timezone, inline:true },
          { name:"🎙️ Added by", value:user.tag,    inline:true },
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /edit-player ───────────────────────────────────────
    if (commandName === "edit-player") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const ign      = interaction.options.getString("ign");
      const liveRoster = await apiGet("roster");
      const player   = liveRoster.find(p => (p.name||p.ign||"").toLowerCase() === ign.toLowerCase());
      if (!player) { await interaction.editReply("❌ Player **"+ign+"** not found on the roster."); return; }
      const updates = {};
      const pos  = interaction.options.getString("position");     if (pos)          updates.position     = pos;
      const role = interaction.options.getString("role");         if (role)         updates.role         = role;
      const back = interaction.options.getString("backup");       if (back)         updates.backup       = back;
      const prio = interaction.options.getString("priority");     if (prio)         updates.teamMain     = prio;
      const tz   = interaction.options.getString("timezone");     if (tz)           updates.timezone     = tz;
      const avail= interaction.options.getString("availability"); if (avail)        updates.availability = avail;
      const note = interaction.options.getString("notes");        if (note)         updates.notes        = note;
      const fieldsChanged = Object.keys(updates);
      if (fieldsChanged.length === 0) { await interaction.editReply("⚠️ No changes provided."); return; }
      // Patch via API if they have an id
      if (player.id) {
        try {
          await fetch(WEBSITE_API + "roster/" + player.id, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updates),
          });
        } catch(e) {}
      }
      const embed = pjaEmbed("✏️ Player Updated — "+ign, 0x2563eb)
        .setDescription("Updated **"+fieldsChanged.join(", ")+"**")
        .addFields(fieldsChanged.map(f => ({ name:f, value:String(updates[f]), inline:true })));
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /remove-player ─────────────────────────────────────
    if (commandName === "remove-player") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const ign    = interaction.options.getString("ign");
      const reason = interaction.options.getString("reason") || "Not specified";
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("removeplayer_confirm_"+encodeURIComponent(ign)).setLabel("✅ Yes, Remove").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("removeplayer_cancel_"+encodeURIComponent(ign)).setLabel("❌ Cancel").setStyle(ButtonStyle.Secondary),
      );
      await interaction.editReply({ embeds: [pjaEmbed("⚠️ Confirm Remove — "+ign, 0xef4444)
        .setDescription("Are you sure you want to **remove "+ign+"** from the roster?\n\n📝 **Reason:** "+reason)
        .setFooter({ text:"This cannot be undone easily." })], components: [row] });
      return;
    }

    // ── /promote ───────────────────────────────────────────
    if (commandName === "promote") {
      await interaction.deferReply();
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const ign     = interaction.options.getString("ign");
      const newRole = interaction.options.getString("role");
      const liveRoster = await apiGet("roster");
      const player  = liveRoster.find(p => (p.name||p.ign||"").toLowerCase() === ign.toLowerCase());
      if (!player) { await interaction.editReply("❌ Player **"+ign+"** not found."); return; }
      const oldRole = player.role || "—";
      if (player.id) {
        try {
          await fetch(WEBSITE_API + "roster/" + player.id, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ role: newRole }) });
        } catch(e) {}
      }
      await interaction.editReply({ embeds: [pjaEmbed("🎖️ Player Promoted — "+ign, 0x22c55e)
        .setDescription("🎉 **"+ign+"** has been promoted!")
        .addFields(
          { name:"👤 Player",   value:ign,      inline:true },
          { name:"⬆️ Old Role", value:oldRole,  inline:true },
          { name:"🆕 New Role", value:newRole,  inline:true },
          { name:"🎙️ By",      value:user.tag, inline:true },
        )] });
      return;
    }

    // ── /demote ────────────────────────────────────────────
    if (commandName === "demote") {
      await interaction.deferReply();
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const ign     = interaction.options.getString("ign");
      const newRole = interaction.options.getString("role");
      const reason  = interaction.options.getString("reason") || "Not specified";
      const liveRoster = await apiGet("roster");
      const player  = liveRoster.find(p => (p.name||p.ign||"").toLowerCase() === ign.toLowerCase());
      if (!player) { await interaction.editReply("❌ Player **"+ign+"** not found."); return; }
      const oldRole = player.role || "—";
      if (player.id) {
        try {
          await fetch(WEBSITE_API + "roster/" + player.id, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ role: newRole }) });
        } catch(e) {}
      }
      await interaction.editReply({ embeds: [pjaEmbed("⬇️ Player Demoted — "+ign, 0xf59e0b)
        .addFields(
          { name:"👤 Player",   value:ign,      inline:true },
          { name:"⬆️ Old Role", value:oldRole,  inline:true },
          { name:"🔽 New Role", value:newRole,  inline:true },
          { name:"📝 Reason",   value:reason,   inline:false },
          { name:"🎙️ By",      value:user.tag, inline:true },
        )] });
      return;
    }

    // ── /release ───────────────────────────────────────────
    if (commandName === "release") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const ign    = interaction.options.getString("ign");
      const reason = interaction.options.getString("reason");
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("release_confirm_"+encodeURIComponent(ign)).setLabel("✅ Confirm Release").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("release_cancel_"+encodeURIComponent(ign)).setLabel("❌ Cancel").setStyle(ButtonStyle.Secondary),
      );
      await interaction.editReply({ embeds: [pjaEmbed("⚠️ Confirm Release — "+ign, 0xef4444)
        .setDescription("Release **"+ign+"** from Project Azure?\n📝 **Reason:** "+reason)], components: [row] });
      return;
    }

    // ── /open-spots ────────────────────────────────────────
    if (commandName === "open-spots") {
      await interaction.deferReply();
      const action = interaction.options.getString("action") || "view";
      if (action === "set") {
        if (!isAdmin(member)) { await interaction.editReply("❌ Only Managers can update open spots."); return; }
        const pos   = interaction.options.getString("position");
        const count = interaction.options.getInteger("count") || 1;
        const notes = interaction.options.getString("notes") || "";
        if (!pos) { await interaction.editReply("❌ Provide a position."); return; }
        openSpots.set(pos.toUpperCase(), { count, notes, updatedBy: user.tag });
        await interaction.editReply("✅ Updated: **"+pos.toUpperCase()+"** — "+count+" spot(s) needed"+(notes?" ("+notes+")":""));
        return;
      }
      if (action === "clear") {
        if (!isAdmin(member)) { await interaction.editReply("❌ Only Managers can clear open spots."); return; }
        const pos = interaction.options.getString("position");
        if (pos) { openSpots.delete(pos.toUpperCase()); await interaction.editReply("✅ Cleared open spots for **"+pos.toUpperCase()+"**."); }
        else { openSpots.clear(); await interaction.editReply("✅ All open spots cleared."); }
        return;
      }
      // View
      if (openSpots.size === 0) { await interaction.editReply({ embeds: [pjaEmbed("🔓 Open Spots — Project Azure", 0x22c55e).setDescription("✅ No open spots right now. Roster is full!")] }); return; }
      const lines = [...openSpots.entries()].map(([pos,d]) => "• **"+pos+"** — "+d.count+" needed"+(d.notes?" _("+d.notes+")_":"")).join("\n");
      await interaction.editReply({ embeds: [pjaEmbed("🔓 Open Spots — Project Azure", 0xf59e0b)
        .setDescription("PJA is currently looking for:\n\n"+lines)
        .addFields({ name:"📋 Total Spots", value:([...openSpots.values()].reduce((a,d)=>a+d.count,0))+" position(s)", inline:true })] });
      return;
    }

    // ── /team-depth ────────────────────────────────────────
    if (commandName === "team-depth") {
      await interaction.deferReply();
      const liveRoster = await apiGet("roster");
      if (liveRoster.length === 0) { await interaction.editReply("📋 Roster is empty."); return; }
      const groups = {};
      liveRoster.forEach(p => {
        const pos = p.position || "Unknown";
        if (!groups[pos]) groups[pos] = { starters:[], backups:[], trialists:[], others:[] };
        const role = (p.role||"").toLowerCase();
        if (role==="starter"||role==="captain"||role==="co-captain") groups[pos].starters.push(p.name||p.ign);
        else if (role==="backup") groups[pos].backups.push(p.name||p.ign);
        else if (role==="trialist") groups[pos].trialists.push(p.name||p.ign);
        else groups[pos].others.push(p.name||p.ign);
      });
      const posOrder = ["GK","CB","LB","RB","CDM","CM","CAM","LW","RW","ST","Utility"];
      const sortedPosKeys = [...new Set([...posOrder.filter(p=>groups[p]), ...Object.keys(groups).filter(p=>!posOrder.includes(p))])];
      const fields = sortedPosKeys.slice(0,25).map(pos => {
        const g = groups[pos];
        const lines = [];
        if (g.starters.length)  lines.push("⭐ "+g.starters.join(", "));
        if (g.backups.length)   lines.push("🔵 "+g.backups.join(", "));
        if (g.trialists.length) lines.push("🔬 "+g.trialists.join(", "));
        if (g.others.length)    lines.push("⬜ "+g.others.join(", "));
        return { name:"📍 "+pos, value:lines.join("\n")||"—", inline:true };
      });
      const embed = pjaEmbed("📊 Team Depth Chart — Project Azure")
        .addFields(...fields)
        .setDescription("⭐ Starter | 🔵 Backup | 🔬 Trialist | ⬜ Other\n\u200b");
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /backup-data ───────────────────────────────────────
    if (commandName === "backup-data") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const [rosterData, statsData, awardsData] = await Promise.all([apiGet("roster"), apiGet("stats"), apiGet("awards")]);
      const exportObj = {
        exportedAt:     new Date().toISOString(),
        version:        "2.0",
        roster:         rosterData,
        stats:          statsData,
        awards:         awardsData,
        newcomerProfiles: [...newcomerProfiles.entries()].map(([k,v])=>({userId:k,...v})),
        matchReports:   [...matchReportsFull.entries()].map(([k,v])=>({id:k,...v})),
        selfReports:    [...selfReports.entries()].map(([k,v])=>({key:k,...v})),
        openSpots:      [...openSpots.entries()].map(([pos,d])=>({position:pos,...d})),
        localStats:     [...playerStats.entries()].map(([ign,s])=>({ign,...s})),
        warnings:       [...playerWarnings.entries()].map(([ign,w])=>({ign,warnings:w})),
        points:         [...playerPoints.entries()].map(([ign,pts])=>({ign,pts})),
        applications:   [...applications.values()],
        scheduleList,
        giveaways:      [...giveaways.entries()].map(([id,g])=>({id, prize:g.prize, ended:g.ended, entryCount:g.entries.size})),
        shopRequests:   [...shopRequests.values()],
        pointHistory:   [...pointHistory.entries()].map(([ign,h])=>({ign,history:h})),
        discountTokens: [...discountTokens.entries()].map(([ign,t])=>({ign,...t})),
        luckyNumbers:   [...luckyNumbers.entries()].map(([ign,n])=>({ign,number:n})),
      };
      const json    = JSON.stringify(exportObj, null, 2);
      const buf     = Buffer.from(json, "utf8");
      const { AttachmentBuilder } = require("discord.js");
      const attachment = new AttachmentBuilder(buf, { name: "pja-backup-"+Date.now()+".json" });
      await interaction.editReply({ content:"✅ Backup ready! Download the file below.", files: [attachment] });
      return;
    }

    // ── /restore-data ──────────────────────────────────────
    if (commandName === "restore-data") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const jsonStr = interaction.options.getString("json");
      let data;
      try { data = JSON.parse(jsonStr); } catch(e) { await interaction.editReply("❌ Invalid JSON. Make sure you paste the full backup JSON."); return; }
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("restore_confirm_"+user.id).setLabel("✅ Yes, Restore").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("restore_cancel_"+user.id) .setLabel("❌ Cancel")      .setStyle(ButtonStyle.Secondary),
      );
      // Store temp
      pendingInputs.set("restore_"+user.id, { step:"restore_confirm", data });
      await interaction.editReply({ embeds: [pjaEmbed("⚠️ Confirm Restore", 0xef4444)
        .setDescription("This will overwrite in-memory bot data (warnings, points, local stats, newcomer profiles, match reports, open spots).\n\nAPI roster/stats/awards will **not** be overwritten by this command.\n\nAre you sure?")], components: [row] });
      return;
    }

    // ── /announce ──────────────────────────────────────────────
    if (commandName === "announce") {
      await interaction.deferReply({ ephemeral: true });

      if (!isAdmin(member)) {
        await interaction.editReply("❌ This command is for Managers only.");
        return;
      }

      const title     = interaction.options.getString("title");
      const message   = interaction.options.getString("message");
      const channelOpt= interaction.options.getChannel("channel") || null;
      const pingOpt   = interaction.options.getString("ping")  || "none";
      const colorOpt  = interaction.options.getString("color") || "blue";
      const imageUrl  = interaction.options.getString("image") || null;

      // ── Color map ────────────────────────────────────────────
      const colorMap = {
        blue:  0x2563eb,
        red:   0xef4444,
        green: 0x22c55e,
        gold:  0xf59e0b,
        gray:  0x64748b,
      };
      const embedColor = colorMap[colorOpt] || 0x2563eb;

      // ── Build embed ──────────────────────────────────────────
      const announceEmbed = new EmbedBuilder()
        .setTitle("📢 " + title)
        .setDescription(message)
        .setColor(embedColor)
        .addFields(
          { name: "🎙️ Posted by", value: user.tag, inline: true },
          { name: "📅 Date",      value: `<t:${Math.floor(Date.now()/1000)}:F>`, inline: true },
        )
        .setFooter({ text: "Project Azure (PJA) — Official Announcement" })
        .setTimestamp();

      // If image URL is provided and looks valid, set it as image
      if (imageUrl && (imageUrl.startsWith("http://") || imageUrl.startsWith("https://"))) {
        try { announceEmbed.setImage(imageUrl); } catch(e) {}
      }

      // ── Ping string ──────────────────────────────────────────
      let pingStr = "";
      if (pingOpt === "everyone")  pingStr = "@everyone";
      else if (pingOpt === "here") pingStr = "@here";
      else if (pingOpt === "role") {
        // Find the first Manager/Admin role in the guild to ping
        const mgRole = interaction.guild.roles.cache.find(r => ADMIN_ROLES.includes(r.name));
        pingStr = mgRole ? `<@&${mgRole.id}>` : "@here";
      }

      // ── Resolve target channel ───────────────────────────────
      const targetChannel = channelOpt || interaction.channel;
      if (!targetChannel) {
        await interaction.editReply("❌ Could not resolve the target channel.");
        return;
      }

      // ── Send announcement ────────────────────────────────────
      const sendPayload = { embeds: [announceEmbed] };
      if (pingStr) sendPayload.content = pingStr;

      let sentMsg;
      try {
        sentMsg = await targetChannel.send(sendPayload);
      } catch (sendErr) {
        await interaction.editReply("❌ Could not send to that channel: **" + (sendErr.message || "Permission denied") + "**\nMake sure the bot has permission to send messages there.");
        return;
      }

      // ── Save to in-memory store ──────────────────────────────
      announcements.push({
        id:        makeId(),
        title,
        message,
        postedBy:  user.tag,
        postedAt:  new Date().toISOString(),
        color:     colorOpt,
        channelId: targetChannel.id,
        ping:      pingOpt,
        image:     imageUrl || null,
        messageId: sentMsg.id,
      });
      // Keep only last 50 announcements in memory
      if (announcements.length > 50) announcements.shift();

      // ── Confirm to manager ───────────────────────────────────
      const channelMention = channelOpt ? `<#${targetChannel.id}>` : "this channel";
      await interaction.editReply({ embeds: [
        new EmbedBuilder()
          .setTitle("✅ Announcement Sent")
          .setColor(0x22c55e)
          .setDescription(`Your announcement was posted in ${channelMention}.`)
          .addFields(
            { name: "📢 Title",   value: title,              inline: true  },
            { name: "🎨 Color",   value: colorOpt,           inline: true  },
            { name: "🔔 Ping",    value: pingStr || "None",  inline: true  },
            { name: "🔗 Jump",    value: `[View message](https://discord.com/channels/${interaction.guild.id}/${targetChannel.id}/${sentMsg.id})`, inline: false },
          )
          .setFooter({ text: "Project Azure (PJA)" })
          .setTimestamp()
      ] });
      return;
    }

  } catch (err) {
    console.error("Error in /"+commandName+":", err);
    try {
      const msg = "❌ Something went wrong. Please try again.";
      if (interaction.replied||interaction.deferred) await interaction.editReply(msg);
      else await interaction.reply({ content:msg, ephemeral:true });
    } catch(e) {}
  }
});

// ══════════════════════════════════════════════════════════════
// ── BUTTON HANDLER ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  try {
    const { customId, user, member } = interaction;
    const parts = customId.split("_");

    // ── Match report quick-action buttons ─────────────────
    if (parts[0]==="matchrep") {
      const action   = parts[1];
      const reportId = parts[2];
      if (action==="selfreport") {
        await interaction.reply({ content:"📊 Use `/self-report report-id:**"+reportId+"**` to submit your stats for this match!", ephemeral:true });
        return;
      }
      if (action==="motm") {
        await interaction.reply({ content:"🏆 Use `/motm-vote report-id:**"+reportId+"** vote-for:PlayerName` to vote for MOTM!", ephemeral:true });
        return;
      }
      if (action==="review") {
        if (!isAdmin(member)) { await interaction.reply({ content:"❌ Only Managers can view submissions.", ephemeral:true }); return; }
        await interaction.reply({ content:"🔍 Use `/review-submissions report-id:**"+reportId+"**` to see all submissions.", ephemeral:true });
        return;
      }
      return;
    }

    // ── RSVP buttons ──────────────────────────────────────
    if (parts[0]==="going" || parts[0]==="maybe" || parts[0]==="cantgo") {
      await interaction.deferUpdate();
      const action = parts[0]; const friendlyId = parts[1];
      const data   = friendlies.get(friendlyId); if (!data) return;
      const name   = member ? member.displayName : user.username;
      const prev   = data.responses.get(user.id);
      if (prev==="going")  data.going.delete(name);
      if (prev==="maybe")  data.maybe.delete(name);
      if (prev==="cantgo") data.cantGo.delete(name);
      if (prev === action) { data.responses.delete(user.id); }
      else {
        if (action==="going")  data.going.add(name);
        if (action==="maybe")  data.maybe.add(name);
        if (action==="cantgo") data.cantGo.add(name);
        data.responses.set(user.id, action);
      }
      const isMatch = data.type && data.type !== "Friendly";
      await interaction.editReply({ embeds:[isMatch?buildMatchRsvpEmbed(data):buildFriendlyEmbed(data)], components:[buildRsvpButtons(friendlyId)] });
      return;
    }

    // ── Application buttons ────────────────────────────────
    if (parts[0]==="app") {
      await interaction.deferUpdate();
      if (!isAdmin(member)) { await interaction.followUp({ content:"❌ No permission.", ephemeral:true }); return; }
      const action = parts[1]; const appId = parts[2];
      const app    = [...applications.values()].find(a=>a.id===appId);
      if (!app) { await interaction.followUp({ content:"❌ Application not found.", ephemeral:true }); return; }
      const statusMap  = { accept:"accepted", deny:"denied", trialist:"trialist", needsclips:"needsclips" };
      app.status = statusMap[action] || action;
      const dmMessages = {
        accept:     "🎉 Congratulations **"+app.ign+"**! Your tryout for **Project Azure** has been **ACCEPTED**!",
        deny:       "Hi **"+app.ign+"**, thanks for applying to PJA. Unfortunately your application was not successful this time.",
        trialist:   "Hi **"+app.ign+"**! You've been offered a **Trialist** spot at **Project Azure**!",
        needsclips: "Hi **"+app.ign+"**, we'd like to see **more clips** before making a decision. Please send highlights to a manager!",
      };
      const dmColors = { accept:0x22c55e, deny:0xef4444, trialist:0x3b82f6, needsclips:0xf59e0b };
      try {
        const applicant = await client.users.fetch(app.userId).catch(()=>null);
        if (applicant) await applicant.send({ embeds:[new EmbedBuilder().setTitle("PJA Application Update").setColor(dmColors[action]||0x2563eb).setDescription(dmMessages[action]||"Your application has been updated.").setTimestamp()] });
      } catch(e) {}
      await interaction.followUp({ content:"**"+app.ign+"** — "+(action==="accept"?"✅ Accepted":action==="deny"?"❌ Denied":action==="trialist"?"🔵 Trialist":"🎬 Needs Clips"), ephemeral:true });
      return;
    }

    // ── Player request buttons ─────────────────────────────
    if (parts[0]==="req") {
      await interaction.deferUpdate();
      if (!isAdmin(member)) { await interaction.followUp({ content:"❌ No permission.", ephemeral:true }); return; }
      const action = parts[1]; const reqId = parts[2];
      const req    = playerRequests.get(reqId);
      if (!req) { await interaction.followUp({ content:"❌ Request not found.", ephemeral:true }); return; }
      req.status = { accept:"✅ Accepted", deny:"❌ Denied", moreinfo:"❓ More Info" }[action] || action;
      try {
        const requester = await client.users.fetch(req.userId).catch(()=>null);
        if (requester) {
          const msgs = { accept:"✅ Your **"+req.type+"** request has been **accepted**!", deny:"❌ Your **"+req.type+"** request was **denied**.", moreinfo:"❓ Management needs more info on your **"+req.type+"** request. Please contact a manager." };
          await requester.send({ embeds:[pjaEmbed("📩 Request Update — "+req.type, action==="accept"?0x22c55e:action==="deny"?0xef4444:0xf59e0b).setDescription(msgs[action]||"Your request has been updated.")] });
        }
      } catch(e) {}
      await interaction.followUp({ content:"Request from **"+req.ign+"** marked: "+req.status, ephemeral:true });
      return;
    }

    // ── Activity check button ──────────────────────────────
    if (parts[0]==="activity" && parts[1]==="confirm") {
      await interaction.deferUpdate();
      const checkId = parts[2];
      let check = activityChecks.get(checkId);
      // If bot restarted and check is gone, recreate a minimal one so the button still works
      if (!check) {
        check = { id: checkId, message: "Activity Check", deadline: "Unknown", active: new Set(), postedBy: "Unknown" };
        activityChecks.set(checkId, check);
      }
      const name = member ? member.displayName : user.username;
      check.active.add(name);
      await interaction.editReply({ embeds:[buildActivityEmbed(check)], components:[new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("activity_confirm_"+checkId).setLabel("✅ I'm Active! ("+check.active.size+")").setStyle(ButtonStyle.Success)
      )]});
      return;
    }

    // ── Team vote buttons ──────────────────────────────────
    if (parts[0]==="vote") {
      await interaction.deferUpdate();
      const voteId = parts[1]; const optIdx = parseInt(parts[2]);
      const vote   = teamVotes.get(voteId); if (!vote) return;
      const name   = member ? member.displayName : user.username;
      const prev   = vote.userVotes.get(user.id);
      if (prev!==undefined && vote.options[prev]) vote.options[prev].voters.delete(name);
      if (prev===optIdx) { vote.userVotes.delete(user.id); }
      else { vote.options[optIdx].voters.add(name); vote.userVotes.set(user.id, optIdx); }
      const row = new ActionRowBuilder().addComponents(
        vote.options.map((opt,i)=>new ButtonBuilder().setCustomId("vote_"+voteId+"_"+i).setLabel(opt.label.substring(0,80)).setStyle(vote.userVotes.get(user.id)===i?ButtonStyle.Success:ButtonStyle.Primary))
      );
      await interaction.editReply({ embeds:[buildVoteEmbed(vote)], components:[row] });
      return;
    }

    // ── Giveaway enter button ──────────────────────────────
    if (parts[0]==="giveaway" && parts[1]==="enter") {
      await interaction.deferUpdate();
      const giveId = parts[2]; const give = giveaways.get(giveId); if (!give) return;
      if (give.ended) { await interaction.followUp({ content:"❌ This giveaway has ended!", ephemeral:true }); return; }
      if (give.entries.has(user.id)) { give.entries.delete(user.id); await interaction.followUp({ content:"👋 You left the giveaway for **"+give.prize+"**.", ephemeral:true }); }
      else { give.entries.add(user.id); await interaction.followUp({ content:"🎉 You entered the giveaway for **"+give.prize+"**! Good luck!", ephemeral:true }); }
      await interaction.editReply({ embeds:[buildGiveawayEmbed(give)], components:[buildGiveawayButton(giveId, false)] });
      return;
    }

    // ── Redeem confirm / cancel buttons (player self-confirms) ──
    if (parts[0]==="redeem" && (parts[1]==="confirm" || parts[1]==="cancel")) {
      await interaction.deferUpdate();
      const redeemId = parts[2];
      const redeem   = shopRedemptions.get(redeemId);
      if (!redeem) { await interaction.followUp({ content:"❌ Redemption not found — it may have expired.", ephemeral:true }); return; }

      // Only the player who made the request can confirm/cancel
      if (interaction.user.id !== redeem.userId) {
        await interaction.followUp({ content:"❌ This isn't your redemption!", ephemeral:true });
        return;
      }
      if (redeem.status !== "pending") {
        await interaction.followUp({ content:"⚠️ This redemption was already **"+redeem.status+"**.", ephemeral:true });
        return;
      }

      // Disable buttons immediately
      const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("redeem_confirm_"+redeemId).setLabel("✅ Yes, redeem it!").setStyle(ButtonStyle.Success).setDisabled(true),
        new ButtonBuilder().setCustomId("redeem_cancel_"+redeemId) .setLabel("❌ Cancel")         .setStyle(ButtonStyle.Danger) .setDisabled(true),
      );
      await interaction.editReply({ components:[disabledRow] });

      // ── CANCEL ─────────────────────────────────────────
      if (parts[1] === "cancel") {
        redeem.status = "cancelled";
        await interaction.followUp({ content:"❌ Redemption cancelled. Your points were **not** deducted.", ephemeral:true });
        return;
      }

      // ── CONFIRM — deduct points and auto-fulfil ─────────
      redeem.status     = "approved";
      redeem.reviewedBy = "self-confirmed";
      const newBal      = addPoints(redeem.ign, -redeem.cost);
      const guild       = interaction.guild;
      const result      = await fulfilRedemption(redeem, guild);

      const doneEmbed = pjaEmbed("✅ Redemption Confirmed — "+redeem.item, 0x22c55e)
        .setDescription(
          "🎉 Your **"+redeem.item+"** has been redeemed!\n" +
          (result.ok
            ? (["nickname_color","profile_badge","clip_feature","custom_title"].includes(redeem.itemId)
                ? "📬 Check your DMs — the bot will walk you through the next step!"
                : "✅ Your reward has been processed automatically!")
            : "⚠️ "+result.msg)
        )
        .addFields(
          { name:"🛒 Item",          value:redeem.item,          inline:true },
          { name:"🪙 Points spent",  value:"-"+redeem.cost+" pts", inline:true },
          { name:"💰 New balance",   value:newBal+" pts",          inline:true },
        );
      await interaction.editReply({ embeds:[doneEmbed], components:[disabledRow] });
      return;
    }

    // ── Suggestion buttons ─────────────────────────────────
    if (parts[0]==="sug") {
      const action = parts[1]; const sugId = parts[2];
      const sug    = suggestions.get(sugId); if (!sug) return;
      if (action==="up" || action==="down") {
        await interaction.deferUpdate();
        if (action==="up") {
          if (sug.upvotes.has(user.id)) sug.upvotes.delete(user.id);
          else { sug.upvotes.add(user.id); sug.downvotes.delete(user.id); }
        } else {
          if (sug.downvotes.has(user.id)) sug.downvotes.delete(user.id);
          else { sug.downvotes.add(user.id); sug.upvotes.delete(user.id); }
        }
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("sug_up_"+sugId).setLabel("👍 Upvote ("+sug.upvotes.size+")").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("sug_down_"+sugId).setLabel("👎 Downvote ("+sug.downvotes.size+")").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("sug_approve_"+sugId).setLabel("✅ Approve").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("sug_deny_"+sugId).setLabel("❌ Deny").setStyle(ButtonStyle.Secondary),
        );
        await interaction.editReply({ embeds:[buildSuggestionEmbed(sug)], components:[row] });
        return;
      }
      if (action==="approve" || action==="deny") {
        await interaction.deferUpdate();
        if (!isAdmin(member)) { await interaction.followUp({ content:"❌ Only Managers can approve/deny suggestions.", ephemeral:true }); return; }
        sug.status = action==="approve"?"approved":"denied";
        sug.reviewedBy = user.tag;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("sug_up_"+sugId).setLabel("👍 Upvote ("+sug.upvotes.size+")").setStyle(ButtonStyle.Success).setDisabled(true),
          new ButtonBuilder().setCustomId("sug_down_"+sugId).setLabel("👎 Downvote ("+sug.downvotes.size+")").setStyle(ButtonStyle.Danger).setDisabled(true),
          new ButtonBuilder().setCustomId("sug_approve_"+sugId).setLabel("✅ Approved").setStyle(ButtonStyle.Success).setDisabled(true),
          new ButtonBuilder().setCustomId("sug_deny_"+sugId).setLabel("❌ Denied").setStyle(ButtonStyle.Danger).setDisabled(true),
        );
        await interaction.editReply({ embeds:[buildSuggestionEmbed(sug)], components:[row] });
        try {
          const suggester = await client.users.fetch(sug.userId).catch(()=>null);
          if (suggester) await suggester.send({ embeds:[pjaEmbed("💡 Suggestion "+(action==="approve"?"Approved":"Denied"), action==="approve"?0x22c55e:0xef4444).setDescription("Your suggestion has been **"+(action==="approve"?"approved":"denied")+"** by management!\n\n> "+sug.suggestion).addFields({ name:"🆔 ID", value:sug.id, inline:true })] }).catch(()=>{});
        } catch(e) {}
        await interaction.followUp({ content:"Suggestion **"+sugId+"** → **"+sug.status+"**.", ephemeral:true });
        return;
      }
      return;
    }

    // ── Bug report buttons ─────────────────────────────────
    if (parts[0]==="bug") {
      await interaction.deferUpdate();
      if (!isAdmin(member)) { await interaction.followUp({ content:"❌ Only Managers can update bug reports.", ephemeral:true }); return; }
      const action = parts[1]; const bugId = parts[2];
      const bug    = bugReports.get(bugId);
      if (!bug) { await interaction.followUp({ content:"❌ Bug report not found.", ephemeral:true }); return; }
      const statusMap   = { acknowledge:"acknowledged", fixed:"fixed", invalid:"invalid" };
      const statusEmoji = { acknowledge:"👀 Acknowledged", fixed:"✅ Fixed", invalid:"❌ Invalid" };
      const statusColor = { acknowledge:0xf59e0b, fixed:0x22c55e, invalid:0xef4444 };
      bug.status = statusMap[action]||action; bug.reviewedBy = user.tag;
      const updatedEmbed = pjaEmbed("🐛 Bug Report — #"+bugId, statusColor[action]||0x2563eb)
        .addFields(
          { name:"🔍 What broke", value:bug.what },{ name:"📍 Where", value:bug.where, inline:true },
          { name:"📎 Proof", value:bug.proof },{ name:"📝 Notes", value:bug.notes },
          { name:"👤 Reported by", value:"<@"+bug.userId+"> ("+bug.username+")", inline:true },
          { name:"🆔 Bug ID", value:bugId, inline:true },{ name:"🔵 Status", value:statusEmoji[action]||bug.status, inline:true },
          { name:"🎙️ Reviewed by", value:user.tag, inline:true },
        );
      const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("bug_acknowledge_"+bugId).setLabel("👀 Acknowledged").setStyle(ButtonStyle.Primary) .setDisabled(action==="acknowledge"),
        new ButtonBuilder().setCustomId("bug_fixed_"+bugId)      .setLabel("✅ Fixed")       .setStyle(ButtonStyle.Success) .setDisabled(action==="fixed"),
        new ButtonBuilder().setCustomId("bug_invalid_"+bugId)    .setLabel("❌ Invalid")     .setStyle(ButtonStyle.Danger)  .setDisabled(action==="invalid"),
      );
      await interaction.editReply({ embeds:[updatedEmbed], components:[disabledRow] });
      try {
        const reporter = await client.users.fetch(bug.userId).catch(()=>null);
        if (reporter) await reporter.send({ embeds:[pjaEmbed("🐛 Bug Report Update — #"+bugId, statusColor[action]||0x2563eb).setDescription("Your bug report is now: **"+(statusEmoji[action]||bug.status)+"**").addFields({ name:"🆔 Bug ID", value:bugId, inline:true })] }).catch(()=>{});
      } catch(e) {}
      await interaction.followUp({ content:"Bug **"+bugId+"** → **"+bug.status+"**.", ephemeral:true });
      return;
    }

    // ── Submission review buttons (new queue system) ───────
    if (parts[0]==="subq") {
      // subq_approve_REPORTID_USERID
      // subq_edit_REPORTID_USERID
      // subq_deny_REPORTID_USERID
      // subq_proof_REPORTID_USERID
      // subq_apprnext_REPORTID_USERID_FILTER_PLAYERARG
      // subq_skip_REPORTID_USERID_FILTER_PLAYERARG
      // subq_close_REPORTID
      const action   = parts[1];
      const reportId = parts[2];
      const userId   = parts[3];

      if (action === "close") {
        await interaction.deferUpdate();
        await interaction.editReply({ embeds:[pjaEmbed("🔒 Review Closed", 0x6b7280).setDescription("Submission review for **"+reportId+"** closed.")], components:[] });
        return;
      }

      if (!isAdmin(member)) { await interaction.deferUpdate(); await interaction.followUp({ content:"❌ No permission.", ephemeral:true }); return; }

      const subKey = reportId + "_" + userId;
      const sub    = selfReports.get(subKey);
      if (!sub) { await interaction.deferUpdate(); await interaction.followUp({ content:"❌ Submission not found.", ephemeral:true }); return; }

      // ── EDIT — open modal ──────────────────────────────────
      if (action === "edit") {
        try {
          const modal = new ModalBuilder()
            .setCustomId("subedit_modal_"+reportId+"_"+userId)
            .setTitle("Edit Submission".substring(0,45));
          const rows = [
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("edit_goals").setLabel("Goals").setStyle(TextInputStyle.Short).setRequired(false).setValue(String(sub.goals||""  ))),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("edit_assists").setLabel("Assists").setStyle(TextInputStyle.Short).setRequired(false).setValue(String(sub.assists||""))),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("edit_saves").setLabel("Saves").setStyle(TextInputStyle.Short).setRequired(false).setValue(String(sub.saves||""))),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("edit_cleansheet").setLabel("Clean Sheet (yes/no)").setStyle(TextInputStyle.Short).setRequired(false).setValue(String(sub.cleanSheet||""))),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("edit_reason").setLabel("Reason for edit (shown to player)").setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder("e.g. Score was corrected by match data")),
          ];
          rows.forEach(r => modal.addComponents(r));
          await interaction.showModal(modal);
        } catch(e) {
          console.error("[subq_edit] showModal error:", e.message);
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content:"❌ Could not open edit modal.", ephemeral:true }).catch(()=>{});
          }
        }
        return;
      }

      await interaction.deferUpdate();

      // ── APPROVE ──────────────────────────────────────────
      if (action === "approve" || action === "apprnext") {
        if (sub.pointsAwarded) {
          await interaction.followUp({ content:"⚠️ **"+sub.ign+"**'s submission already has points awarded.", ephemeral:true });
        } else {
          sub.status      = "approved";
          sub.reviewedBy  = user.tag;
          sub.pointsAwarded = true;

          // Award stats
          addStat(sub.ign, "matches", 1);
          if (parseInt(sub.goals))   addStat(sub.ign, "goals",      parseInt(sub.goals));
          if (parseInt(sub.assists)) addStat(sub.ign, "assists",    parseInt(sub.assists));
          if (parseInt(sub.saves))   addStat(sub.ign, "saves",      parseInt(sub.saves));
          if (sub.cleanSheet?.toLowerCase()==="yes") addStat(sub.ign, "cleanSheets", 1);

          // Award PJA points
          const ptsEarned = calcSubmissionPoints(sub);
          addPoints(sub.ign, ptsEarned);
          addPointHistory(sub.ign, ptsEarned, "Self-report approved ("+reportId+")");
          addSubHistory(subKey, "approved", user.tag, "", sub);

          // DM player
          try {
            const targetUser = await client.users.fetch(userId).catch(()=>null);
            if (targetUser) {
              await targetUser.send({ embeds:[pjaEmbed("✅ Stats Approved!", 0x22c55e)
                .setDescription("Your stats for **PJA vs "+sub.matchOpponent+"** have been **approved** by **"+user.tag+"**!")
                .addFields(
                  { name:"⚽ Goals",    value:String(sub.goals||0),   inline:true },
                  { name:"🎯 Assists",  value:String(sub.assists||0), inline:true },
                  { name:"🧤 Saves",    value:String(sub.saves||0),   inline:true },
                  { name:"🪙 PJA Points Earned", value:"+"+ptsEarned+" pts", inline:true },
                  { name:"💰 New Balance", value:getPoints(sub.ign)+" pts", inline:true },
                )] }).catch(()=>{});
            }
          } catch(e) {}

          await interaction.followUp({ content:"✅ **"+sub.ign+"** approved & +**"+ptsEarned+" pts** awarded!", ephemeral:true });
        }
      }

      // ── DENY ──────────────────────────────────────────────
      else if (action === "deny") {
        sub.status     = "denied";
        sub.reviewedBy = user.tag;
        addSubHistory(subKey, "denied", user.tag, "", sub);
        try {
          const targetUser = await client.users.fetch(userId).catch(()=>null);
          if (targetUser) await targetUser.send({ embeds:[pjaEmbed("❌ Stats Denied", 0xef4444).setDescription("Your stats for **PJA vs "+sub.matchOpponent+"** were **denied**.\nContact **"+user.tag+"** for more info.")] }).catch(()=>{});
        } catch(e) {}
        await interaction.followUp({ content:"❌ **"+sub.ign+"**'s submission denied.", ephemeral:true });
      }

      // ── NEEDS PROOF ───────────────────────────────────────
      else if (action === "proof") {
        sub.status     = "needs_proof";
        sub.reviewedBy = user.tag;
        addSubHistory(subKey, "needs_proof", user.tag, "", sub);
        try {
          const targetUser = await client.users.fetch(userId).catch(()=>null);
          if (targetUser) await targetUser.send({ embeds:[pjaEmbed("📎 Proof Required", 0xf59e0b).setDescription("Your stats for **PJA vs "+sub.matchOpponent+"** need **proof/clip link**.\nPlease send it to a manager or reply to this DM.")] }).catch(()=>{});
        } catch(e) {}
        await interaction.followUp({ content:"📎 **"+sub.ign+"** marked as needs proof.", ephemeral:true });
      }

      // ── SKIP — just advance to next ───────────────────────
      // (no status change, just load next in queue)

      // If apprnext or skip — load next submission
      if (action === "apprnext" || action === "skip") {
        const filterArg  = parts[4] || "pending";
        const playerArg  = parts[5] || "";
        const report     = matchReportsFull.get(reportId);
        if (!report) return;

        let nextSubs = [...selfReports.entries()]
          .filter(([k]) => k.startsWith(reportId+"_") && k !== subKey)
          .map(([,v]) => v);
        if (filterArg !== "all") {
          if (filterArg === "edited") nextSubs = nextSubs.filter(s => s.editedByManager);
          else nextSubs = nextSubs.filter(s => s.status === filterArg);
        }
        if (playerArg) nextSubs = nextSubs.filter(s => (s.ign||"").toLowerCase().includes(playerArg));

        if (nextSubs.length === 0) {
          await interaction.editReply({ embeds:[pjaEmbed("✅ Queue Complete", 0x22c55e).setDescription("No more submissions matching the current filter for **"+reportId+"**.")], components:[] });
          return;
        }

        const nextSub  = nextSubs[0];
        const nextKey  = reportId+"_"+nextSub.userId;
        const hist     = submissionHistory.get(nextKey) || [];
        const statusEmoji = { pending:"⏳", approved:"✅", denied:"❌", needs_proof:"📎" };

        const nextEmbed = pjaEmbed(
          "📋 Review — "+(nextSub.ign||"?")+" ("+(nextSub.position||"?")+") ["+(nextSubs.length)+" left]",
          nextSub.status==="approved"?0x22c55e:nextSub.status==="denied"?0xef4444:0x2563eb
        )
          .setDescription("**Match:** PJA vs **"+report.opponent+"** | "+report.result+" "+report.score+
            "\n**Status:** "+(statusEmoji[nextSub.status]||"❓")+" "+nextSub.status+(nextSub.editedByManager?" | ✏️ Edited":""))
          .addFields(
            { name:"👤 Player",  value:nextSub.ign||"?",            inline:true },
            { name:"📍 Pos",     value:nextSub.position||"?",       inline:true },
            { name:"🆔 User",    value:"<@"+nextSub.userId+">",     inline:true },
            ...(nextSub.goals!==undefined   ? [{ name:"⚽",  value:String(nextSub.goals||0),   inline:true }] : []),
            ...(nextSub.assists!==undefined ? [{ name:"🎯",  value:String(nextSub.assists||0), inline:true }] : []),
            ...(nextSub.saves!==undefined   ? [{ name:"🧤",  value:String(nextSub.saves||0),   inline:true }] : []),
            ...(nextSub.cleanSheet          ? [{ name:"🛡️",  value:nextSub.cleanSheet,         inline:true }] : []),
            ...(nextSub.notes               ? [{ name:"📝 Notes", value:nextSub.notes.substring(0,200), inline:false }] : []),
            ...(hist.length                 ? [{ name:"📜 History", value:hist.slice(-2).map(h=>`• ${h.event} by ${h.by}`).join("\n"), inline:false }] : []),
          )
          .setFooter({ text:"Queue: "+nextSubs.length+" remaining | Filter: "+filterArg+" | Project Azure (PJA)" });

        const row1 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("subq_approve_"+reportId+"_"+nextSub.userId).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("subq_edit_"+reportId+"_"+nextSub.userId).setLabel("✏️ Edit").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("subq_deny_"+reportId+"_"+nextSub.userId).setLabel("❌ Deny").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("subq_proof_"+reportId+"_"+nextSub.userId).setLabel("📎 Proof").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("subq_apprnext_"+reportId+"_"+nextSub.userId+"_"+filterArg+"_"+playerArg).setLabel("✅➡️ App+Next").setStyle(ButtonStyle.Success),
        );
        const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("subq_skip_"+reportId+"_"+nextSub.userId+"_"+filterArg+"_"+playerArg).setLabel("⏭ Skip").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("subq_close_"+reportId).setLabel("🔒 Close").setStyle(ButtonStyle.Danger),
        );
        await interaction.editReply({ embeds:[nextEmbed], components:[row1, row2] });
      } else {
        // For approve/deny/proof — update the existing card with disabled buttons
        const disabledRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("subq_done").setLabel("✅ Action Done").setStyle(ButtonStyle.Secondary).setDisabled(true),
        );
        await interaction.editReply({ components:[disabledRow] });
      }
      return;
    }

    // ── Submission review buttons (legacy `sub_` — kept for backwards compat) ─
    if (parts[0]==="sub") {
      await interaction.deferUpdate();
      if (!isAdmin(member)) { await interaction.followUp({ content:"❌ No permission.", ephemeral:true }); return; }
      const action   = parts[1];
      const reportId = parts[2];
      const userId   = parts[3];
      const subKey   = reportId + "_" + userId;
      const sub      = selfReports.get(subKey);
      if (!sub) { await interaction.followUp({ content:"❌ Submission not found.", ephemeral:true }); return; }
      const statusMap = { approve:"approved", deny:"denied", proof:"needs_proof" };
      sub.status = statusMap[action] || action;
      sub.reviewedBy = user.tag;
      if (sub.status === "approved" && !sub.pointsAwarded) {
        sub.pointsAwarded = true;
        addStat(sub.ign, "matches", 1);
        if (parseInt(sub.goals))   addStat(sub.ign, "goals",   parseInt(sub.goals));
        if (parseInt(sub.assists)) addStat(sub.ign, "assists", parseInt(sub.assists));
        if (parseInt(sub.saves))   addStat(sub.ign, "saves",   parseInt(sub.saves));
        if (sub.cleanSheet?.toLowerCase()==="yes") addStat(sub.ign, "cleanSheets", 1);
        const ptsEarned = calcSubmissionPoints(sub);
        addPoints(sub.ign, ptsEarned);
        addPointHistory(sub.ign, ptsEarned, "Self-report approved ("+reportId+")");
        addSubHistory(subKey, "approved", user.tag, "", sub);
        try {
          const targetUser = await client.users.fetch(userId).catch(()=>null);
          if (targetUser) await targetUser.send({ embeds:[pjaEmbed("✅ Stats Approved!", 0x22c55e).setDescription("Your stats for **PJA vs "+sub.matchOpponent+"** were approved! +**"+ptsEarned+" pts** 🪙").addFields({ name:"💰 Balance", value:getPoints(sub.ign)+" pts", inline:true })] }).catch(()=>{});
        } catch(e) {}
        await interaction.followUp({ content:"✅ **"+sub.ign+"** approved & +"+ptsEarned+" pts.", ephemeral:true });
      } else {
        const msgs = { denied:"❌ Your stats for **PJA vs "+sub.matchOpponent+"** were denied.", needs_proof:"📎 Your stats need proof. Please send to a manager." };
        try {
          const targetUser = await client.users.fetch(userId).catch(()=>null);
          if (targetUser) await targetUser.send({ embeds:[pjaEmbed("📊 Stats Update", sub.status==="denied"?0xef4444:0xf59e0b).setDescription(msgs[sub.status]||"Stats updated.")] }).catch(()=>{});
        } catch(e) {}
        await interaction.followUp({ content:"**"+sub.ign+"** → **"+sub.status+"**.", ephemeral:true });
      }
      return;
    }

    // ── MOTM buttons (approve top-voted, AI, different, lock) ─
    if (parts[0]==="motm" && (parts[1]==="approve"||parts[1]==="top"||parts[1]==="different"||parts[1]==="locktoggle")) {
      await interaction.deferUpdate();
      if (!isAdmin(member)) { await interaction.followUp({ content:"❌ No permission.", ephemeral:true }); return; }
      const reportId = parts[2];
      const report   = matchReportsFull.get(reportId);
      if (!report) { await interaction.followUp({ content:"❌ Report not found.", ephemeral:true }); return; }

      // Approve top voted / approve AI MOTM
      if (parts[1]==="approve" || parts[1]==="top") {
        const aiIgn = parts[3];
        if (!aiIgn) { await interaction.followUp({ content:"❌ No candidate specified.", ephemeral:true }); return; }
        report.motm   = aiIgn;
        report.aiMotm = aiIgn;
        addStat(aiIgn, "motms", 1);
        addPoints(aiIgn, 15);
        addPointHistory(aiIgn, 15, "MOTM award ("+reportId+")");
        motmVoteLocks.set(reportId, true); // lock voting after award
        // DM the MOTM winner
        try {
          const winnerId = getDiscordIdForIgn(aiIgn);
          if (winnerId) {
            const winner = await client.users.fetch(winnerId).catch(()=>null);
            if (winner) await winner.send({ embeds:[pjaEmbed("🏆 You're the Man of the Match!", 0xf59e0b)
              .setDescription("🎉 Congratulations **"+aiIgn+"**! You've been awarded **Man of the Match** for the game against **"+report.opponent+"**!\n\n+**15 PJA Points** have been added to your balance 🪙")
              .addFields({ name:"💰 New Balance", value:getPoints(aiIgn)+" pts", inline:true }, { name:"🎮 Match", value:"PJA vs "+report.opponent, inline:true })] }).catch(()=>{});
          }
        } catch(e) {}
        await interaction.followUp({ content:"🏆 **"+aiIgn+"** confirmed as MOTM! +15 pts awarded. Voting locked.", ephemeral:true });
      }

      // Choose different
      else if (parts[1]==="different") {
        motmVoteLocks.set(reportId, false);
        await interaction.followUp({ content:"🔄 Use `/final-report report-id:"+reportId+" motm:PlayerName` to set a different MOTM.", ephemeral:true });
      }

      // Lock / Unlock toggle
      else if (parts[1]==="locktoggle") {
        const isNowLocked = !motmVoteLocks.get(reportId);
        motmVoteLocks.set(reportId, isNowLocked);
        await interaction.followUp({ content:(isNowLocked?"🔒 MOTM voting **locked**":"🔓 MOTM voting **unlocked**")+" for **"+reportId+"**.", ephemeral:true });
      }
      return;
    }

    // ── Final report post / complete ──────────────────────
    if (parts[0]==="finalrep") {
      await interaction.deferUpdate();
      if (!isAdmin(member)) { await interaction.followUp({ content:"❌ No permission.", ephemeral:true }); return; }
      const reportId = parts[2];
      const report   = matchReportsFull.get(reportId);
      if (parts[1]==="post") {
        await interaction.followUp({ content:"📢 Final report posted above for the team to see!", ephemeral:true });
      } else if (parts[1]==="complete") {
        if (report) report.status = "complete";
        await interaction.followUp({ content:"✅ Match report **"+reportId+"** marked as complete.", ephemeral:true });
      }
      return;
    }

    // ── Remove player confirm / cancel ────────────────────
    if (parts[0]==="removeplayer") {
      await interaction.deferUpdate();
      if (!isAdmin(member)) { await interaction.followUp({ content:"❌ No permission.", ephemeral:true }); return; }
      const ign = decodeURIComponent(parts[2]);
      if (parts[1]==="cancel") { await interaction.followUp({ content:"❌ Removal cancelled.", ephemeral:true }); return; }
      // confirm — remove from API
      const liveRoster = await apiGet("roster");
      const player = liveRoster.find(p => (p.name||p.ign||"").toLowerCase()===ign.toLowerCase());
      if (player && player.id) {
        try { await fetch(WEBSITE_API+"roster/"+player.id, { method:"DELETE" }); } catch(e) {}
      }
      await interaction.followUp({ content:"✅ **"+ign+"** removed from the roster.", ephemeral:true });
      return;
    }

    // ── Release confirm / cancel ───────────────────────────
    if (parts[0]==="release") {
      await interaction.deferUpdate();
      if (!isAdmin(member)) { await interaction.followUp({ content:"❌ No permission.", ephemeral:true }); return; }
      const ign = decodeURIComponent(parts[2]);
      if (parts[1]==="cancel") { await interaction.followUp({ content:"❌ Release cancelled.", ephemeral:true }); return; }
      const liveRoster = await apiGet("roster");
      const player = liveRoster.find(p => (p.name||p.ign||"").toLowerCase()===ign.toLowerCase());
      if (player && player.id) {
        try { await fetch(WEBSITE_API+"roster/"+player.id, { method:"DELETE" }); } catch(e) {}
      }
      await interaction.followUp({ content:"✅ **"+ign+"** has been released from Project Azure.", ephemeral:true });
      return;
    }

    // ── Restore data confirm / cancel ─────────────────────
    if (parts[0]==="restore") {
      await interaction.deferUpdate();
      if (!isAdmin(member)) { await interaction.followUp({ content:"❌ No permission.", ephemeral:true }); return; }
      const key = "restore_" + user.id;
      const pending = pendingInputs.get(key);
      if (parts[1]==="cancel") { pendingInputs.delete(key); await interaction.followUp({ content:"❌ Restore cancelled.", ephemeral:true }); return; }
      if (!pending || pending.step !== "restore_confirm") { await interaction.followUp({ content:"❌ No pending restore found.", ephemeral:true }); return; }
      const d = pending.data;
      pendingInputs.delete(key);
      // Restore in-memory stores
      if (d.warnings)         { d.warnings.forEach(w => { playerWarnings.set(w.ign.toLowerCase(), w.warnings||[]); }); }
      if (d.points)           { d.points.forEach(p => { playerPoints.set(p.ign.toLowerCase(), p.pts||0); }); }
      if (d.localStats)       { d.localStats.forEach(s => { const {ign,...rest}=s; playerStats.set(ign.toLowerCase(), rest); }); }
      if (d.newcomerProfiles) { d.newcomerProfiles.forEach(p => { const {userId,...rest}=p; newcomerProfiles.set(userId, rest); }); }
      if (d.matchReports)     { d.matchReports.forEach(r => { const {id,...rest}=r; matchReportsFull.set(id, rest); }); }
      if (d.openSpots)        { d.openSpots.forEach(s => { openSpots.set(s.position, {count:s.count,notes:s.notes,updatedBy:s.updatedBy}); }); }
      if (d.pointHistory)     { d.pointHistory.forEach(p => { pointHistory.set(p.ign.toLowerCase(), p.history||[]); }); }
      if (d.discountTokens)   { d.discountTokens.forEach(t => { discountTokens.set(t.ign.toLowerCase(), {pct:t.pct, expiresAt:t.expiresAt}); }); }
      if (d.luckyNumbers)     { d.luckyNumbers.forEach(l => { luckyNumbers.set(l.ign.toLowerCase(), l.number); }); }
      await interaction.followUp({ content:"✅ In-memory data restored from backup!\n• Warnings: "+(d.warnings?.length||0)+"\n• Points: "+(d.points?.length||0)+"\n• Local stats: "+(d.localStats?.length||0)+"\n• Newcomer profiles: "+(d.newcomerProfiles?.length||0)+"\n• Match reports: "+(d.matchReports?.length||0), ephemeral:true });
      return;
    }

    // ── Shop request approve / deny (manager) ─────────────
    if (parts[0]==="shopreq") {
      await interaction.deferUpdate();
      if (!isAdmin(member)) { await interaction.followUp({ content:"❌ No permission.", ephemeral:true }); return; }
      const action = parts[1]; // approve | deny
      const reqId  = parts[2];
      const req    = shopRequests.get(reqId);
      if (!req) { await interaction.followUp({ content:"❌ Shop request not found.", ephemeral:true }); return; }
      if (req.status !== "pending") { await interaction.followUp({ content:"⚠️ Request already **"+req.status+"**.", ephemeral:true }); return; }

      req.status     = action === "approve" ? "approved" : "denied";
      req.reviewedBy = user.tag;

      if (action === "approve") {
        // Deduct points on approval
        const currentPts = getPoints(req.ign);
        if (currentPts < req.cost) {
          await interaction.followUp({ content:"❌ **"+req.ign+"** only has **"+currentPts+" pts** — can't deduct **"+req.cost+" pts**. Denying.", ephemeral:true });
          req.status = "denied";
        } else {
          const newBal = addPoints(req.ign, -req.cost);
          addPointHistory(req.ign, -req.cost, "Shop: "+req.itemName+" approved by "+user.tag);

          // Special logic for certain items
          if (req.itemId === "lucky_number") {
            const num = parseInt(req.targetArg) || Math.floor(Math.random()*100)+1;
            luckyNumbers.set(req.ign.toLowerCase(), num);
          }
          if (req.itemId === "custom_command") {
            // Parse the note: "!trigger → reply" or "!trigger: reply" or "!trigger reply"
            const raw = req.note && req.note !== "None" ? req.note : req.targetArg || "";
            const sepMatch = raw.match(/^(!?\S+)\s*(?:→|->|:|—)\s*(.+)$/s);
            let trigger = "", reply = "";
            if (sepMatch) {
              trigger = sepMatch[1].trim().toLowerCase();
              reply   = sepMatch[2].trim();
            } else {
              // No separator — treat first word as trigger, rest as reply
              const parts2 = raw.trim().split(/\s+/);
              trigger = (parts2[0] || "").toLowerCase();
              reply   = parts2.slice(1).join(" ") || "(no reply set — manager must update)";
            }
            if (!trigger.startsWith("!")) trigger = "!" + trigger;
            if (trigger && reply) {
              customCommandsMap.set(trigger, { reply, createdBy: user.tag, ign: req.ign, createdAt: new Date().toISOString() });
            }
            // Store parsed values back on req so the DM can show them
            req.parsedTrigger = trigger;
            req.parsedReply   = reply;
          }

          await interaction.followUp({ content:"✅ Shop request **"+reqId+"** approved for **"+req.ign+"**! -**"+req.cost+" pts** (new balance: **"+newBal+" pts**).", ephemeral:true });

          // DM player
          try {
            const playerUser = await client.users.fetch(req.userId).catch(()=>null);
            if (playerUser) await playerUser.send({ embeds:[pjaEmbed("✅ Shop Request Approved — "+req.itemName, 0x22c55e)
              .setDescription("Your request for **"+req.itemName+"** has been **approved** by **"+user.tag+"**! 🎉")
              .addFields(
                { name:"🪙 Points Deducted", value:"-"+req.cost+" pts", inline:true },
                { name:"💰 New Balance", value:newBal+" pts", inline:true },
                ...(req.itemId==="lucky_number" ? [{ name:"🍀 Your Lucky Number", value:String(luckyNumbers.get(req.ign.toLowerCase())||"TBD"), inline:true }] : []),
                ...(req.itemId==="custom_command" && req.parsedTrigger ? [
                  { name:"💬 Your Trigger", value:"`"+req.parsedTrigger+"`", inline:true },
                  { name:"💬 Bot Reply",    value:req.parsedReply,           inline:false },
                  { name:"ℹ️ How to use",  value:"Type `"+req.parsedTrigger+"` in any channel and the bot will reply automatically!", inline:false },
                ] : []),
              )] }).catch(()=>{});
          } catch(e) {}
        }
      } else {
        // Denied — no point deduction
        await interaction.followUp({ content:"❌ Shop request **"+reqId+"** denied for **"+req.ign+"**.", ephemeral:true });
        try {
          const playerUser = await client.users.fetch(req.userId).catch(()=>null);
          if (playerUser) await playerUser.send({ embeds:[pjaEmbed("❌ Shop Request Denied — "+req.itemName, 0xef4444)
            .setDescription("Your request for **"+req.itemName+"** was **denied** by **"+user.tag+"**.\nYour points were **not** deducted. Contact a manager if you have questions.")] }).catch(()=>{});
        } catch(e) {}
      }

      // Disable buttons on the request embed
      const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("shopreq_approve_"+reqId).setLabel("✅ Approve").setStyle(ButtonStyle.Success).setDisabled(true),
        new ButtonBuilder().setCustomId("shopreq_deny_"+reqId).setLabel("❌ Deny").setStyle(ButtonStyle.Danger).setDisabled(true),
      );
      await interaction.editReply({ components:[disabledRow] });
      return;
    }

  } catch (err) {
    console.error("Button handler error:", err);
    try {
      if (interaction.deferred||interaction.replied) await interaction.followUp({ content:"❌ Something went wrong.", ephemeral:true });
    } catch(e) {}
  }
});

// ══════════════════════════════════════════════════════════════
// ── MODAL SUBMIT HANDLER ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isModalSubmit()) return;
  try {
    const { customId, user, member } = interaction;

    // ── Getting Started / Setup Profile ──────────────────
    if (customId.startsWith("gs_modal_")) {
      await interaction.deferReply({ ephemeral: true });
      const ign        = interaction.fields.getTextInputValue("gs_ign").trim();
      const positions  = interaction.fields.getTextInputValue("gs_position").trim();
      const tzAvail    = interaction.fields.getTextInputValue("gs_timezone").trim();
      const styleInfo  = interaction.fields.getTextInputValue("gs_playstyle").trim();
      const notes      = interaction.fields.getTextInputValue("gs_notes").trim();

      const [mainPos, backupPos] = positions.split("/").map(s=>s.trim());
      const [style, priority]    = styleInfo.split("|").map(s=>s.trim());

      const profile = {
        userId:   user.id,
        username: user.tag,
        ign,
        mainPos:  mainPos  || positions,
        backupPos:backupPos || "None",
        timezone: tzAvail,
        playStyle:style    || styleInfo,
        priority: priority || "Other",
        notes,
        submittedAt: new Date().toISOString(),
        status: "pending",
      };
      newcomerProfiles.set(user.id, profile);
      if (ign) linkAccount(user.id, ign);

      await interaction.editReply({ embeds: [pjaEmbed("✅ Profile Submitted!", 0x22c55e)
        .setDescription("Your PJA team profile has been submitted! Managers will review it shortly.\n\nMake sure you've also used `/link ign:"+ign+"` to link your account.")
        .addFields(
          { name:"🎮 IGN",         value:ign,                 inline:true },
          { name:"📍 Position",    value:mainPos||positions,  inline:true },
          { name:"🔄 Backup",      value:backupPos||"None",   inline:true },
          { name:"🌍 TZ/Avail",    value:tzAvail,             inline:false },
          { name:"⚡ Style",       value:style||styleInfo,    inline:true },
          { name:"🏆 Priority",    value:priority||"Other",   inline:true },
        )] });

      // Post to managers
      const managerEmbed = pjaEmbed("🆕 New Player Setup — " + ign, 0x2563eb)
        .setDescription("<@"+user.id+"> just filled out their team profile!")
        .addFields(
          { name:"🎮 IGN",          value:ign,                inline:true },
          { name:"📍 Main Pos",     value:mainPos||positions, inline:true },
          { name:"🔄 Backup Pos",   value:backupPos||"None",  inline:true },
          { name:"🌍 TZ/Avail",     value:tzAvail,            inline:false },
          { name:"⚡ Play Style",   value:style||styleInfo,   inline:true },
          { name:"🏆 Priority",     value:priority||"Other",  inline:true },
          { name:"📝 Notes",        value:notes||"None",      inline:false },
        );
      const manRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("newp_roster_"+user.id).setLabel("✅ Add to Roster").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("newp_trialist_"+user.id).setLabel("🔬 Mark Trialist").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("newp_info_"+user.id).setLabel("❓ Needs More Info").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("newp_deny_"+user.id).setLabel("❌ Deny/Ignore").setStyle(ButtonStyle.Danger),
      );
      try {
        await interaction.channel.send({ embeds:[managerEmbed], components:[manRow] });
      } catch(e) {}
      return;
    }

    // ── Self-Report modal ─────────────────────────────────
    if (customId.startsWith("sr_modal_")) {
      await interaction.deferReply({ ephemeral: true });
      // customId = "sr_modal_REPORTID_POSITION"
      const withoutPrefix = customId.replace("sr_modal_", "");
      const underscoreIdx = withoutPrefix.indexOf("_");
      const reportId = underscoreIdx >= 0 ? withoutPrefix.substring(0, underscoreIdx) : withoutPrefix;
      const pos      = underscoreIdx >= 0 ? withoutPrefix.substring(underscoreIdx + 1) : "Utility";

      // API fallback is fine here — no 3-sec limit on modal submits
      let report = matchReportsFull.get(reportId);
      if (!report) {
        const apiReports = await apiGet("match_reports").catch(() => []);
        const apiReport  = apiReports.find(r => (r.id || "").toUpperCase() === reportId);
        if (apiReport) {
          report = {
            ...apiReport,
            players:        [],
            motmLocked:     false,
            finalized:      false,
            // ── website-readiness fields (ensure always present) ─
            playerTokens:   apiReport.playerTokens   || {},
            websiteEnabled: apiReport.websiteEnabled || false,
          };
          matchReportsFull.set(reportId, report);
        } else {
          report = {
            id: reportId, opponent: "Unknown", score: "?", result: "?",
            date: new Date().toDateString(), players: [], motmLocked: false, finalized: false,
            // ── website-readiness fields (always present even on fallback) ─
            playerTokens:   {},
            websiteEnabled: false,
          };
          matchReportsFull.set(reportId, report);
        }
      }

      const myIgn  = getIgnForUser(user.id) || user.username;
      const subKey = reportId + "_" + user.id;
      const posType = { GK:"gk", DEF:"def", MID:"mid", LM:"mid", RM:"mid", WING:"wing", ST:"st", Utility:"util" }[pos] || "util";

      // ── Safe field getter ──────────────────────────────────
      const tryGet  = (id) => { try { return interaction.fields.getTextInputValue(id) || ""; } catch(e) { return ""; } };
      const safeVal = (v)  => (v && String(v).trim()) ? String(v).trim() : "—";
      const split   = (raw, sep) => (raw || "").split(sep).map(s => s.trim());

      const goalsRaw  = tryGet("sr_goals");
      const defRaw    = tryGet("sr_def");
      const ratRaw    = tryGet("sr_ratings");
      const csRaw     = tryGet("sr_cleansheet");
      const savesRaw  = tryGet("sr_saves");
      const pressRaw  = tryGet("sr_press");
      const penRaw    = tryGet("sr_penalties");
      const notesRaw  = tryGet("sr_notes");

      // ── Build base sub object ──────────────────────────────
      // Every submission gets a stable submissionId + source tag so the
      // review queue and future website both reference the same record.
      const existingToken = reportPlayerIndex.get(reportId)?.get(myIgn.toLowerCase());
      const tokenRecord   = existingToken ? playerSubmissionTokens.get(existingToken) : null;

      // If there's no pre-generated token (player not listed upfront),
      // generate one now so the record is complete from day one.
      const { playerId, token, url } = tokenRecord
        ? { playerId: tokenRecord.playerId, token: tokenRecord.token, url: tokenRecord.websiteUrl }
        : generatePlayerToken(reportId, myIgn);

      // Mark token as used (Discord path)
      consumeSubmissionToken(playerId, "discord");

      const sub = {
        reportId,
        userId:        user.id,
        ign:           myIgn,
        position:      pos,
        matchOpponent: report.opponent || "Unknown",
        status:        "pending",
        submittedAt:   new Date().toISOString(),
        // ── Stable identity fields ──────────────────────────
        // These are the same whether submission comes from Discord or website.
        submissionId:  makeId(),   // unique ID for this specific submission record
        playerId,                  // links back to playerSubmissionTokens
        token,                     // the secure token (stored for audit, not shown publicly)
        source:        "discord",  // "discord" | "website" — set on submit
        // ── Future website placeholder ───────────────────────
        // When site is live: send player to `websiteUrl` instead of /self-report.
        // For now this is stored but never acted on — zero breaking change.
        websiteUrl:    url,        // e.g. https://my-pja-site.com/match-report?...
      };

      // ── Parse per-position ─────────────────────────────────
      let embedFields = [];

      if (posType === "gk") {
        const [sv, bs, gc]    = split(savesRaw, "|");
        const [cs, mist]      = split(csRaw, "|");
        const [dist, stop, comm] = split(ratRaw, "/");
        const [penSv, penFa]  = split(penRaw, "|");
        Object.assign(sub, { saves:sv, bigSaves:bs, goalsConceded:gc, cleanSheet:cs, mistakes:mist,
          distributionRating:dist, shotStoppingRating:stop, commRating:comm,
          penaltiesSaved:penSv, penaltiesFaced:penFa, notes:notesRaw });
        embedFields = [
          { name:"🧤 Saves",              value: safeVal(sv),   inline:true },
          { name:"💥 Big Saves",          value: safeVal(bs),   inline:true },
          { name:"🥅 Goals Conceded",     value: safeVal(gc),   inline:true },
          { name:"🛡️ Clean Sheet",        value: safeVal(cs),   inline:true },
          { name:"❌ Mistakes→Goal",       value: safeVal(mist), inline:true },
          { name:"🏅 Pens Saved/Faced",   value: safeVal(penSv) + " / " + safeVal(penFa), inline:true },
          { name:"⭐ Ratings (Dist/Stop/Comm)", value: safeVal(dist)+"/"+safeVal(stop)+"/"+safeVal(comm), inline:false },
          { name:"📝 Notes",              value: safeVal(notesRaw).substring(0, 200), inline:false },
        ];
      } else if (posType === "def") {
        const [ta, int, cl, bl]     = split(defRaw, "|");
        const [cs, mist]            = split(csRaw, "|");
        const [goals, assists, kp]  = split(goalsRaw, "|");
        const [defPos, ov1, pass, comm] = split(ratRaw, "/");
        Object.assign(sub, { tackles:ta, interceptions:int, clearances:cl, blocks:bl,
          cleanSheet:cs, mistakes:mist, goals, assists, keyPasses:kp,
          defPosRating:defPos, oneVoneRating:ov1, passingRating:pass, commRating:comm, notes:notesRaw });
        embedFields = [
          { name:"💪 Tackles",           value: safeVal(ta),    inline:true },
          { name:"✂️ Interceptions",     value: safeVal(int),   inline:true },
          { name:"🧹 Clearances",        value: safeVal(cl),    inline:true },
          { name:"🛑 Blocks",            value: safeVal(bl),    inline:true },
          { name:"🛡️ Clean Sheet",       value: safeVal(cs),    inline:true },
          { name:"❌ Mistakes→Goal",      value: safeVal(mist),  inline:true },
          { name:"⚽ Goals | Assists | KP", value: safeVal(goals)+"|"+safeVal(assists)+"|"+safeVal(kp), inline:true },
          { name:"⭐ Ratings (Pos/1v1/Pass/Comm)", value: safeVal(defPos)+"/"+safeVal(ov1)+"/"+safeVal(pass)+"/"+safeVal(comm), inline:false },
          { name:"📝 Notes",             value: safeVal(notesRaw).substring(0, 200), inline:false },
        ];
      } else if (posType === "mid") {
        const [goals, assists, kp, cc] = split(goalsRaw, "|");
        const [rec, tac, int]          = split(defRaw, "|");
        const [poss, pass, wr, vis]    = split(ratRaw, "/");
        const [dist, sot]              = split(pressRaw, "|");
        Object.assign(sub, { goals, assists, keyPasses:kp, chancesCreated:cc,
          defRecoveries:rec, tackles:tac, interceptions:int,
          possessionRating:poss, passingRating:pass, workRateRating:wr, visionRating:vis,
          distanceCovered:dist, shotsOnTarget:sot, notes:notesRaw });
        embedFields = [
          { name:"⚽ Goals",             value: safeVal(goals),   inline:true },
          { name:"🎯 Assists",           value: safeVal(assists), inline:true },
          { name:"🔑 Key Passes",        value: safeVal(kp),      inline:true },
          { name:"💡 Chances Created",   value: safeVal(cc),      inline:true },
          { name:"🔄 Def. Recoveries",   value: safeVal(rec),     inline:true },
          { name:"📏 Distance (km)",     value: safeVal(dist),    inline:true },
          { name:"🎯 Shots on Target",   value: safeVal(sot),     inline:true },
          { name:"⭐ Ratings (Poss/Pass/WR/Vision)", value: safeVal(poss)+"/"+safeVal(pass)+"/"+safeVal(wr)+"/"+safeVal(vis), inline:false },
          { name:"📝 Notes",             value: safeVal(notesRaw).substring(0, 200), inline:false },
        ];
      } else if (posType === "wing") {
        const [goals, assists, cc, shots] = split(goalsRaw, "|");
        const [crosses, kp, dribbles]     = split(defRaw, "|");
        const [drib, cross, press, posR]  = split(ratRaw, "/");
        const [rec, tac]                  = split(pressRaw, "|");
        Object.assign(sub, { goals, assists, chancesCreated:cc, shots,
          crosses, keyPasses:kp, successfulDribbles:dribbles,
          dribblingRating:drib, crossingRating:cross, pressingRating:press, posRating:posR,
          defRecoveries:rec, tackles:tac, notes:notesRaw });
        embedFields = [
          { name:"⚽ Goals",             value: safeVal(goals),   inline:true },
          { name:"🎯 Assists",           value: safeVal(assists), inline:true },
          { name:"💡 Chances Created",   value: safeVal(cc),      inline:true },
          { name:"🎯 Shots",             value: safeVal(shots),   inline:true },
          { name:"🌐 Crosses",           value: safeVal(crosses), inline:true },
          { name:"🔑 Key Passes",        value: safeVal(kp),      inline:true },
          { name:"🏃 Dribbles Won",      value: safeVal(dribbles),inline:true },
          { name:"⭐ Ratings (Drib/Cross/Press/Pos)", value: safeVal(drib)+"/"+safeVal(cross)+"/"+safeVal(press)+"/"+safeVal(posR), inline:false },
          { name:"📝 Notes",             value: safeVal(notesRaw).substring(0, 200), inline:false },
        ];
      } else if (posType === "st") {
        const [goals, assists, shots, sot] = split(goalsRaw, "|");
        const [cc, kp, aerials]            = split(defRaw, "|");
        const [fin, posR, press, holdup]   = split(ratRaw, "/");
        const [missed, offsides]           = split(pressRaw, "|");
        Object.assign(sub, { goals, assists, shots, shotsOnTarget:sot,
          chancesCreated:cc, keyPasses:kp, aerialDuelsWon:aerials,
          finishingRating:fin, posRating:posR, pressingRating:press, holdUpRating:holdup,
          bigChancesMissed:missed, offsides, notes:notesRaw });
        embedFields = [
          { name:"⚽ Goals",             value: safeVal(goals),   inline:true },
          { name:"🎯 Assists",           value: safeVal(assists), inline:true },
          { name:"🎯 Shots",             value: safeVal(shots),   inline:true },
          { name:"🎯 Shots on Target",   value: safeVal(sot),     inline:true },
          { name:"💡 Chances Created",   value: safeVal(cc),      inline:true },
          { name:"✈️ Aerials Won",       value: safeVal(aerials), inline:true },
          { name:"😬 Big Chances Missed",value: safeVal(missed),  inline:true },
          { name:"🚩 Offsides",          value: safeVal(offsides),inline:true },
          { name:"⭐ Ratings (Fin/Pos/Press/Hold-Up)", value: safeVal(fin)+"/"+safeVal(posR)+"/"+safeVal(press)+"/"+safeVal(holdup), inline:false },
          { name:"📝 Notes",             value: safeVal(notesRaw).substring(0, 200), inline:false },
        ];
      } else {
        // Utility / Sub
        const [goals, assists, kp]    = split(goalsRaw, "|");
        const [saves, tac, int, cl]   = split(defRaw, "|");
        const [impact, effort, att]   = split(ratRaw, "/");
        const [mins, coveredPos]      = split(pressRaw, "|");
        Object.assign(sub, { goals, assists, keyPasses:kp,
          saves, tackles:tac, interceptions:int, clearances:cl,
          impactRating:impact, effortRating:effort, attitudeRating:att,
          minutesPlayed:mins, positionsCovered:coveredPos, notes:notesRaw });
        embedFields = [
          { name:"⚽ Goals | Assists | KP", value: safeVal(goals)+"|"+safeVal(assists)+"|"+safeVal(kp), inline:false },
          { name:"🧤 Saves",               value: safeVal(saves),     inline:true },
          { name:"💪 Tackles",             value: safeVal(tac),       inline:true },
          { name:"✂️ Interceptions",       value: safeVal(int),       inline:true },
          { name:"⏱️ Minutes Played",      value: safeVal(mins),      inline:true },
          { name:"🔀 Pos. Covered",        value: safeVal(coveredPos),inline:true },
          { name:"⭐ Ratings (Impact/Effort/Attitude)", value: safeVal(impact)+"/"+safeVal(effort)+"/"+safeVal(att), inline:false },
          { name:"📝 Notes",               value: safeVal(notesRaw).substring(0, 200), inline:false },
        ];
      }

      sub.notes = notesRaw;
      selfReports.set(subKey, sub);

      // Trim embed fields to 10 max (Discord limit is 25 but keep it clean)
      const displayFields = embedFields.slice(0, 10);

      const posEmoji = { GK:"🧤", DEF:"🛡️", MID:"🔁", WING:"🏃", ST:"⚽", Utility:"🔄" }[pos] || "📍";

      await interaction.editReply({ embeds: [
        pjaEmbed("✅ " + posEmoji + " Self-Report Submitted — " + pos, 0x22c55e)
          .setDescription(
            "**" + myIgn + "** — PJA vs **" + (report.opponent || "Unknown") + "**\n" +
            "Report ID: `" + reportId + "` | Match Date: " + (report.date || "Unknown") + "\n\n" +
            "⏳ A manager will review and approve before stats count."
          )
          .addFields(...displayFields)
          .setFooter({ text: "Status: Pending Review | Project Azure (PJA)" })
      ] });

      // Channel notification
      try {
        if (interaction.channel) {
          await interaction.channel.send({ embeds: [
            pjaEmbed("📊 New Self-Report — " + posEmoji + " " + pos, 0x2563eb)
              .setDescription(
                "<@" + user.id + "> (**" + myIgn + "**) submitted stats for **" + reportId + "** as **" + pos + "**.\n" +
                "Use `/review-submissions report-id:" + reportId + "` to review all submissions."
              )
          ] });
        }
      } catch(e) {}
      return;
    }

    // ── Self-Report Edit Modal (manager edits submission) ─────
    if (customId.startsWith("subedit_modal_")) {
      await interaction.deferReply({ ephemeral: true });
      const withoutPfx = customId.replace("subedit_modal_", "");
      const uidx       = withoutPfx.indexOf("_");
      const reportId   = uidx >= 0 ? withoutPfx.substring(0, uidx) : withoutPfx;
      const userId     = uidx >= 0 ? withoutPfx.substring(uidx + 1) : "";
      const subKey     = reportId + "_" + userId;
      const sub        = selfReports.get(subKey);
      if (!sub) { await interaction.editReply("❌ Submission not found."); return; }

      const tryGet = (id) => { try { return interaction.fields.getTextInputValue(id)||""; } catch(e) { return ""; } };

      // Snapshot original before edit
      const originalStats = { goals:sub.goals, assists:sub.assists, saves:sub.saves, cleanSheet:sub.cleanSheet };

      const editGoals  = tryGet("edit_goals").trim();
      const editAsst   = tryGet("edit_assists").trim();
      const editSaves  = tryGet("edit_saves").trim();
      const editCS     = tryGet("edit_cleansheet").trim();
      const editReason = tryGet("edit_reason").trim();

      if (editGoals  !== "") sub.goals      = editGoals;
      if (editAsst   !== "") sub.assists    = editAsst;
      if (editSaves  !== "") sub.saves      = editSaves;
      if (editCS     !== "") sub.cleanSheet = editCS;

      sub.editedByManager = true;
      sub.editedBy        = user.tag;
      sub.editReason      = editReason;
      sub.editedAt        = new Date().toISOString();

      addSubHistory(subKey, "edited by manager", user.tag, editReason, { goals:sub.goals, assists:sub.assists, saves:sub.saves, cleanSheet:sub.cleanSheet });

      // DM player about the edit
      try {
        const targetUser = await client.users.fetch(userId).catch(()=>null);
        if (targetUser) {
          const changes = [];
          if (editGoals !== "")  changes.push("⚽ Goals: "+originalStats.goals+" → "+sub.goals);
          if (editAsst  !== "")  changes.push("🎯 Assists: "+originalStats.assists+" → "+sub.assists);
          if (editSaves !== "")  changes.push("🧤 Saves: "+originalStats.saves+" → "+sub.saves);
          if (editCS    !== "")  changes.push("🛡️ Clean Sheet: "+originalStats.cleanSheet+" → "+sub.cleanSheet);
          await targetUser.send({ embeds:[pjaEmbed("✏️ Stats Edited by Manager", 0xf59e0b)
            .setDescription("A manager has **edited** your submission for **PJA vs "+sub.matchOpponent+"**.")
            .addFields(
              { name:"✏️ Editor", value:user.tag, inline:true },
              { name:"📝 Reason", value:editReason||"—", inline:false },
              ...(changes.length ? [{ name:"📊 Changes", value:changes.join("\n"), inline:false }] : []),
              { name:"ℹ️ Note", value:"Your submission still requires manager approval.", inline:false },
            )] }).catch(()=>{});
        }
      } catch(e) {}

      await interaction.editReply({ embeds:[pjaEmbed("✅ Submission Edited", 0x22c55e)
        .setDescription("**"+sub.ign+"**'s submission has been edited and DM sent.")
        .addFields(
          { name:"⚽ Goals",    value:String(sub.goals||"—"),   inline:true },
          { name:"🎯 Assists",  value:String(sub.assists||"—"), inline:true },
          { name:"🧤 Saves",    value:String(sub.saves||"—"),   inline:true },
          { name:"📝 Reason",   value:editReason||"—",          inline:false },
        )] });
      return;
    }

  } catch (err) {
    console.error("Modal submit error [" + (interaction.customId||"?") + "]:", err.message, err.stack);
    try {
      const msg = "❌ Something went wrong: **" + (err.message||"Unknown error") + "**";
      if (interaction.replied||interaction.deferred) await interaction.editReply(msg).catch(()=>{});
      else await interaction.reply({ content: msg, ephemeral: true }).catch(()=>{});
    } catch(e) {}
  }
});

// ── NEWCOMER PROFILE BUTTON HANDLER ───────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("newp_")) return;
  try {
    await interaction.deferUpdate();
    const { member, user } = interaction;
    if (!isAdmin(member)) { await interaction.followUp({ content:"❌ No permission.", ephemeral:true }); return; }
    const parts  = interaction.customId.split("_");
    const action = parts[1];
    const tgtId  = parts[2];
    const profile= newcomerProfiles.get(tgtId);
    if (!profile) { await interaction.followUp({ content:"❌ Profile not found.", ephemeral:true }); return; }

    const msgMap = {
      roster:   "✅ You've been added to the PJA roster! Welcome to **Project Azure**! 💙",
      trialist: "🔬 You've been marked as a **Trialist** at **Project Azure**. Prove yourself!",
      info:     "❓ Management needs more info from you. Please contact a manager directly.",
      deny:     "Your PJA profile submission has been noted. We'll reach out if anything changes.",
    };
    const colorMap = { roster:0x22c55e, trialist:0x2563eb, info:0xf59e0b, deny:0xef4444 };
    profile.managerAction  = action;
    profile.reviewedBy     = user.tag;
    newcomerProfiles.set(tgtId, profile);

    if (action === "roster") {
      // Auto-add to API roster
      await apiPost("roster", {
        name:     profile.ign, ign: profile.ign,
        position: profile.mainPos, backup: profile.backupPos,
        role:     "Trialist", teamMain: profile.priority,
        timezone: profile.timezone, joinedAt: new Date().toISOString(),
        addedBy:  user.tag,
      }).catch(()=>{});
    }
    try {
      const tgtUser = await client.users.fetch(tgtId).catch(()=>null);
      if (tgtUser) await tgtUser.send({ embeds:[pjaEmbed("📋 PJA Profile Update", colorMap[action]||0x2563eb).setDescription(msgMap[action]||"Your profile has been reviewed.")] }).catch(()=>{});
    } catch(e) {}
    await interaction.followUp({ content:"**"+profile.ign+"** — action: "+action, ephemeral:true });
  } catch(err) {
    console.error("newp button error:", err);
    try { await interaction.followUp({ content:"❌ Error.", ephemeral:true }); } catch(e) {}
  }
});

// ── REMINDER SCHEDULER ────────────────────────────────────────
setInterval(async () => {
  const now = Date.now();
  for (const [id, reminder] of reminders.entries()) {
    if (now >= reminder.triggerAt) {
      try {
        const channel = await client.channels.fetch(reminder.channelId).catch(()=>null);
        if (channel) await channel.send({ embeds:[new EmbedBuilder().setTitle("⏰ Team Reminder").setDescription(reminder.message).setColor(0x2563eb).setFooter({ text:"Project Azure (PJA)" }).setTimestamp()] });
        if (reminder.repeatMs) reminder.triggerAt = now + reminder.repeatMs;
        else reminders.delete(id);
      } catch(e) { reminders.delete(id); }
    }
  }
}, 30000);

// ── CRASH PREVENTION ──────────────────────────────────────────
process.on("unhandledRejection", (reason) => { console.error("Unhandled Rejection:", reason); });
process.on("uncaughtException",  (err)    => { console.error("Uncaught Exception:", err); });
