// db.js
// All database access for the clinic app. Uses Node's built-in `node:sqlite`
// (available in Node 22+) so the project needs zero external dependencies.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'clinic.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mobile TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_patients_mobile ON patients(mobile);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(name);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  mobile TEXT NOT NULL,
  appointment_date TEXT NOT NULL,
  appointment_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'booked',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appt_date ON appointments(appointment_date);

CREATE TABLE IF NOT EXISTS clinical_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  examination_notes TEXT,
  diagnosis TEXT,
  treatment_advice TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  note TEXT,
  paid_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_name TEXT,
  mobile TEXT,
  overall_experience TEXT,
  staff_friendliness TEXT,
  cleanliness TEXT,
  wait_time TEXT,
  would_recommend TEXT,
  comments TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// --- Seed a default admin user (doctor login) if none exists yet ---
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function ensureDefaultAdmin() {
  const existing = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (existing) return;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword('DrAmit@123', salt);
  db.prepare('INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)')
    .run('doctor', hash, salt);
  console.log('Created default admin user -> username: doctor | password: DrAmit@123');
  console.log('IMPORTANT: change this password after first login (see README).');
}
ensureDefaultAdmin();

function verifyUser(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return null;
  const hash = hashPassword(password, user.salt);
  if (hash === user.password_hash) return user;
  return null;
}

function setPassword(username, newPassword) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(newPassword, salt);
  db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE username = ?')
    .run(hash, salt, username);
}

module.exports = { db, verifyUser, setPassword, hashPassword };
