# Dr Amit Nichale's Multispeciality Dental Care — Website

A complete clinic website: patient-facing home page, online appointment booking,
feedback collection, location/map page, and a password-protected admin dashboard
for the doctor to manage patients, clinical records, fees, and reports.

## Why there's no `npm install`

This project is written in **plain Node.js** using only built-in modules
(`http`, `fs`, `crypto`, and Node's built-in `node:sqlite`). There are **zero
external npm dependencies** — nothing to download, no version conflicts, and
nothing to go out of date. You only need Node.js itself.

## Requirements

- **Node.js v22.5 or later** (needed for the built-in `node:sqlite` module).
  Check your version with `node --version`. If you're on an older Node, install
  the latest LTS from https://nodejs.org.

## Running it locally

```bash
cd dental-clinic
node server.js
```

You'll see:

```
Created default admin user -> username: doctor | password: DrAmit@123
Dr Amit Nichale's Dental Clinic website running at http://localhost:3000
Admin dashboard: http://localhost:3000/admin-login.html
```

Open **http://localhost:3000** in your browser. That's it — no build step, no
database server to install, no environment variables required.

To run on a different port: `PORT=8080 node server.js`.

### First-time admin login

- URL: `http://localhost:3000/admin-login.html`
- Username: `doctor`
- Password: `DrAmit@123`

**Change this password immediately** using the "Settings" tab in the dashboard
after logging in. The default credentials are only meant to get you in the door.

## Project structure

```
dental-clinic/
├── server.js          # HTTP server + all routes (pages, API, admin API)
├── db.js              # SQLite schema + user auth helpers
├── utils.js           # Body parsing, cookies, sessions, static file serving
├── package.json
├── data/
│   └── clinic.db       # SQLite database file (created automatically on first run)
├── uploads/             # Uploaded patient reports (X-rays, PDFs) live here
└── public/               # Everything served to the browser
    ├── index.html          # Home page
    ├── appointment.html     # Patient-facing booking form
    ├── feedback.html         # Feedback form + link to Google reviews
    ├── location.html          # Map + address + share buttons
    ├── admin-login.html        # Doctor login
    ├── admin-dashboard.html      # Doctor-only dashboard (patients/appointments/feedback/settings)
    ├── css/style.css
    ├── js/common.js
    └── images/                    # Clinic + doctor photos
```

## Database schema

SQLite, stored at `data/clinic.db`. Created automatically on first run — no
manual setup needed. Tables:

| Table               | Purpose                                                                 |
|----------------------|--------------------------------------------------------------------------|
| `users`              | Admin (doctor) login — username + salted/hashed password                |
| `patients`           | Patient master record — name, mobile                                     |
| `appointments`       | Bookings from the public appointment form; `patient_id` links to `patients` once the doctor links/creates a record |
| `clinical_records`   | Examination notes, diagnosis, treatment advice per patient                |
| `payments`           | Every individual payment; **fees received is always the live `SUM()`** of this table for a patient, never a stored running number, so it can never drift out of sync |
| `reports`            | Metadata for uploaded X-rays/documents; the actual files live in `uploads/`, referenced by `stored_name` |
| `feedback`           | Patient feedback submissions                                              |

Relationships: `appointments.patient_id`, `clinical_records.patient_id`,
`payments.patient_id`, and `reports.patient_id` all reference `patients.id`
(with cascading delete for clinical/payments/reports if a patient is ever
removed directly in SQLite).

## How each requested feature is implemented

1. **Home page** — clinic name, hero image, Dr. Amit Nichale's photo, nav to all sections. `public/index.html`.
2. **Appointment page** — name + mobile fields, a 14-day date-chip strip plus a native date picker (works as the "calendar widget"), a slot grid that disables already-booked times per day (fetched live from `/api/appointments/slots`), submits to `/api/appointments`, shows a confirmation message.
3. **Patient database** — `patients`, `clinical_records`, `payments`, `reports` tables as above. Fees received is a running total computed by summing all payments.
4. **Admin dashboard** — login-gated (`/api/admin/session` guard on every admin route), filterable patient table (by name/mobile), per-patient modal to view/edit clinical notes, add payments, upload/view/delete reports, and see appointment history.
5. **Feedback page** — multiple-choice (pill/radio) questions plus free-text comments, stored in `feedback` table; a prominent button links out to the clinic's real Google Business reviews (see note below on why it's a link, not an embed).
6. **Location & map** — an embedded Google Map (no API key required, using Maps' public `output=embed` URL), full address, an "Open in Google Maps" button, a "Copy Shareable Link" button, and WhatsApp/Email share buttons.

### A note on Google Reviews

Google does not allow live review *content* (star ratings, review text) to be
pulled into a third-party site without a **paid Google Places API key** — this
is a Google restriction, not a limitation of this project. What's included
instead:
- A prominent, correctly-linked button straight to the clinic's real Google
  Business reviews page, so patients can read/write reviews in one click.
- If you obtain a Google Places API (with billing enabled), you can swap this
  button for a live-rated widget: fetch `https://maps.googleapis.com/maps/api/place/details/json?place_id=ChIJ...&fields=reviews&key=YOUR_KEY` from the server (never from the browser, to keep the key private) and render the `reviews` array in `feedback.html`.

### A note on the map embed

The map on `location.html` uses Google's key-free `output=embed` URL, which
works out of the box but is a lighter-weight embed than Google's official Maps
Embed API. For a nicer, officially-supported embed, get a free Maps Embed API
key from https://console.cloud.google.com/google/maps-apis and replace the
`iframe src` in `location.html` with:
```
https://www.google.com/maps/embed/v1/place?key=YOUR_KEY&q=place_id:ChIJ...
```

## Customizing

- **Clinic hours / slots**: edit the `SLOTS` array near the top of `server.js`.
- **Admin password**: use the Settings tab in the dashboard (recommended), or
  run this one-off script to reset it directly:
  ```bash
  node -e "require('./db').setPassword('doctor', 'YourNewPassword123')"
  ```
- **Images**: replace files in `public/images/` (keep the same filenames, or
  update the `<img src>` paths in the HTML).

## Security notes for going to production

- Sessions are currently stored in memory, so they reset if you restart the
  server, and won't work if you run multiple server instances behind a load
  balancer. For a single small clinic running one server process, this is
  fine. For multi-instance deployments, swap the `sessions` Map in `utils.js`
  for a shared store (e.g. a `sessions` SQLite table).
- Serve over HTTPS in production (e.g. behind Nginx/Caddy, or a host that
  terminates TLS for you) — cookies are marked `HttpOnly` but not `Secure` by
  default since local development is over plain HTTP.
- Back up `data/clinic.db` and the `uploads/` folder regularly — that's the
  entire patient record.

## Deploying

Any host that can run `node server.js` continuously works: a small VPS, an
always-on box at the clinic, Render, Railway, Fly.io, etc. Just make sure:
1. Node v22.5+ is installed on the host.
2. The `data/` and `uploads/` folders are on **persistent** storage (not
   wiped on redeploy).
3. Set `PORT` if your host requires a specific port.
