# PJA Better Website + Match Report Links

## What changed

This version adds a better static PJA website flow:

- `index.html` — clean PJA control center homepage
- `admin.html` — manager dashboard with PIN lock
- `match-report.html` — personal player stat submission page
- `portal.js` — website logic for links, submissions, review, settings
- `style.css` — new mobile-friendly PJA design
- `keep-alive.js` — adds `POST /submit-report` endpoint for website submissions
- `index.js` — bot now listens for website submissions and puts them in the same review queue

## Manager flow

1. Open `admin.html`
2. Enter default PIN: `pja2025`
3. Go to Create Match Links
4. Add opponent, score/date, and players:

```txt
Malik, ST
Deno, GK
Azure, CM
```

5. Click Generate Player Links
6. Copy each player link and send it to them

## Player flow

1. Player opens their personal link
2. They submit stats and MOTM vote on `match-report.html`
3. Submission goes to local manager review
4. If Bot API URL is set, it also posts to the Discord bot endpoint:

```txt
POST https://your-bot-host.com/submit-report
```

## Bot setup

Set these environment variables on your bot host:

```env
SITE_URL=https://your-pja-website.com/
PORT=8080
MATCH_CHANNEL_ID=your_reports_channel_id
```

The bot endpoint must be public for the website to reach it.

## Important

Static localStorage data is only shared on the same browser. For real team use across all players, set the Bot API URL in Manager Settings and host the bot so submissions go to Discord/bot memory.
