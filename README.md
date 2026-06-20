# PJA Player Portal — Project Azure

Internal player portal and Discord bot for the **Project Azure** VRFS competitive team.

---

## What This Is

A mobile-first web portal + Discord bot for PJA squad members and managers.

- **Website** — handles forms, submissions, rosters, schedules, and Discord notifications  
- **Discord bot** — handles slash commands, match reports, shop system, MOTM voting, self-reports, and all in-server interactions  
- **Match report token system** — future-ready infrastructure so self-reports can later move from Discord to the website with zero rewrite

---

## Pages

| Page | URL | Who Uses It |
|------|-----|-------------|
| Home | `index.html` | Everyone |
| Player Portal | `player.html` | All players |
| Manager Dashboard | `admin.html` | Managers only (PIN) |
| Match Report Form | `match-report.html` | Players (after match) |
| Roster | `roster.html` | Everyone |
| Schedule | `schedule.html` | Everyone |

---

## Player Portal Features

- **Tryout Application** — for new recruits applying to join
- **Getting Started / Profile** — new players set up their profile for the manager
- **Match Self-Report** — players submit their own stats after a match (position-specific form)
- **MOTM Vote** — players vote for Man of the Match
- **Player Request** — suggestions, complaints, LOAs, role requests
- **Bug Report** — portal or bot issues
- **Giveaway Entry** — enter active giveaways

---

## Manager Dashboard

**Default PIN: `pja2025`**

> Change it immediately in Settings → PIN Settings.

The PIN is stored in `localStorage`. No server-side authentication — this is an internal portal.

### What Managers Can Do

- View and accept/deny tryout applications
- View player profile submissions
- Add/remove players from the roster
- Create match reports with Report IDs
- Assign players to positions before a match
- Review and approve/deny self-report submissions
- View MOTM votes and get AI MOTM recommendation
- Manage schedule (add/delete events)
- Manage giveaways (create, close, pick winner)
- Review player requests and bug reports
- Configure Discord webhook settings
- Export/import all data as JSON

---

## Match Report Flow (Current — Discord Only)

1. Manager runs `/match-report opponent:... score:... result:... [players:PlayerA,PlayerB,...]`  
2. Bot returns a **Report ID** (e.g. `LP8KQ9J`)  
3. Manager optionally includes `players:` comma-separated IGNs — bot pre-generates a unique token per player  
4. Manager shares the Report ID with players  
5. Players run `/self-report report-id:LP8KQ9J position:ST` on Discord  
6. Bot opens a per-position stat modal — player fills it in and submits  
7. Manager reviews with `/review-submissions report-id:LP8KQ9J`  
8. Manager approves/edits/denies; player DM'd; PJA points awarded automatically  
9. Manager runs `/final-report` to publish the full match summary  

### Future Website Flow (Infrastructure Ready — Site Not Built Yet)

All data is already stamped today so migration is zero-rewrite:

1. Manager creates match report with `players:` option  
2. Bot pre-generates one `(playerId, token)` pair per player and stores a future URL:  
   `https://SITE_URL/match-report?report=REPORT_ID&player=PLAYER_ID&token=TOKEN`  
3. When the website is live, set `SITE_URL` env var on Railway and flip `report.websiteEnabled = true`  
4. Manager runs `/send-report-links mode:dm` — bot DMs each player their unique link  
5. Player clicks link → fills in stats on website → website POSTs submission to bot  
6. Bot marks token used, inserts submission as `source: "website"` — review queue unchanged  

**No existing Discord flows break when the website is added.**

---

## Token Infrastructure (in `discord-bot/index.js`)

| Item | Description |
|------|-------------|
| `playerSubmissionTokens` Map | `playerId → { ign, reportId, token, used, source, websiteUrl, … }` |
| `reportPlayerIndex` Map | `reportId → Map(ign.lower → playerId)` — fast reverse lookup |
| `SITE_URL` | `process.env.SITE_URL \|\| "https://my-pja-site.com"` — set on Railway when live |
| `generatePlayerToken(reportId, ign)` | Idempotent — same ign+report always returns same token |
| `buildSubmissionUrl(reportId, playerId, token)` | Builds full URL with query params |
| `validateSubmissionToken(reportId, playerId, token)` | Returns record or null — for website auth |
| `consumeSubmissionToken(playerId, source)` | Marks `used=true`, sets `source` on submit |
| `submissionId` on every sub | Stable UUID per submission regardless of Discord/website |
| `source` field | `"discord"` or `"website"` on submissions and MOTM votes |

---

## Discord Bot — Commands Reference

### Match Report System

| Command | Who | What It Does |
|---------|-----|--------------|
| `/match-report` | Manager | Creates a report; accepts optional `players:` comma list to pre-generate tokens |
| `/self-report` | Player | Opens per-position stat modal; stamps `submissionId`, `playerId`, `token`, `source` |
| `/review-submissions` | Manager | One-at-a-time queue with 7 action buttons |
| `/submission-history` | Manager | Full history log for a report with filters |
| `/ai-motm` | Manager | AI performance score recommendation |
| `/final-report` | Manager | Generates and posts final match summary |
| `/motm-vote` | Player | Standalone MOTM vote; stamped with `voterPlayerId` + `source: "discord"` |
| `/motm-results` | Anyone | Shows vote standings + manager approve/lock buttons |
| `/send-report-links` | Manager | Posts/DMs submission instructions (real links when `websiteEnabled=true`) |
| `/report-status` | Manager | Unified token + submission status table for a match |

### LM/RM Positions

LM and RM are fully supported everywhere:
- `/self-report` position choices include `LM — Left Midfielder` and `RM — Right Midfielder`
- Both map to the MID stat form (same as CM/CDM/CAM)
- `calcSubmissionPoints()` includes LM/RM → mid point formula

### Points System

Points are auto-awarded when a manager **approves** a submission:

| Stat | Points |
|------|--------|
| Match participation | +10 |
| Goal | +5 each |
| Assist | +4 each |
| GK save | +3 each |
| Clean sheet | +8 |
| Big save | +4 each |
| Key pass | +2 each |
| Tackle | +2 each |
| Interception | +2 each |
| Block | +2 each |
| Rating ≥ 8 | +3 |
| Rating ≥ 9 | +5 |
| MOTM award | +15 |

### Shop System

**Approval items** (manager reviews):
- Rename the Bot 24h — 200 pts
- Server Emoji Request — 200 pts
- Custom Command Reply — 200 pts
- Rename a Giveaway — 150 pts
- Server Poll Override — 200 pts
- Lucky Number Claim — 150 pts

**Auto-execute items** (instant):
- Point Steal Ticket — 150 pts (50/50, steals 25 pts from target)
- Point Gamble Ticket — 75 pts (double or lose; you choose amount)
- Mystery Spin Wheel — 100 pts (weighted: jackpot/big/small/discount/nothing)
- Temporary Shop Discount — 200 pts (25% off next item, 24h valid)

### Other Commands

| Command | Notes |
|---------|-------|
| `/shop` | Browse items split by auto/approval |
| `/redeem` | Buy item; auto-executes or queues for manager |
| `/shop-price` | Manager changes item prices |
| `/shop-requests` | Manager reviews pending shop approvals |
| `/points` | Check balance |
| `/give-points` | Manager awards/removes points |
| `/custom-commands` | List/add/remove `!trigger` bot replies |
| `/stats` | View a player's match stats |
| `/profile` | Full player profile |
| `/roster` | Current roster |
| `/leaderboard` | Top players by stat category |
| `/schedule` | Upcoming events |
| `/add-schedule` | Manager adds event |
| `/friendly` | Request a friendly + RSVP embed |
| `/link` | Link Discord → VRFS IGN |
| `/link-player` | Manager links someone else |
| `/tryout` | Submit tryout application |
| `/applications` | Manager views applications |
| `/warn` / `/warnings` / `/clear-warning` / `/strikes` | Warning system |
| `/getting-started` / `/setup-profile` | New player profile modal |
| `/trial-review` | Manager scores a trialist |
| `/award-give` / `/awards` | Awards system |
| `/activity-check` | Manager posts activity check |
| `/team-vote` | Create a team poll |
| `/giveaway` / `/giveaway-end` / `/giveaway-reroll` | Giveaway system |
| `/chemistry` / `/duo` | Player pairing analysis |
| `/weaknesses` | Track opponent weaknesses |
| `/contract` | Announce a signing |
| `/best-lineup` | AI lineup suggestion |
| `/team-depth` | Depth chart by position |
| `/add-player` / `/edit-player` / `/remove-player` | Roster management |
| `/promote` / `/demote` / `/release` | Role management |
| `/open-spots` | View/set open recruitment spots |
| `/timezone-check` | Convert a time across zones |
| `/remind-team` | Set a team reminder |
| `/request` | Player sends a request |
| `/bug-report` | Report a bug |
| `/suggest` | Submit a suggestion |
| `/server-stats` | Live server snapshot |
| `/id-card` | Generate a player ID card |
| `/announce` | Post a formatted announcement |
| `/backup-data` | Export all in-memory data as JSON |
| `/restore-data` | Restore from JSON backup |

### Custom Commands

Players can buy **Custom Command Reply** from the shop. In the `note` field, they type:  
`!trigger → bot reply text`

On approval the bot parses this and registers it. Anyone in the server can then type `!trigger` and the bot replies automatically.

Managers can also use `/custom-commands action:add` or `action:remove` directly.

---

## Discord Webhook Setup (Website Notifications)

The Discord webhook URL is stored **server-side in the Genspark Table API** (`pja_config` table). It is never stored in localStorage or visible in browser dev tools.

### How to Set It Up

1. Discord → Channel → Edit → Integrations → Webhooks → New Webhook → Copy URL
2. Open `admin.html`, log in with your PIN
3. Go to **Settings**
4. Paste the webhook URL into **Discord Webhook URL**
5. Toggle **Enable Notifications** on
6. Click **Save**

### `@Team/Help` Role Ping

Every website-triggered Discord notification automatically pings **`@Team/Help`** (Role ID `1513323422997020814`) so managers always see it.

### Events That Trigger Notifications

| Event | Trigger |
|-------|---------|
| `tryout` | New tryout application submitted |
| `profile` | New getting-started profile submitted |
| `selfreport` | Player submits match stats |
| `motm` | MOTM vote cast |
| `finalreport` | Manager generates final match report |
| `request` | Player submits a request |
| `bug` | Bug report submitted |
| `giveaway` | Entry submitted or winner picked |
| `schedule` | Manager adds a schedule event |
| `test` | Manual test from settings panel |

---

## Discord Bot — Data Stores

All bot data is **in-memory** (Map/Array). Resets on bot restart. Use `/backup-data` before restarting.

| Store | Type | What It Holds |
|-------|------|---------------|
| `matchReportsFull` | Map | Full match reports keyed by reportId |
| `selfReports` | Map | Player submissions keyed by `reportId_userId` |
| `motmVotes` | Map | Vote objects with nominee, reason, voterPlayerId, source |
| `playerPoints` | Map | IGN → point balance |
| `pointHistory` | Map | IGN → last 50 point transactions |
| `playerSubmissionTokens` | Map | playerId → token record (future website auth) |
| `reportPlayerIndex` | Map | reportId → Map(ign → playerId) |
| `shopRequests` | Map | Pending/reviewed shop requests |
| `shopRedemptions` | Map | All redemptions (auto + approved) |
| `discountTokens` | Map | IGN → active discount token |
| `luckyNumbers` | Map | IGN → claimed lucky number |
| `customCommandsMap` | Map | trigger → { reply, createdBy, ign } |
| `submissionHistory` | Map | subKey → event log |
| `motmVoteLocks` | Map | reportId → locked boolean |
| `playerWarnings` | Map | IGN → warnings array |
| `playerAwards` | Map | IGN → awards array |
| `newcomerProfiles` | Map | userId → profile |
| `linkedAccounts` | Map | discordId → IGN |
| `ignToDiscordId` | Map | ign.lower → discordId |
| `playerStats` | Map | ign.lower → local stat totals |
| `giveaways` | Map | giveaway objects |
| `teamVotes` | Map | vote objects |
| `reminders` | Map | scheduled reminder objects |

---

## Website Data Storage

All website data is stored in **localStorage** on the user's device.

| Key | Holds |
|-----|-------|
| `pja_roster` | Active roster players |
| `pja_reports` | Match reports |
| `pja_submissions` | Player self-report submissions |
| `pja_motm_votes` | MOTM vote records |
| `pja_tryouts` | Tryout applications |
| `pja_profiles` | Profile submissions |
| `pja_requests` | Player requests |
| `pja_bugs` | Bug reports |
| `pja_giveaways` | Giveaway records + entries |
| `pja_schedule` | Schedule events |
| `pja_settings` | PIN, preferences |
| `pja_webhooks` | Webhook endpoint + enabled flag |

> **Backup:** Admin → Settings → Export JSON before clearing browser storage.

---

## Position Type Mapping

| Position | Form/Bot Type |
|----------|--------------|
| GK | Goalkeeper |
| DEF / CB / LB / RB | Defender |
| MID / CDM / CM / CAM / **LM / RM** | Midfielder |
| WING / LW / RW | Winger |
| ST / CF | Striker |
| Sub / Utility | Utility |

---

## File Structure

```
index.html               Home page
player.html              Player portal (all forms)
admin.html               Manager dashboard
match-report.html        Match self-report form (URL-param aware)
roster.html              Public roster
schedule.html            Public schedule

css/
  style.css              Main dark-blue theme
  admin.css              Admin panel styles

js/
  data.js                localStorage data layer + AI MOTM scoring
  webhooks.js            Discord webhook sender (Table API) + @Team/Help ping
  player.js              Player portal form logic
  admin.js               Admin dashboard logic
  matchreport.js         Match report form logic

discord-bot/
  index.js               Full Discord bot (~5100 lines)
  keep-alive.js          Railway keep-alive server
  package.json           Node.js dependencies

README.md                This file
```

---

## Railway Environment Variables (Discord Bot)

| Variable | Required | Notes |
|----------|----------|-------|
| `DISCORD_TOKEN` | ✅ | Bot token from Discord Developer Portal |
| `CLIENT_ID` | ✅ | Bot application ID |
| `GUILD_ID` | ✅ | Your Discord server ID |
| `WEBSITE_API` | ✅ | Genspark Table API base URL |
| `ANNOUNCEMENTS_CHANNEL_ID` | Optional | Channel ID for shoutouts/features |
| `MATCH_CHANNEL_ID` | Optional | Channel for RSVP embeds |
| `SITE_URL` | Optional | Set when website is live (enables real submission links) |

---

## Pending — Future Steps

- [ ] **Redeploy bot to Railway** — all code is committed; Railway needs a manual redeploy or push to activate changes
  - After redeploy: **every player must `/link` once more** — then their link is permanently saved in `pja_links` and survives all future restarts
- [ ] **Build website match-report page** — when ready:
  1. Set `SITE_URL` env var to the live website URL
  2. Implement `GET /match-report?report=&player=&token=` page that calls `validateSubmissionToken()` API
  3. On form submit, call `consumeSubmissionToken()` and POST the submission data
  4. Flip `report.websiteEnabled = true` on any match where you want to use website links
  5. Use `/send-report-links mode:dm` to notify players

---

## Quick Start for Players

1. Open the portal
2. Go to **Player Portal**
3. If new — fill out **Getting Started** first
4. After each match — use **Match Self-Report** with the Report ID from the manager
5. Vote for **MOTM** after each game
6. Use **Player Request** to message management

---

## Notes

- Manager PIN is `pja2025` by default — **change it in Settings immediately**
- Website data lives in localStorage — use Export/Import to move between devices
- Manager PIN is `pja2025` by default — **change it in Settings immediately**
- **Account links** (`/link`) are now persisted to `pja_links` API table — survive Railway restarts after the first link
- **Roster is now synced** — website admin adds/removes players via the API `roster` table; public `roster.html` and Discord `/roster` both read from the same source
- Bot data resets on restart **except** what is stored in the API tables (`pja_links`, `roster`, etc.)
- Website roster data that was previously in localStorage is no longer used — migrate any old entries by re-adding them via the Manager Dashboard
