// lib.js
// Shared helpers for the Netlify Functions backend: database access,
// schema setup, signed-cookie sessions, and small response helpers.
//
// Persistence: uses Netlify DB (Postgres, powered by Neon). The
// NETLIFY_DATABASE_URL env var is provided automatically once the database
// is provisioned for this site (see README-NETLIFY.md).

const crypto = require('crypto');
const { neon } = require('@netlify/database');

const sql = neon();

// ---------- Schema (idempotent) ----------
let schemaReady = null;
function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await sql`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS patients (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      mobile TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_patients_mobile ON patients(mobile)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(name)`;
    await sql`CREATE TABLE IF NOT EXISTS appointments (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      mobile TEXT NOT NULL,
      appointment_date TEXT NOT NULL,
      appointment_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'booked',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_appt_date ON appointments(appointment_date)`;
    await sql`CREATE TABLE IF NOT EXISTS clinical_records (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      examination_notes TEXT,
      diagnosis TEXT,
      treatment_advice TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      amount NUMERIC NOT NULL,
      note TEXT,
      paid_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      data_base64 TEXT NOT NULL,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS feedback (
      id SERIAL PRIMARY KEY,
      patient_name TEXT,
      mobile TEXT,
      overall_experience TEXT,
      staff_friendliness TEXT,
      cleanliness TEXT,
      wait_time TEXT,
      would_recommend TEXT,
      comments TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

    const existing = await sql`SELECT id FROM users LIMIT 1`;
    if (existing.length === 0) {
      const salt = crypto.randomBytes(16).toString('hex');
      // Set ADMIN_INITIAL_PASSWORD in Netlify site env vars before first
      // deploy to avoid the fallback default. Change it after first login
      // either way (see README-NETLIFY.md).
      const initialPassword = process.env.ADMIN_INITIAL_PASSWORD || 'DrAmit@123';
      const hash = hashPassword(initialPassword, salt);
      await sql`INSERT INTO users (username, password_hash, salt) VALUES ('doctor', ${hash}, ${salt})`;
    }
  })();
  return schemaReady;
}

// ---------- Passwords ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

async function verifyUser(username, password) {
  const rows = await sql`SELECT * FROM users WHERE username = ${username}`;
  const user = rows[0];
  if (!user) return null;
  const hash = hashPassword(password, user.salt);
  if (hash === user.password_hash) return user;
  return null;
}

async function setPassword(username, newPassword) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(newPassword, salt);
  await sql`UPDATE users SET password_hash = ${hash}, salt = ${salt} WHERE username = ${username}`;
}

// ---------- Stateless signed-cookie sessions ----------
// Functions don't share memory between invocations, so instead of an
// in-memory session map, the session is a signed token the browser holds:
// base64(username.expiry) + "." + HMAC-SHA256 signature.
// Set SESSION_SECRET in Netlify env vars (site settings -> Environment
// variables). Falls back to a fixed dev-only value otherwise -- change
// this in production.
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
}

function createSessionToken(username) {
  const payload = `${username}.${Date.now() + SESSION_TTL_MS}`;
  const sig = sign(payload);
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}

function readSessionToken(token) {
  if (!token || !token.includes('.')) return null;
  const [encodedPayload, sig] = token.split('.');
  let payload;
  try { payload = Buffer.from(encodedPayload, 'base64url').toString('utf8'); } catch (e) { return null; }
  if (sign(payload) !== sig) return null;
  const [username, expiresStr] = payload.split('.');
  const expires = Number(expiresStr);
  if (!username || !expires || Date.now() > expires) return null;
  return { username };
}

function parseCookies(req) {
  const header = req.headers.get('cookie');
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function getSession(req) {
  const cookies = parseCookies(req);
  return readSessionToken(cookies.session_token);
}

// ---------- Response helpers ----------
function json(status, obj, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function sessionCookieHeader(token, maxAgeSeconds) {
  const parts = [`session_token=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSeconds != null) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

function isValidMobile(m) {
  return typeof m === 'string' && /^[0-9+\-\s]{7,15}$/.test(m.trim());
}

module.exports = {
  sql, ensureSchema, verifyUser, setPassword,
  createSessionToken, getSession, sessionCookieHeader,
  json, isValidMobile,
};
