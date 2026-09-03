# Deploying this on Netlify (with a real database)

## Fix applied in this version
The previous zip 404'd on every `/api/...` call even after a successful
deploy. Cause: `netlify/functions/api.js` was written using
`exports.handler` / `exports.config`, which is the **v1** (older,
AWS-Lambda-style) Netlify Functions convention. But the code itself used the
**v2** Request/Response API (`req.url`, `req.headers.get()`, returning a
`Response`). That mismatch meant Netlify never registered the `/api/*` path
route at all, so every call to it fell through to Netlify's generic 404
page — exactly what you saw on the appointment and feedback pages.

Fixed by converting `api.js` and `lib.js` to proper ES modules
(`export default` / `export const config = { path: '/api/*' }`), and adding
`"type": "module"` to `package.json` so Node treats them as ESM. The old
unused `server.js` / `db.js` / `utils.js` (CommonJS, no longer used) were
removed since they'd conflict with `"type": "module"` otherwise.

## A second fix (from your build log)
After the first fix, your build log showed the function bundling itself
failed with: `No matching export in "@netlify/database/dist/main.js" for
import "neon"`. I'd guessed the wrong function name — the actual package
export is `getDatabase()`, not `neon()`. Confirmed against Netlify's
official API docs:

```js
import { getDatabase } from '@netlify/database';
const db = getDatabase();
const rows = await db.sql`SELECT * FROM users WHERE id = ${id}`;
```

`lib.js` now uses this correctly. One reassuring thing from that same build
log: it showed `Provisioning database... completed in 301ms`, confirming
Netlify DB provisions automatically the moment `@netlify/database` is a
dependency — no manual database setup needed on your end.

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

## Redeploying this fix
Since you already have the repo linked to Netlify, just replace the changed
files in GitHub (same steps as before — upload/overwrite `netlify.toml`,
`package.json`, and everything under `netlify/functions/`, and delete
`server.js`, `db.js`, `utils.js` from the repo since they're gone from this
zip) and commit. Netlify will auto-redeploy.

**After it deploys, check the build log** (Site → Deploys → click the
deploy → build log) for a line mentioning `api` under "Functions bundling" —
that confirms the function was actually picked up this time. If it's
missing, the function file likely isn't in the repo at the right path
(`netlify/functions/api.js`) — see the GitHub nested-folder upload caveat
from earlier.

## Testing after every deploy
`test/test-api.mjs` is a runnable script (needs Node 18+ and internet, run
it from your own machine) that exercises every endpoint against your live
URL and prints pass/fail for each:

```
node test/test-api.mjs https://dr-amit-nichale-dental-clinic.netlify.app
```

It checks: slots load without a 404, a booking succeeds, double-booking the
same slot is correctly rejected, the booked slot then shows as unavailable,
feedback submits, admin login rejects a wrong password and accepts the
right one, and admin-only routes are blocked without a session and allowed
with one. Run it after every deploy before trusting the site with real
patients — if `ADMIN_PASSWORD` was changed from the default, pass it via
`ADMIN_PASSWORD=yournewpassword node test/test-api.mjs <url>`.

## One caveat worth knowing
I built and reviewed this code carefully but couldn't run it against a live
Netlify DB from my side (no network access here), so treat the first deploy
as a test: book a dummy appointment and log into the admin panel to confirm
everything reads/writes correctly before pointing real patients at it. If
something errors, the Netlify function logs (Site → Logs → Functions) will
show exactly what failed.
