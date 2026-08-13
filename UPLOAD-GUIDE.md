# Project Azure V5.5 Update

This update changes no slash-command names and requires no new Railway variables.

## Match-report points

Approved reports now award:

- Match played: 50 points
- Win: 100 points
- Draw: 50 points
- Goal: 150 points each
- Assist: 100 points each
- Save: 50 points each, capped at 250 save points per match
- Clean sheet: 150 points
- Strong defensive performance: 100 points after at least 5 combined tackles/interceptions
- MOTM: 200 points

Existing balances and purchases are not changed.

## Larger generated-image text

Typography was enlarged on:

- Player cards
- Lineup graphics
- PJA TV full-time graphics
- Welcomer banners

Long names and large point totals automatically shrink enough to fit.

## Saved tryout applications

Every Discord and website application remains in `/app/backend/data/tryouts.json` and is also copied to `/app/backend/data/tryout_archive.json` with submission/review history.

The manager website Applications tab now shows all saved applications, includes status filters and search, and keeps reviewed applications visible.

## Small update upload paths

Upload and replace these files in the matching GitHub folders:

- `backend/main.py`
- `bot/cogs/stats.py`
- `bot/cogs/cards.py`
- `bot/cogs/lineups.py`
- `bot/cogs/broadcast.py`
- `bot/cogs/welcome.py`
- `bot/cogs/tryouts.py`
- `website/index.html`

Wait for the Railway deployment to become Active, then test an approved report, `/card view`, `/lineup`, `/welcome test`, a PJA TV full-time report, and `/tryout apply`.
