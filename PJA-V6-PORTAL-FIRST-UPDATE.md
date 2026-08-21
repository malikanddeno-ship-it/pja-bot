# Project Azure V6 — Portal First

## What changed
V6 makes the website the main place players actually do things. Discord stays useful for alerts, manager tools, public read-only info, and secure portal login. No new slash commands were added.

## Player Portal
- `/portal login` stays as the secure one-use login command.
- The first screen is **Pending Actions** and automatically shows missing availability, finished matches needing a stat report, and open MOTM votes.
- Availability is set with Available / Maybe / Unavailable buttons and optional notes. No Scrim ID typing.
- Finished matches automatically appear in Match Stats. Match ID, opponent, result, and Discord identity are filled by the server.
- Match reports still require manager approval before points are awarded.
- MOTM voting is secure, roster-based, and limited to one vote per Discord account per poll. Public/anonymous voting is disabled.
- Points balance and recent point changes are shown in Overview.
- Shop purchases, orders, and fulfilled inventory are handled in the Shop tab.
- Requests, private manager conversations, suggestions, and complaints live in the portal. Requests/complaints can include an optional attachment link.
- Card/history remain together in the private player area.

## Discord becomes the launcher
Existing player commands keep their names so old habits still work, but actions now open the correct website panel instead of collecting the data in Discord:
- `/stats submit`
- `/availability set` and `/availability view`
- `/talk manager`
- `/request submit` and `/request status`
- `/history`
- `/points view` and `/points history`
- `/shop view`, `/shop buy`, and `/inventory`
- `/suggest submit`, `/suggest status`, `/complaint submit`, and `/complaint status`

Read-only commands such as roster, stat/points leaderboards, and manager commands remain available in Discord. `/card view` remains available as a read-only graphic.

## Manager Action Center
Managers now see missing availability counts, pending stat reports, active MOTM polls, and per-match players who have not responded.

## Points economy
V6 keeps the V5.5 economy and fixes old website text/estimates so they match the actual backend:
- Match played: +50
- Win: +100
- Draw: +50
- Goal: +150 each
- Assist: +100 each
- Save: +50 each, capped at +250 per match
- Clean sheet: +150
- Strong defensive performance: +100
- MOTM: +200

## Storage
No storage reset or migration is required. Existing JSON files remain the source of truth under `PJA_DATA_DIR` (Railway volume at `/app/data`).
