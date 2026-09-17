# Development hour tracker

Team leaderboards and a password-protected admin page (`/admin`) for tracking each person's own metrics and goals every development hour.

- **Recruitment:** `/` (the first team)
- **Admin:** `/?team=admin`
- **Other teams:** `/?team=<team-link-name>`. The admin page's Settings panel shows each team's link. It runs on Vercel, with results stored in a Postgres database (Neon).

## Put it live on Vercel

### Option A: from the dashboard (no terminal)

1. **Push this folder to a GitHub repo.**
2. **Import it:** in Vercel, go to Add New → Project and import the repo. Leave Framework Preset as **Other** and every build setting empty, then deploy.
3. **Add the database:**
   - Open the project and go to the **Storage** tab.
   - Choose Create Database → **Neon** (Postgres) and accept the free plan.
   - Connect it to this project for all environments. This adds `DATABASE_URL` for you.
4. **Set the admin password:** go to Settings → Environment Variables and add `ADMIN_PASSWORD` with the password you'll use for `/admin`.
5. **Redeploy:** go to Deployments → ⋯ on the latest one → Redeploy, so it picks up the two variables.

Every push to the repo redeploys automatically.

### Option B: from the terminal

```bash
npm i -g vercel
vercel                          # link and create the project, accept the defaults
vercel env add ADMIN_PASSWORD   # choose Production (and Preview if you use it)
```

Then add Neon from the project's **Storage** tab (step 3 above) and run:

```bash
vercel --prod
```

### After it's live

- Share `https://<project>.vercel.app/` with the team.
- Use `https://<project>.vercel.app/admin` yourself.

The database tables are created automatically on the first request.

**Custom domain:** Settings → Domains.

## How it works

- **Teams:** each team has its own people, metrics and sessions, and they're managed from the same admin page using the team tabs. Renaming a team keeps its link.
- **Metrics:** create any metrics you like in admin (Metrics panel), then give each person the ones that apply, with their own goal per session.
- **Self-logging:**
  - Each person has a 4-digit PIN, shown on their card in admin.
  - On the leaderboard, they tap their name, enter the PIN once per device, and log today's numbers with + and − buttons.
  - Numbers go into today's session (London date), which is created automatically if it doesn't exist yet.
  - Boards refresh every 5 seconds.
  - Five wrong PINs lock that person out for 15 minutes.
  - "New PIN" signs them out on every device.
- **Scoring:** each score averages that person's metrics against their goals, each capped at 200%, so people tracking different things can share one leaderboard.
- **Goals and history:** goals are copied onto each number when it's first logged, so changing a goal later doesn't rewrite past sessions. "Use current goals" re-applies everyone's current goals to one session.
- **Removing things:**
  - Removing a metric from one person keeps their past numbers.
  - Deleting a metric removes it, and its numbers, for everyone.
- **Archiving:** archived people keep their history on the leaderboard.
- **Upgrading:** data from the first version (fixed calls, meetings and sign-ups) is copied into metrics called Calls, Meetings and Sign-ups on first run. The old table is left in place as a backup.
- **Refresh:** the leaderboard refreshes every 30 seconds.
- **Sign-in:** admin sign-in lasts 30 days per device.

## Files

- `api/router.js`: the whole API. All routes go through `/api/router?path=…`.
- `public/index.html`, `public/app.js`, `public/board.css`: leaderboard.
- `public/admin.html`, `public/admin.js`: admin.
- `public/shared.js`, `public/styles.css`: shared scoring and design.
- `vercel.json`: serves `public/` with clean URLs (`/admin`).

Any Postgres database works: set `DATABASE_URL` to its connection string.
