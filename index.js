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
const SHOP_ITEMS = [
  { id: "nickname_color", name: "Custom Nickname Colour",         cost: 50,  desc: "Get a custom coloured role that changes your nickname colour in the server." },
  { id: "profile_badge",  name: "Profile Badge",                  cost: 75,  desc: "Get a fully custom role — you choose the name AND the colour." },
  { id: "shoutout",       name: "Team Shoutout",                  cost: 30,  desc: "Get a personal shoutout posted in the announcements channel." },
  { id: "featured_card",  name: "Featured Player Card",           cost: 100, desc: "Get featured as Player of the Week with a special card in announcements." },
  { id: "clip_feature",   name: "Clip Featured in Announcements", cost: 80,  desc: "Submit a clip to be featured in the team's announcements channel." },
  { id: "custom_title",   name: "Custom Title",                   cost: 60,  desc: "Get a custom titled role — you choose the title AND the colour." },
];

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
    .addStringOption(o => o.setName("notes").setDescription("Extra notes").setRequired(false)),

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
        { name:"Custom Nickname Colour (50pts)", value:"nickname_color" },
        { name:"Profile Badge (75pts)",           value:"profile_badge" },
        { name:"Team Shoutout (30pts)",            value:"shoutout" },
        { name:"Featured Player Card (100pts)",    value:"featured_card" },
        { name:"Clip Featured (80pts)",            value:"clip_feature" },
        { name:"Custom Title (60pts)",             value:"custom_title" }
      ))
    .addStringOption(o => o.setName("ign").setDescription("Your VRFS IGN — leave blank if you're linked. Managers only: use this to redeem for another player.").setRequired(false))
    .addStringOption(o => o.setName("note").setDescription("Extra note for your redemption (optional)").setRequired(false)),

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
        { name: "Custom Nickname Colour", value: "nickname_color" },
        { name: "Profile Badge",          value: "profile_badge" },
        { name: "Team Shoutout",          value: "shoutout" },
        { name: "Featured Player Card",   value: "featured_card" },
        { name: "Clip Featured",          value: "clip_feature" },
        { name: "Custom Title",           value: "custom_title" }
      ))
    .addIntegerOption(o => o.setName("price").setDescription("New price in PJA points (1–9999)").setRequired(true).setMinValue(1).setMaxValue(9999)),

  // ── MATCH REPORT SYSTEM ───────────────────────────────────────

  new SlashCommandBuilder().setName("getting-started").setDescription("New to PJA? Fill out your team profile here"),

  new SlashCommandBuilder().setName("setup-profile").setDescription("Fill out your PJA team profile (same as /getting-started)"),

  new SlashCommandBuilder().setName("self-report").setDescription("Submit your stats for a match you played in")
    .addStringOption(o => o.setName("report-id").setDescription("Match report ID (from manager)").setRequired(true)),

  new SlashCommandBuilder().setName("motm-vote").setDescription("Vote for Man of the Match")
    .addStringOption(o => o.setName("report-id").setDescription("Match report ID").setRequired(true))
    .addStringOption(o => o.setName("vote-for").setDescription("IGN of the player you're voting for").setRequired(true)),

  new SlashCommandBuilder().setName("review-submissions").setDescription("Review player self-reports for a match [Manager only]")
    .addStringOption(o => o.setName("report-id").setDescription("Match report ID").setRequired(true)),

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
// ── SLASH COMMAND HANDLER ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════
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
      });
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
      const embed = pjaEmbed("🛒 PJA Team Reward Shop", 0x2563eb)
        .setDescription(
          "Earn **PJA Points** by attending practice, playing matches, winning MOTM, and more!\n" +
          "Use `/redeem` to spend your points. Managers approve all redemptions.\n\n" +
          "**Check your balance:** `/points`"
        )
        .addFields(SHOP_ITEMS.map(item => ({
          name:  item.name + " — 🪙 **" + item.cost + " pts**",
          value: "> " + item.desc + "\n> **ID:** `" + item.id + "`",
          inline: false,
        })));
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
      const note        = interaction.options.getString("note") || "None";
      const item        = SHOP_ITEMS.find(i => i.id === itemId);
      if (!item) { await interaction.editReply("❌ Item not found. Use `/shop` to see items."); return; }

      const providedIgn = interaction.options.getString("ign");
      const linkedIgn   = getIgnForUser(user.id);
      const managerMode = isAdmin(member) && providedIgn && providedIgn.toLowerCase() !== (linkedIgn || "").toLowerCase();

      // ── IGN resolution ────────────────────────────────────
      // Managers can provide any IGN (redemption for another player)
      // Regular players: if they provide an IGN it must match their own linked IGN
      let ign;
      if (providedIgn) {
        if (!managerMode && linkedIgn && providedIgn.toLowerCase() !== linkedIgn.toLowerCase()) {
          // Player tried to redeem using someone else's IGN — block it
          await interaction.editReply(
            "⚠️ **Hold on!**\n" +
            "You tried to redeem using **"+providedIgn+"** but your account is linked to **"+linkedIgn+"**.\n\n" +
            "🚨 **Warning:** Using `/redeem` with another player's IGN to spend their points or send them DMs is not allowed and **will result in a strike** from a manager.\n\n" +
            "If you meant to redeem for yourself, just leave the `ign` field blank."
          );
          return;
        }
        if (!managerMode && !linkedIgn) {
          // Not linked but provided an IGN — allow it but warn them to link
          ign = providedIgn;
        } else {
          ign = providedIgn;
        }
      } else {
        // No IGN provided — must be linked
        if (!linkedIgn) {
          await interaction.editReply(
            "❌ You haven't linked your VRFS IGN yet!\n" +
            "Use `/link ign:YourIGN` to link your account, then you won't need to type your IGN every time."
          );
          return;
        }
        ign = linkedIgn;
      }

      // ── Points check ──────────────────────────────────────
      // For manager gifting another player: deduct from the manager's own points
      // unless the target player has enough themselves
      const spendingIgn = managerMode ? ign : ign; // always the target's IGN for points
      const currentPts  = getPoints(spendingIgn);
      if (currentPts < item.cost) {
        await interaction.editReply(
          "❌ Not enough points!\n**"+ign+"** has **"+currentPts+" pts** but **"+item.name+"** costs **"+item.cost+" pts**."
        );
        return;
      }

      const redeemId   = makeId();
      const redeemData = {
        id: redeemId, userId: user.id, username: user.tag,
        ign, item: item.name, itemId: item.id, cost: item.cost,
        note, status: "pending", giftedBy: managerMode ? user.tag : null,
        createdAt: new Date().toISOString()
      };
      shopRedemptions.set(redeemId, redeemData);

      // ── Build confirmation embed ──────────────────────────
      const isGift        = managerMode;
      const warningField  = !linkedIgn && !isGift
        ? [{ name: "⚠️ Account not linked", value: "You're not linked yet. Use `/link ign:"+ign+"` to link your account so you don't need to type your IGN next time.", inline: false }]
        : [];

      const confirmEmbed = pjaEmbed("🛍️ Confirm Redemption — "+item.name, isGift ? 0xf59e0b : 0x2563eb)
        .setDescription(
          isGift
            ? "🎁 You're gifting **"+item.name+"** to **"+ign+"** as a manager. Their points will be deducted."
            : "You're about to redeem **"+item.name+"**. Just confirming this is what you want!"
        )
        .addFields(
          { name: "🛒 Item",          value: item.name,                       inline: true },
          { name: "🪙 Cost",          value: item.cost+" pts",                inline: true },
          { name: "💰 Balance after", value: (currentPts - item.cost)+" pts", inline: true },
          { name: "👤 Redeeming for", value: ign,                             inline: true },
          { name: "📝 Note",          value: note,                            inline: false },
          { name: "ℹ️ What you get",  value: item.desc,                       inline: false },
          ...warningField,
        )
        .setFooter({ text: "This will immediately deduct points | Project Azure (PJA)" });

      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("redeem_confirm_"+redeemId).setLabel(isGift ? "✅ Gift it!" : "✅ Yes, redeem it!").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("redeem_cancel_"+redeemId) .setLabel("❌ Cancel").setStyle(ButtonStyle.Danger),
      );
      await interaction.editReply({ embeds:[confirmEmbed], components:[confirmRow] });
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

    // ════════════════════════════════════════════════════════
    // ── MATCH REPORT SYSTEM ──────────────────────────────────
    // ════════════════════════════════════════════════════════

    // ── /getting-started & /setup-profile ─────────────────
    if (commandName === "getting-started" || commandName === "setup-profile") {
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
      return;
    }

    // ── /self-report ───────────────────────────────────────
    if (commandName === "self-report") {
      // Must call showModal within 3 seconds — no async work before this
      const reportId = interaction.options.getString("report-id").toUpperCase();

      // Quick in-memory check only — no API calls
      const subKey = reportId + "_" + user.id;
      if (selfReports.has(subKey)) {
        const ex = selfReports.get(subKey);
        if (ex.status !== "denied") {
          await interaction.reply({ content: "⚠️ You already submitted for this match.\n**Status:** " + ex.status + "\nAsk a manager to reopen it if needed.", ephemeral: true });
          return;
        }
      }

      // Determine position from in-memory report (fast) — default Utility
      const report = matchReportsFull.get(reportId);
      const assigned = report && report.players
        ? report.players.find(p => p.userId === user.id || (p.ign && p.ign.toLowerCase() === (getIgnForUser(user.id)||"").toLowerCase()))
        : null;
      const pos = assigned ? assigned.position : "Utility";
      const posType = {GK:"gk",CB:"def",LB:"def",RB:"def",CM:"mid",CDM:"mid",CAM:"mid",LW:"wing",RW:"wing",ST:"st"}[pos] || "util";

      const safeOpponent = report ? (report.opponent||"Match").substring(0,20) : "Match";
      const modal = new ModalBuilder()
        .setCustomId("sr_modal_" + reportId + "_" + pos)
        .setTitle(("Self-Report: " + pos + " vs " + safeOpponent).substring(0,45));

      const gkFields = [
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_saves").setLabel("Saves | Big Saves").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. 4 | 2")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_cleansheet").setLabel("Clean Sheet? (yes/no) | Goals Conceded").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. yes | 0")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_ratings").setLabel("Distribution / Communication / Positioning (1-10)").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. 7 / 8 / 9")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_mistakes").setLabel("Mistakes Leading to Goals").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("Number, e.g. 0")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_notes").setLabel("Notes & Clip/Proof Link (optional)").setStyle(TextInputStyle.Paragraph).setRequired(false).setPlaceholder("Any extra notes or clip link")),
      ];
      const defFields = [
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_def").setLabel("Tackles | Interceptions | Clearances | Blocks").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. 3 | 2 | 1 | 1")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_cleansheet").setLabel("Clean Sheet? (yes/no) | Mistakes Led to Goal").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. yes | 0")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_goals").setLabel("Goals | Assists").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("e.g. 1 | 0")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_ratings").setLabel("Def. Positioning / Communication (1-10)").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. 8 / 7")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_notes").setLabel("Notes & Clip/Proof Link (optional)").setStyle(TextInputStyle.Paragraph).setRequired(false).setPlaceholder("Any extra notes or clip link")),
      ];
      const midFields = [
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_goals").setLabel("Goals | Assists | Key Passes").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. 1 | 2 | 3")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_def").setLabel("Def. Recoveries").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("Number, e.g. 2")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_ratings").setLabel("Possession / Passing / Positioning (1-10)").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. 8 / 9 / 7")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_notes").setLabel("Notes & Clip/Proof Link (optional)").setStyle(TextInputStyle.Paragraph).setRequired(false).setPlaceholder("Any extra notes or clip link")),
      ];
      const wingFields = [
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_goals").setLabel("Goals | Assists | Chances Created").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. 1 | 1 | 3")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_def").setLabel("Crosses/Key Passes | Successful Attacks").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("e.g. 2 | 4")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_ratings").setLabel("Pressing / Positioning (1-10)").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. 8 / 7")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_notes").setLabel("Notes & Clip/Proof Link (optional)").setStyle(TextInputStyle.Paragraph).setRequired(false).setPlaceholder("Any extra notes or clip link")),
      ];
      const stFields = [
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_goals").setLabel("Goals | Assists | Shots").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. 2 | 1 | 5")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_def").setLabel("Chances Created").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("Number, e.g. 2")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_ratings").setLabel("Finishing / Positioning / Pressing (1-10)").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. 8 / 7 / 6")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_notes").setLabel("Notes & Clip/Proof Link (optional)").setStyle(TextInputStyle.Paragraph).setRequired(false).setPlaceholder("Any extra notes or clip link")),
      ];
      const utilFields = [
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_goals").setLabel("Goals | Assists").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("e.g. 0 | 1")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_def").setLabel("Saves (if any) | Def. Plays (if any)").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("e.g. 0 | 2")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_ratings").setLabel("Overall Impact (1-10)").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. 7")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sr_notes").setLabel("Notes & Clip/Proof Link (optional)").setStyle(TextInputStyle.Paragraph).setRequired(false).setPlaceholder("Any extra notes or clip link")),
      ];

      const fieldMap = { gk:gkFields, def:defFields, mid:midFields, wing:wingFields, st:stFields, util:utilFields };
      const fields   = fieldMap[posType] || utilFields;
      // Modals support max 5 rows; trim if util only has 4
      fields.forEach(f => modal.addComponents(f));
      await interaction.showModal(modal);
      return;
    }

    // ── /motm-vote ─────────────────────────────────────────
    if (commandName === "motm-vote") {
      await interaction.deferReply({ ephemeral: true });
      const reportId = interaction.options.getString("report-id").toUpperCase();
      const voteFor  = interaction.options.getString("vote-for").trim();
      const report   = matchReportsFull.get(reportId);
      if (!report) { await interaction.editReply("❌ Match report **" + reportId + "** not found."); return; }
      if (report.motmLocked) { await interaction.editReply("🔒 MOTM voting for this match has been locked."); return; }
      const myIgn = getIgnForUser(user.id) || user.username;
      if (voteFor.toLowerCase() === myIgn.toLowerCase()) { await interaction.editReply("❌ You cannot vote for yourself."); return; }
      const voteKey = reportId + "_" + user.id;
      const prev    = motmVotes.get(voteKey);
      motmVotes.set(voteKey, voteFor);
      const allVotes = [...motmVotes.entries()].filter(([k]) => k.startsWith(reportId + "_"));
      const tally    = {};
      allVotes.forEach(([,ign]) => { tally[ign] = (tally[ign]||0) + 1; });
      const topEntries = Object.entries(tally).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([ign,c]) => "• **"+ign+"** — "+c+" vote(s)").join("\n");
      const changed = prev && prev !== voteFor;
      await interaction.editReply({ embeds: [pjaEmbed("🏆 MOTM Vote Recorded", 0x22c55e)
        .setDescription((changed ? "✅ Changed vote from **"+prev+"** to **"+voteFor+"**" : "✅ Voted for **"+voteFor+"**") + "\n\n**Current standings:**\n" + (topEntries || "No votes yet"))
        .setFooter({ text: "Votes are anonymous to other players | Project Azure (PJA)" })] });
      return;
    }

    // ── /review-submissions ────────────────────────────────
    if (commandName === "review-submissions") {
      await interaction.deferReply({ ephemeral: true });
      if (!isAdmin(member)) { await interaction.editReply("❌ This command is for Managers only."); return; }
      const reportId = interaction.options.getString("report-id").toUpperCase();
      const report   = matchReportsFull.get(reportId);
      if (!report) { await interaction.editReply("❌ Match report **" + reportId + "** not found."); return; }
      const subs = [...selfReports.entries()]
        .filter(([k]) => k.startsWith(reportId + "_"))
        .map(([, v]) => v);
      if (subs.length === 0) { await interaction.editReply("📭 No submissions yet for match **" + reportId + "**."); return; }
      const statusEmoji = { pending:"⏳", approved:"✅", denied:"❌", needs_proof:"📎" };
      const lines = subs.map(s =>
        (statusEmoji[s.status]||"❓") + " **" + s.ign + "** (" + s.position + ") — " + s.status +
        (s.goals !== undefined ? "\n  ⚽ Goals: " + (s.goals||0) + " | 🎯 Ast: " + (s.assists||0) + (s.saves!==undefined ? " | 🧤 Saves: " + (s.saves||0) : "") : "") +
        (s.notes ? "\n  📝 " + s.notes.substring(0,60) : "")
      ).join("\n\n");
      const firstPending = subs.find(s => s.status === "pending");
      const embed = pjaEmbed("📋 Submissions — " + reportId + " (" + subs.length + ")", 0x2563eb)
        .setDescription(lines || "No submissions.")
        .addFields({ name:"📊 Match", value:"PJA vs **"+report.opponent+"** | "+report.result+" "+report.score+" | "+report.date, inline:false });
      if (firstPending) {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("sub_approve_"+reportId+"_"+firstPending.userId).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("sub_deny_"+reportId+"_"+firstPending.userId).setLabel("❌ Deny").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("sub_proof_"+reportId+"_"+firstPending.userId).setLabel("📎 Needs Proof").setStyle(ButtonStyle.Secondary),
        );
        await interaction.editReply({ embeds: [embed], components: [row] });
      } else {
        await interaction.editReply({ embeds: [embed] });
      }
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
      [...motmVotes.entries()].filter(([k]) => k.startsWith(reportId+"_")).forEach(([,ign]) => {
        voteTally[ign.toLowerCase()] = (voteTally[ign.toLowerCase()]||0)+1;
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
      [...motmVotes.entries()].filter(([k])=>k.startsWith(reportId+"_")).forEach(([,ign])=>{ voteTally[ign.toLowerCase()]=(voteTally[ign.toLowerCase()]||0)+1; });
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

    // ── Submission review buttons ──────────────────────────
    if (parts[0]==="sub") {
      await interaction.deferUpdate();
      if (!isAdmin(member)) { await interaction.followUp({ content:"❌ No permission.", ephemeral:true }); return; }
      const action   = parts[1]; // approve | deny | proof
      const reportId = parts[2];
      const userId   = parts[3];
      const subKey   = reportId + "_" + userId;
      const sub      = selfReports.get(subKey);
      if (!sub) { await interaction.followUp({ content:"❌ Submission not found.", ephemeral:true }); return; }
      const statusMap = { approve:"approved", deny:"denied", proof:"needs_proof" };
      sub.status = statusMap[action] || action;
      sub.reviewedBy = user.tag;
      if (sub.status === "approved") {
        // Apply stats to player's local stats
        addStat(sub.ign, "matches", 1);
        if (parseInt(sub.goals))       addStat(sub.ign, "goals",       parseInt(sub.goals));
        if (parseInt(sub.assists))     addStat(sub.ign, "assists",     parseInt(sub.assists));
        if (parseInt(sub.saves))       addStat(sub.ign, "saves",       parseInt(sub.saves));
        if (sub.cleanSheet?.toLowerCase()==="yes") addStat(sub.ign, "cleanSheets", 1);
        addPoints(sub.ign, 5); // 5 pts for match participation
      }
      const statusEmoji = { approved:"✅", denied:"❌", needs_proof:"📎" };
      try {
        const targetUser = await client.users.fetch(userId).catch(()=>null);
        if (targetUser) {
          const msgs = {
            approved: "✅ Your stats for **PJA vs "+sub.matchOpponent+"** have been **approved**! +5 PJA Points 🪙",
            denied:   "❌ Your stats for **PJA vs "+sub.matchOpponent+"** were **denied**. Contact a manager for more info.",
            needs_proof:"📎 Your stats for **PJA vs "+sub.matchOpponent+"** need **proof/clip link**. Please send it to a manager.",
          };
          await targetUser.send({ embeds:[pjaEmbed("📊 Stats Update", sub.status==="approved"?0x22c55e:sub.status==="denied"?0xef4444:0xf59e0b).setDescription(msgs[sub.status]||"Stats updated.")] }).catch(()=>{});
        }
      } catch(e) {}
      await interaction.followUp({ content:"**"+sub.ign+"** submission → **"+sub.status+"**."+(sub.status==="approved"?" Stats applied & +5 pts.":""), ephemeral:true });
      return;
    }

    // ── MOTM AI approve / choose different ────────────────
    if (parts[0]==="motm" && (parts[1]==="approve"||parts[1]==="different")) {
      await interaction.deferUpdate();
      if (!isAdmin(member)) { await interaction.followUp({ content:"❌ No permission.", ephemeral:true }); return; }
      const reportId = parts[2];
      const report   = matchReportsFull.get(reportId);
      if (!report) { await interaction.followUp({ content:"❌ Report not found.", ephemeral:true }); return; }
      if (parts[1]==="approve") {
        const aiIgn = parts[3];
        report.motm   = aiIgn;
        report.aiMotm = aiIgn;
        addStat(aiIgn, "motms", 1);
        addPoints(aiIgn, 10);
        await interaction.followUp({ content:"🏆 **"+aiIgn+"** confirmed as MOTM! +10 PJA Points awarded 🪙", ephemeral:true });
      } else {
        report.motmLocked = false;
        await interaction.followUp({ content:"🔄 You can now use `/final-report report-id:"+reportId+" motm:PlayerName` to set a different MOTM.", ephemeral:true });
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
      await interaction.followUp({ content:"✅ In-memory data restored from backup!\n• Warnings: "+(d.warnings?.length||0)+"\n• Points: "+(d.points?.length||0)+"\n• Local stats: "+(d.localStats?.length||0)+"\n• Newcomer profiles: "+(d.newcomerProfiles?.length||0)+"\n• Match reports: "+(d.matchReports?.length||0), ephemeral:true });
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
      const idParts  = customId.replace("sr_modal_","").split("_");
      const reportId = idParts[0];
      const pos      = idParts[1] || "Utility";

      // Lookup report — API fallback is fine here, no time limit in modal submit
      let report = matchReportsFull.get(reportId);
      if (!report) {
        const apiReports = await apiGet("match_reports").catch(()=>[]);
        const apiReport  = apiReports.find(r => (r.id||"").toUpperCase() === reportId);
        if (apiReport) {
          report = { ...apiReport, players: [], motmLocked: false, finalized: false };
          matchReportsFull.set(reportId, report);
        } else {
          // Stub — submission still saves even if report not found
          report = { id: reportId, opponent: "Unknown", score: "?", result: "?", date: new Date().toDateString(), players: [], motmLocked: false, finalized: false };
          matchReportsFull.set(reportId, report);
        }
      }

      const myIgn = getIgnForUser(user.id) || user.username;
      const subKey = reportId + "_" + user.id;

      // Parse fields based on position type
      const posType = {GK:"gk",CB:"def",LB:"def",RB:"def",CM:"mid",CDM:"mid",CAM:"mid",LW:"wing",RW:"wing",ST:"st"}[pos.toUpperCase()]||"util";
      const sub = {
        reportId,
        userId:      user.id,
        ign:         myIgn,
        position:    pos,
        matchOpponent: report.opponent || "Unknown",
        status:      "pending",
        submittedAt: new Date().toISOString(),
      };

      const tryGet = (id) => { try { return interaction.fields.getTextInputValue(id); } catch(e) { return null; } };
      const goalsRaw  = tryGet("sr_goals");
      const defRaw    = tryGet("sr_def");
      const ratRaw    = tryGet("sr_ratings");
      const csRaw     = tryGet("sr_cleansheet");
      const savesRaw  = tryGet("sr_saves");
      const mistRaw   = tryGet("sr_mistakes");
      const notesRaw  = tryGet("sr_notes");

      if (posType === "gk") {
        const [sv, bs] = (savesRaw||"").split("|").map(s=>s.trim());
        const [cs, gc] = (csRaw||"").split("|").map(s=>s.trim());
        const [dist, comm, posR] = (ratRaw||"").split("/").map(s=>s.trim());
        sub.saves = sv; sub.bigSaves = bs; sub.cleanSheet = cs; sub.goalsConceded = gc;
        sub.distributionRating = dist; sub.commRating = comm; sub.posRating = posR;
        sub.mistakes = mistRaw;
      } else if (posType === "def") {
        const [ta, int, cl, bl] = (defRaw||"").split("|").map(s=>s.trim());
        const [cs, mist] = (csRaw||"").split("|").map(s=>s.trim());
        const [goals, assists] = (goalsRaw||"").split("|").map(s=>s.trim());
        const [defPos, comm] = (ratRaw||"").split("/").map(s=>s.trim());
        sub.tackles = ta; sub.interceptions = int; sub.clearances = cl; sub.blocks = bl;
        sub.cleanSheet = cs; sub.mistakes = mist; sub.goals = goals; sub.assists = assists;
        sub.defPosRating = defPos; sub.commRating = comm;
      } else if (posType === "mid") {
        const [goals, assists, kp] = (goalsRaw||"").split("|").map(s=>s.trim());
        const [poss, pass, posR] = (ratRaw||"").split("/").map(s=>s.trim());
        sub.goals = goals; sub.assists = assists; sub.keyPasses = kp;
        sub.defRecoveries = defRaw;
        sub.possessionRating = poss; sub.passingRating = pass; sub.posRating = posR;
      } else if (posType === "wing") {
        const [goals, assists, cc] = (goalsRaw||"").split("|").map(s=>s.trim());
        const [crosses, sa] = (defRaw||"").split("|").map(s=>s.trim());
        const [press, posR] = (ratRaw||"").split("/").map(s=>s.trim());
        sub.goals = goals; sub.assists = assists; sub.chancesCreated = cc;
        sub.crosses = crosses; sub.successfulAttacks = sa;
        sub.pressingRating = press; sub.posRating = posR;
      } else if (posType === "st") {
        const [goals, assists, shots] = (goalsRaw||"").split("|").map(s=>s.trim());
        const [fin, posR, press] = (ratRaw||"").split("/").map(s=>s.trim());
        sub.goals = goals; sub.assists = assists; sub.shots = shots;
        sub.chancesCreated = defRaw;
        sub.finishingRating = fin; sub.posRating = posR; sub.pressingRating = press;
      } else {
        const [goals, assists] = (goalsRaw||"").split("|").map(s=>s.trim());
        const [saves, defPlays] = (defRaw||"").split("|").map(s=>s.trim());
        sub.goals = goals; sub.assists = assists; sub.saves = saves; sub.defPlays = defPlays;
        sub.overallRating = ratRaw;
      }
      sub.notes = notesRaw;

      selfReports.set(subKey, sub);

      // Safe field values — Discord rejects empty/undefined embed field values
      const safeVal = (v) => (v && String(v).trim()) ? String(v).trim() : "—";

      await interaction.editReply({ embeds: [pjaEmbed("✅ Self-Report Submitted!", 0x22c55e)
        .setDescription("Your stats for **PJA vs " + report.opponent + "** have been submitted!\n\nA manager will review and approve your submission. Stats don't count until approved.")
        .addFields(
          { name:"📍 Position", value: safeVal(pos),          inline: true },
          { name:"⚽ Goals",    value: safeVal(sub.goals),    inline: true },
          { name:"🎯 Assists",  value: safeVal(sub.assists),  inline: true },
          { name:"🧤 Saves",    value: safeVal(sub.saves),    inline: true },
          { name:"📝 Notes",    value: safeVal(sub.notes).substring(0, 100), inline: false },
        ).setFooter({ text: "Manager review pending | Project Azure (PJA)" })] });

      // Notify channel (safe — ignore if no channel access)
      try {
        if (interaction.channel) {
          await interaction.channel.send({ embeds: [pjaEmbed("📊 New Self-Report", 0x2563eb)
            .setDescription("**" + myIgn + "** submitted stats for report **" + reportId + "**.\nPosition: " + pos + " | Use `/review-submissions report-id:" + reportId + "` to review.")] });
        }
      } catch(e) {}
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
