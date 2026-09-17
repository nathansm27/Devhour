# Development hour tracker

A public leaderboard (`/`) and a password-protected admin page (`/admin`) for tracking calls, meetings booked and sign-ups each development hour. It runs on Vercel, with results stored in a Postgres database (Neon).

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

- **Scoring:** each score averages calls, meetings and sign-ups against that person's goals. Each metric is capped at 200%.
- **Goals:** saved with each result when it's first logged, so changing a goal later doesn't rewrite past sessions. "Use current goals" re-applies everyone's current goals to one session.
- **Archiving:** archived people drop off the admin lists but keep their history. Delete removes a person and their results permanently.
- **Refresh:** the leaderboard refreshes every 30 seconds.
- **Sign-in:** admin sign-in lasts 30 days per device. Changing `ADMIN_PASSWORD` signs everyone out.
- **Backups:** Neon keeps point-in-time history; you can also export from the Neon console.

## Files

- `api/router.js`: the whole API. All routes go through `/api/router?path=…`.
- `public/index.html`, `public/app.js`, `public/board.css`: leaderboard.
- `public/admin.html`, `public/admin.js`: admin.
- `public/shared.js`, `public/styles.css`: shared scoring and design.
- `vercel.json`: serves `public/` with clean URLs (`/admin`).

Any Postgres database works: set `DATABASE_URL` to its connection string.
