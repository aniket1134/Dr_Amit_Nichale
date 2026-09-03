// server.js
// Dr Amit Nichale's Multispeciality Dental Care - website + admin backend.
// Pure Node.js (no external npm packages) so it runs with just `node server.js`.

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const url = require('url');

const { db, verifyUser, setPassword } = require('./db');
const {
  readJson, parseCookies, setCookie, createSession, getSession,
  destroySession, sendJson, serveStaticFile,
} = require('./utils');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Standard clinic slots. Edit this list to match real clinic hours.
const SLOTS = [
  '10:00 AM', '10:30 AM', '11:00 AM', '11:30 AM', '12:00 PM', '12:30 PM',
  '05:00 PM', '05:30 PM', '06:00 PM', '06:30 PM', '07:00 PM', '07:30 PM', '08:00 PM',
];

// ---------- Auth helper ----------
function requireAdmin(req, res) {
  const cookies = parseCookies(req);
  const session = getSession(cookies.session_token);
  if (!session) {
    sendJson(res, 401, { error: 'Not authenticated' });
    return null;
  }
  return session;
}

function isValidMobile(m) {
  return typeof m === 'string' && /^[0-9+\-\s]{7,15}$/.test(m.trim());
}

// ---------- Route handlers ----------

async function handleBookAppointment(req, res) {
  let data;
  try { data = await readJson(req); } catch (e) { return sendJson(res, 400, { error: 'Invalid request body' }); }
  const name = (data.name || '').toString().trim();
  const mobile = (data.mobile || '').toString().trim();
  const appointment_date = (data.date || '').toString().trim();
  const appointment_time = (data.time || '').toString().trim();

  if (!name) return sendJson(res, 400, { error: 'Patient name is required' });
  if (!isValidMobile(mobile)) return sendJson(res, 400, { error: 'Please enter a valid mobile number' });
  if (!appointment_date) return sendJson(res, 400, { error: 'Please choose a date' });
  if (!SLOTS.includes(appointment_time)) return sendJson(res, 400, { error: 'Please choose a valid time slot' });

  // Prevent double-booking the exact same slot
  const clash = db.prepare(
    "SELECT id FROM appointments WHERE appointment_date = ? AND appointment_time = ? AND status != 'cancelled'"
  ).get(appointment_date, appointment_time);
  if (clash) return sendJson(res, 409, { error: 'That slot was just booked by someone else. Please pick another.' });

  const info = db.prepare(
    'INSERT INTO appointments (name, mobile, appointment_date, appointment_time) VALUES (?, ?, ?, ?)'
  ).run(name, mobile, appointment_date, appointment_time);

  sendJson(res, 201, {
    message: `Appointment confirmed for ${name} on ${appointment_date} at ${appointment_time}.`,
    appointment_id: info.lastInsertRowid,
  });
}

function handleGetSlots(req, res, query) {
  const date = (query.date || '').toString();
  if (!date) return sendJson(res, 400, { error: 'date query param required' });
  const rows = db.prepare(
    "SELECT appointment_time FROM appointments WHERE appointment_date = ? AND status != 'cancelled'"
  ).all(date);
  const booked = rows.map(r => r.appointment_time);
  sendJson(res, 200, { all_slots: SLOTS, booked_slots: booked });
}

async function handleFeedback(req, res) {
  let data;
  try { data = await readJson(req); } catch (e) { return sendJson(res, 400, { error: 'Invalid request body' }); }
  const {
    patient_name = '', mobile = '', overall_experience = '', staff_friendliness = '',
    cleanliness = '', wait_time = '', would_recommend = '', comments = '',
  } = data;

  db.prepare(`INSERT INTO feedback
    (patient_name, mobile, overall_experience, staff_friendliness, cleanliness, wait_time, would_recommend, comments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(patient_name.toString().trim(), mobile.toString().trim(), overall_experience, staff_friendliness,
      cleanliness, wait_time, would_recommend, comments.toString().trim());

  sendJson(res, 201, { message: 'Thank you! Your feedback has been recorded.' });
}

// ----- Admin: auth -----
async function handleAdminLogin(req, res) {
  let data;
  try { data = await readJson(req); } catch (e) { return sendJson(res, 400, { error: 'Invalid request body' }); }
  const { username, password } = data;
  const user = verifyUser((username || '').toString().trim(), (password || '').toString());
  if (!user) return sendJson(res, 401, { error: 'Invalid username or password' });
  const token = createSession(user.username);
  setCookie(res, 'session_token', token, { maxAge: 8 * 60 * 60 });
  sendJson(res, 200, { message: 'Logged in', username: user.username });
}

function handleAdminLogout(req, res) {
  const cookies = parseCookies(req);
  destroySession(cookies.session_token);
  setCookie(res, 'session_token', '', { expires: 0 });
  sendJson(res, 200, { message: 'Logged out' });
}

function handleAdminSession(req, res) {
  const cookies = parseCookies(req);
  const session = getSession(cookies.session_token);
  sendJson(res, 200, { authenticated: !!session, username: session ? session.username : null });
}

async function handleChangePassword(req, res) {
  const session = requireAdmin(req, res);
  if (!session) return;
  let data;
  try { data = await readJson(req); } catch (e) { return sendJson(res, 400, { error: 'Invalid request body' }); }
  const { current_password, new_password } = data;
  const user = verifyUser(session.username, (current_password || '').toString());
  if (!user) return sendJson(res, 401, { error: 'Current password is incorrect' });
  if (!new_password || new_password.toString().length < 6) {
    return sendJson(res, 400, { error: 'New password must be at least 6 characters' });
  }
  setPassword(session.username, new_password.toString());
  sendJson(res, 200, { message: 'Password updated' });
}

// ----- Admin: patients -----
function patientWithTotals(row) {
  const total = db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE patient_id = ?').get(row.id).total;
  return { ...row, total_fees_received: total };
}

function handleListPatients(req, res, query) {
  const session = requireAdmin(req, res);
  if (!session) return;
  const nameFilter = (query.name || '').toString().trim();
  const mobileFilter = (query.mobile || '').toString().trim();

  let sql = 'SELECT * FROM patients WHERE 1=1';
  const params = [];
  if (nameFilter) { sql += ' AND name LIKE ?'; params.push(`%${nameFilter}%`); }
  if (mobileFilter) { sql += ' AND mobile LIKE ?'; params.push(`%${mobileFilter}%`); }
  sql += ' ORDER BY created_at DESC';

  const rows = db.prepare(sql).all(...params);
  sendJson(res, 200, { patients: rows.map(patientWithTotals) });
}

async function handleCreatePatient(req, res) {
  const session = requireAdmin(req, res);
  if (!session) return;
  let data;
  try { data = await readJson(req); } catch (e) { return sendJson(res, 400, { error: 'Invalid request body' }); }
  const name = (data.name || '').toString().trim();
  const mobile = (data.mobile || '').toString().trim();
  if (!name) return sendJson(res, 400, { error: 'Name is required' });
  if (!isValidMobile(mobile)) return sendJson(res, 400, { error: 'Valid mobile number is required' });

  const info = db.prepare('INSERT INTO patients (name, mobile) VALUES (?, ?)').run(name, mobile);
  db.prepare('INSERT INTO clinical_records (patient_id) VALUES (?)').run(info.lastInsertRowid);
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(info.lastInsertRowid);
  sendJson(res, 201, { patient: patientWithTotals(patient) });
}

function handlePatientDetail(req, res, id) {
  const session = requireAdmin(req, res);
  if (!session) return;
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  if (!patient) return sendJson(res, 404, { error: 'Patient not found' });

  const clinical = db.prepare('SELECT * FROM clinical_records WHERE patient_id = ? ORDER BY id DESC LIMIT 1').get(id)
    || { examination_notes: '', diagnosis: '', treatment_advice: '' };
  const payments = db.prepare('SELECT * FROM payments WHERE patient_id = ? ORDER BY paid_at DESC').all(id);
  const reports = db.prepare('SELECT id, original_name, mime_type, size_bytes, uploaded_at FROM reports WHERE patient_id = ? ORDER BY uploaded_at DESC').all(id);
  const appointments = db.prepare('SELECT * FROM appointments WHERE patient_id = ? ORDER BY appointment_date DESC').all(id);
  const total = payments.reduce((sum, p) => sum + p.amount, 0);

  sendJson(res, 200, { patient, clinical, payments, reports, appointments, total_fees_received: total });
}

async function handleUpdateClinical(req, res, id) {
  const session = requireAdmin(req, res);
  if (!session) return;
  const patient = db.prepare('SELECT id FROM patients WHERE id = ?').get(id);
  if (!patient) return sendJson(res, 404, { error: 'Patient not found' });

  let data;
  try { data = await readJson(req); } catch (e) { return sendJson(res, 400, { error: 'Invalid request body' }); }
  const { examination_notes = '', diagnosis = '', treatment_advice = '' } = data;

  const existing = db.prepare('SELECT id FROM clinical_records WHERE patient_id = ?').get(id);
  if (existing) {
    db.prepare('UPDATE clinical_records SET examination_notes = ?, diagnosis = ?, treatment_advice = ?, updated_at = datetime(\'now\') WHERE patient_id = ?')
      .run(examination_notes, diagnosis, treatment_advice, id);
  } else {
    db.prepare('INSERT INTO clinical_records (patient_id, examination_notes, diagnosis, treatment_advice) VALUES (?, ?, ?, ?)')
      .run(id, examination_notes, diagnosis, treatment_advice);
  }
  sendJson(res, 200, { message: 'Clinical record updated' });
}

async function handleAddPayment(req, res, id) {
  const session = requireAdmin(req, res);
  if (!session) return;
  const patient = db.prepare('SELECT id FROM patients WHERE id = ?').get(id);
  if (!patient) return sendJson(res, 404, { error: 'Patient not found' });

  let data;
  try { data = await readJson(req); } catch (e) { return sendJson(res, 400, { error: 'Invalid request body' }); }
  const amount = parseFloat(data.amount);
  const note = (data.note || '').toString().trim();
  if (!Number.isFinite(amount) || amount <= 0) return sendJson(res, 400, { error: 'Enter a valid payment amount' });

  db.prepare('INSERT INTO payments (patient_id, amount, note) VALUES (?, ?, ?)').run(id, amount, note);
  const total = db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE patient_id = ?').get(id).total;
  sendJson(res, 201, { message: 'Payment recorded', total_fees_received: total });
}

async function handleUploadReport(req, res, id) {
  const session = requireAdmin(req, res);
  if (!session) return;
  const patient = db.prepare('SELECT id FROM patients WHERE id = ?').get(id);
  if (!patient) return sendJson(res, 404, { error: 'Patient not found' });

  let data;
  try { data = await readJson(req); } catch (e) {
    if (e.message === 'PAYLOAD_TOO_LARGE') return sendJson(res, 413, { error: 'File too large (max 25MB)' });
    return sendJson(res, 400, { error: 'Invalid request body' });
  }
  const { filename, mime_type, base64_data } = data;
  if (!filename || !base64_data) return sendJson(res, 400, { error: 'filename and base64_data are required' });

  const buffer = Buffer.from(base64_data, 'base64');
  const ext = path.extname(filename) || '';
  const storedName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, storedName), buffer);

  db.prepare(`INSERT INTO reports (patient_id, original_name, stored_name, mime_type, size_bytes)
    VALUES (?, ?, ?, ?, ?)`).run(id, filename, storedName, mime_type || 'application/octet-stream', buffer.length);

  sendJson(res, 201, { message: 'Report uploaded' });
}

function handleDeleteReport(req, res, reportId) {
  const session = requireAdmin(req, res);
  if (!session) return;
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId);
  if (!report) return sendJson(res, 404, { error: 'Report not found' });
  const filePath = path.join(UPLOADS_DIR, report.stored_name);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  db.prepare('DELETE FROM reports WHERE id = ?').run(reportId);
  sendJson(res, 200, { message: 'Report deleted' });
}

function handleDownloadReport(req, res, reportId) {
  const cookies = parseCookies(req);
  const session = getSession(cookies.session_token);
  if (!session) { res.writeHead(401); return res.end('Not authenticated'); }
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId);
  if (!report) { res.writeHead(404); return res.end('Not found'); }
  const filePath = path.join(UPLOADS_DIR, report.stored_name);
  if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('File missing on disk'); }
  const data = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': report.mime_type,
    'Content-Disposition': `inline; filename="${report.original_name.replace(/"/g, '')}"`,
  });
  res.end(data);
}

function handleListAppointmentsAdmin(req, res, query) {
  const session = requireAdmin(req, res);
  if (!session) return;
  const upcoming = (query.upcoming || '') === '1';
  let sql = 'SELECT * FROM appointments';
  if (upcoming) sql += ` WHERE appointment_date >= date('now')`;
  sql += ' ORDER BY appointment_date ASC, appointment_time ASC';
  const rows = db.prepare(sql).all();
  sendJson(res, 200, { appointments: rows });
}

async function handleLinkAppointment(req, res, appointmentId) {
  const session = requireAdmin(req, res);
  if (!session) return;
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
  if (!appt) return sendJson(res, 404, { error: 'Appointment not found' });

  let data;
  try { data = await readJson(req); } catch (e) { data = {}; }

  let patientId = data.patient_id;
  if (!patientId) {
    // create a new patient record from the appointment's name/mobile
    let existing = db.prepare('SELECT id FROM patients WHERE mobile = ? AND name = ?').get(appt.mobile, appt.name);
    if (existing) {
      patientId = existing.id;
    } else {
      const info = db.prepare('INSERT INTO patients (name, mobile) VALUES (?, ?)').run(appt.name, appt.mobile);
      db.prepare('INSERT INTO clinical_records (patient_id) VALUES (?)').run(info.lastInsertRowid);
      patientId = info.lastInsertRowid;
    }
  }
  db.prepare('UPDATE appointments SET patient_id = ? WHERE id = ?').run(patientId, appointmentId);
  sendJson(res, 200, { message: 'Appointment linked to patient', patient_id: patientId });
}

async function handleAppointmentStatus(req, res, appointmentId) {
  const session = requireAdmin(req, res);
  if (!session) return;
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
  if (!appt) return sendJson(res, 404, { error: 'Appointment not found' });
  let data;
  try { data = await readJson(req); } catch (e) { return sendJson(res, 400, { error: 'Invalid request body' }); }
  const status = (data.status || '').toString();
  if (!['booked', 'completed', 'cancelled'].includes(status)) {
    return sendJson(res, 400, { error: 'status must be booked, completed, or cancelled' });
  }
  db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, appointmentId);
  sendJson(res, 200, { message: 'Appointment updated' });
}

function handleListFeedbackAdmin(req, res) {
  const session = requireAdmin(req, res);
  if (!session) return;
  const rows = db.prepare('SELECT * FROM feedback ORDER BY created_at DESC').all();
  sendJson(res, 200, { feedback: rows });
}

// ---------- Router ----------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);
  const method = req.method;
  const query = parsed.query;

  try {
    // ---- Public API ----
    if (method === 'POST' && pathname === '/api/appointments') return await handleBookAppointment(req, res);
    if (method === 'GET' && pathname === '/api/appointments/slots') return handleGetSlots(req, res, query);
    if (method === 'POST' && pathname === '/api/feedback') return await handleFeedback(req, res);

    // ---- Admin auth ----
    if (method === 'POST' && pathname === '/api/admin/login') return await handleAdminLogin(req, res);
    if (method === 'POST' && pathname === '/api/admin/logout') return handleAdminLogout(req, res);
    if (method === 'GET' && pathname === '/api/admin/session') return handleAdminSession(req, res);
    if (method === 'POST' && pathname === '/api/admin/change-password') return await handleChangePassword(req, res);

    // ---- Admin patients ----
    if (method === 'GET' && pathname === '/api/admin/patients') return handleListPatients(req, res, query);
    if (method === 'POST' && pathname === '/api/admin/patients') return await handleCreatePatient(req, res);

    let m;
    if ((m = pathname.match(/^\/api\/admin\/patients\/(\d+)$/)) && method === 'GET') {
      return handlePatientDetail(req, res, m[1]);
    }
    if ((m = pathname.match(/^\/api\/admin\/patients\/(\d+)\/clinical$/)) && method === 'PUT') {
      return await handleUpdateClinical(req, res, m[1]);
    }
    if ((m = pathname.match(/^\/api\/admin\/patients\/(\d+)\/payments$/)) && method === 'POST') {
      return await handleAddPayment(req, res, m[1]);
    }
    if ((m = pathname.match(/^\/api\/admin\/patients\/(\d+)\/reports$/)) && method === 'POST') {
      return await handleUploadReport(req, res, m[1]);
    }
    if ((m = pathname.match(/^\/api\/admin\/reports\/(\d+)\/file$/)) && method === 'GET') {
      return handleDownloadReport(req, res, m[1]);
    }
    if ((m = pathname.match(/^\/api\/admin\/reports\/(\d+)$/)) && method === 'DELETE') {
      return handleDeleteReport(req, res, m[1]);
    }

    // ---- Admin appointments ----
    if (method === 'GET' && pathname === '/api/admin/appointments') return handleListAppointmentsAdmin(req, res, query);
    if ((m = pathname.match(/^\/api\/admin\/appointments\/(\d+)\/link$/)) && method === 'POST') {
      return await handleLinkAppointment(req, res, m[1]);
    }
    if ((m = pathname.match(/^\/api\/admin\/appointments\/(\d+)\/status$/)) && method === 'POST') {
      return await handleAppointmentStatus(req, res, m[1]);
    }

    // ---- Admin feedback ----
    if (method === 'GET' && pathname === '/api/admin/feedback') return handleListFeedbackAdmin(req, res);

    // ---- Static files / pages ----
    if (method === 'GET') {
      let filePath = pathname === '/' ? '/index.html' : pathname;
      // convenience: /appointment -> /appointment.html, /admin -> /admin/dashboard redirect handled client-side
      if (!path.extname(filePath)) filePath += '.html';
      const abs = path.normalize(path.join(PUBLIC_DIR, filePath));
      if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return serveStaticFile(res, abs);
      }
      res.writeHead(404, { 'Content-Type': 'text/html' });
      return res.end('<h1>404 Not Found</h1><p><a href="/">Go home</a></p>');
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`\nDr Amit Nichale's Dental Clinic website running at http://localhost:${PORT}`);
  console.log(`Admin dashboard: http://localhost:${PORT}/admin-login.html\n`);
});
