# Deploying this on Netlify (with a real database)

## What changed
The old `server.js` was a single always-on Node process — Netlify doesn't run
that kind of server. This version splits things up:

- `public/` — same static site as before (unchanged)
- `netlify/functions/api.js` — the backend, rewritten as a Netlify Function.
  It's mounted at `/api/*`, so none of the frontend fetch calls needed to change.
- `netlify/functions/lib.js` — database + session helpers
- Data (appointments, patients, feedback, payments, reports) is stored in
  **Netlify DB**, a Postgres database (powered by Neon) that Netlify
  provisions and connects automatically — this replaces the old local
  SQLite file, which would have been wiped on every deploy anyway since
  functions don't keep local disk between invocations.
- `server.js`, `db.js`, and `utils.js` are no longer used and can be deleted;
  left in the zip only for reference.

## Why I can't finish the deploy myself
Deploying this build requires an `npm install` step (to pull in the
`@netlify/database` package) and a real build pipeline, which only runs
through a **Git-connected deploy** or the Netlify CLI — not the drag-and-drop
upload I used for the static-only version earlier. My sandbox has no internet
access, so I can't push to GitHub or run the CLI from here. You'll need to do
this part.

## Steps

1. **Push this folder to a GitHub repo** (from your own machine, in the
   unzipped project folder):
   ```
   git init
   git add .
   git commit -m "Netlify Functions + Netlify DB backend"
   git branch -M main
   git remote add origin https://github.com/<you>/dr-amit-nichale-dental-clinic.git
   git push -u origin main
   ```

2. **Connect the repo to the site already created**
   (`dr-amit-nichale-dental-clinic.netlify.app`):
   - Netlify dashboard → your site → **Site configuration → Build & deploy →
     Continuous deployment → Link repository**, and pick this repo.
   - Build settings should auto-fill from `netlify.toml` (publish dir
     `public`, functions dir `netlify/functions`, build command
     `npm install`). Confirm and deploy.

3. **Set environment variables** (Site configuration → Environment variables):
   - `SESSION_SECRET` — any long random string (used to sign admin login
     cookies). Without this it falls back to an insecure default.
   - `ADMIN_INITIAL_PASSWORD` — optional; sets the doctor login password the
     *first* time the database initializes. If you skip it, the old default
     `DrAmit@123` is used again, so it's worth setting this before your first
     deploy. You can also just log in and use "change password" afterward.

4. **Netlify DB provisions automatically** the first time the site builds
   with `@netlify/database` in its dependencies — you'll see it appear under
   **Site configuration → Environment variables** as `NETLIFY_DATABASE_URL`
   once it's live. If it doesn't appear, go to **Extensions** in the Netlify
   dashboard and add the "Netlify DB" / Neon extension manually, then
   redeploy.

5. **Redeploy**, then check `/admin-login.html` and `/appointment` — slots
   should load and bookings/admin actions should persist across visits now.

## One caveat worth knowing
I built and reviewed this code carefully but couldn't run it against a live
Netlify DB from my side (no network access here), so treat the first deploy
as a test: book a dummy appointment and log into the admin panel to confirm
everything reads/writes correctly before pointing real patients at it. If
something errors, the Netlify function logs (Site → Logs → Functions) will
show exactly what failed.
