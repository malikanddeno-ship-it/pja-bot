const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');

require('./keep-alive');

const TOKEN    = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const SITE_URL = process.env.SITE_URL;

// ============================================================
//  SLASH COMMAND DEFINITIONS
// ============================================================
const commands = [
  new SlashCommandBuilder()
    .setName('roster')
    .setDescription('Show the current PJA squad'),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show the PJA stats leaderboard')
    .addStringOption(opt =>
      opt.setName('category')
        .setDescription('Stat to show')
        .addChoices(
          { name: 'Goals',        value: 'goals' },
          { name: 'Assists',      value: 'assists' },
          { name: 'Saves',        value: 'saves' },
          { name: 'Clean Sheets', value: 'cleanSheets' },
          { name: 'MVPs',         value: 'mvps' },
          { name: 'Matches',      value: 'matches' }
        )
    ),

  new SlashCommandBuilder()
    .setName('nextmatch')
    .setDescription('Show the next upcoming PJA fixture'),

  new SlashCommandBuilder()
    .setName('motm')
    .setDescription('Show the last approved Man of the Match'),

].map(cmd => cmd.toJSON());

// ============================================================
//  REGISTER COMMANDS WITH DISCORD
// ============================================================
async function registerCommands(clientId) {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(clientId, GUILD_ID),
      { body: commands }
    );
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

// ============================================================
//  FETCH FROM TABLE API
// ============================================================
async function fetchTable(table) {
  try {
    const res  = await fetch(`${SITE_URL}/tables/${table}?limit=500`);
    const json = await res.json();
    return json.data || [];
  } catch (err) {
    console.error(`Failed to fetch ${table}:`, err);
    return [];
  }
}

function parseField(val) {
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return val; }
  }
  return val;
}

// ============================================================
//  COMMAND HANDLERS
// ============================================================

// /roster
async function handleRoster(interaction) {
  await interaction.deferReply();
  const roster = await fetchTable('roster');

  if (!roster.length) {
    return interaction.editReply('No players on the roster yet.');
  }

  const roles  = ['Captain', 'Co-Captain', 'Starter', 'Backup', 'Academy', 'Trialist'];
  const sorted = [...roster].sort((a, b) =>
    roles.indexOf(a.role) - roles.indexOf(b.role)
  );

  const embed = new EmbedBuilder()
    .setTitle('🔵 PJA Squad')
    .setColor(0x3b82f6)
    .setTimestamp();

  const groups = {};
  sorted.forEach(p => {
    if (p.status === 'Inactive') return;
    const role = p.role || 'Other';
    if (!groups[role]) groups[role] = [];
    groups[role].push(`**${p.name}** — ${p.position}${p.number ? ` (#${p.number})` : ''}`);
  });

  Object.entries(groups).forEach(([role, players]) => {
    embed.addFields({ name: role, value: players.join('\n'), inline: false });
  });

  embed.setFooter({ text: `${roster.filter(p => p.status !== 'Inactive').length} active players` });
  return interaction.editReply({ embeds: [embed] });
}

// /stats
async function handleStats(interaction) {
  await interaction.deferReply();
  const category = interaction.options.getString('category') || 'goals';
  const stats    = await fetchTable('stats');

  if (!stats.length) {
    return interaction.editReply('No stats recorded yet.');
  }

  const labels = {
    goals: 'Goals', assists: 'Assists', saves: 'Saves',
    cleanSheets: 'Clean Sheets', mvps: 'MVPs', matches: 'Matches'
  };

  const sorted = [...stats]
    .sort((a, b) => (b[category] || 0) - (a[category] || 0))
    .slice(0, 10);

  const medals = ['🥇', '🥈', '🥉'];
  const rows   = sorted.map((p, i) =>
    `${medals[i] || `${i + 1}.`} **${p.name}** — ${p[category] || 0} ${labels[category]}`
  ).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`📊 PJA Leaderboard — ${labels[category]}`)
    .setColor(0x3b82f6)
    .setDescription(rows || 'No data.')
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

// /nextmatch
async function handleNextMatch(interaction) {
  await interaction.deferReply();
  const matches = await fetchTable('matches');

  const upcoming = matches
    .filter(m => m.status === 'Upcoming')
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (!upcoming.length) {
    return interaction.editReply('No upcoming matches scheduled.');
  }

  const m      = upcoming[0];
  const isHome = m.homeTeam === 'PJA';
  const fixture = isHome ? `PJA vs ${m.opponent}` : `PJA @ ${m.opponent}`;
  const dateStr = m.date
    ? new Date(m.date + 'T00:00:00').toLocaleDateString('en-US', {
        weekday:'long', month:'long', day:'numeric', year:'numeric'
      })
    : 'Date TBD';

  const embed = new EmbedBuilder()
    .setTitle(`📅 Next Match — ${fixture}`)
    .setColor(0x3b82f6)
    .addFields(
      { name: 'Date',     value: dateStr,                 inline: true },
      { name: 'Time',     value: m.time || 'TBD',         inline: true },
      { name: 'Type',     value: m.matchType || 'League', inline: true },
      { name: 'Location', value: isHome ? '🏠 Home' : '✈️ Away', inline: true }
    )
    .setTimestamp();

  if (upcoming.length > 1) {
    const more = upcoming.slice(1, 4).map(mx => {
      const d = mx.date
        ? new Date(mx.date + 'T00:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' })
        : 'TBD';
      return `${d} — ${mx.homeTeam === 'PJA' ? 'vs' : '@'} ${mx.opponent}`;
    }).join('\n');
    embed.addFields({ name: 'Also Coming Up', value: more, inline: false });
  }

  return interaction.editReply({ embeds: [embed] });
}

// /motm
async function handleMotm(interaction) {
  await interaction.deferReply();
  const reports = await fetchTable('match_reports');

  const approved = reports
    .map(r => ({ ...r, motmApproved: parseField(r.motmApproved), lineup: parseField(r.lineup) }))
    .filter(r => r.motmApproved && r.motmApproved.playerName)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  if (!approved.length) {
    return interaction.editReply('No MOTM has been approved yet.');
  }

  const r       = approved[0];
  const motm    = r.motmApproved;
  const isHome  = r.homeTeam === 'PJA';
  const fixture = isHome ? `PJA vs ${r.opponent}` : `PJA @ ${r.opponent}`;
  const dateStr = r.date
    ? new Date(r.date + 'T00:00:00').toLocaleDateString('en-US', {
        month:'long', day:'numeric', year:'numeric'
      })
    : '';

  const embed = new EmbedBuilder()
    .setTitle(`👑 Man of the Match — ${motm.playerName}`)
    .setColor(0xfbbf24)
    .setDescription(`**${fixture}**${dateStr ? ` · ${dateStr}` : ''}`)
    .addFields(
      { name: 'Match Type', value: r.matchType || 'League', inline: true },
      { name: 'Score',      value: r.score || 'N/A',        inline: true },
      { name: 'Result',     value: r.result || 'N/A',       inline: true }
    )
    .setFooter({ text: 'Approved by manager' })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

// ============================================================
//  BOT CLIENT
// ============================================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once('ready', async () => {
  console.log(`✅ PJA Bot online as ${client.user.tag}`);
  await registerCommands(client.user.id);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    switch (interaction.commandName) {
      case 'roster':    await handleRoster(interaction);    break;
      case 'stats':     await handleStats(interaction);     break;
      case 'nextmatch': await handleNextMatch(interaction); break;
      case 'motm':      await handleMotm(interaction);      break;
    }
  } catch (err) {
    console.error('Command error:', err);
    const msg = { content: '❌ Something went wrong.', ephemeral: true };
    if (interaction.deferred) interaction.editReply(msg);
    else interaction.reply(msg);
  }
});

client.login(TOKEN);
