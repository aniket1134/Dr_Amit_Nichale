// netlify/functions/api.js
// Single Netlify Function handling every /api/* route for the clinic site.
// Replaces the old always-on server.js -- each request is a fresh, stateless
// invocation, so all state lives in Netlify DB (Postgres) instead of memory
// or local disk.

const {
  sql, ensureSchema, verifyUser, setPassword,
  createSessionToken, getSession, sessionCookieHeader,
  json, isValidMobile,
} = require('./lib');

const SLOTS = [
  '10:00 AM', '10:30 AM', '11:00 AM', '11:30 AM', '12:00 PM', '12:30 PM',
  '05:00 PM', '05:30 PM', '06:00 PM', '06:30 PM', '07:00 PM', '07:30 PM', '08:00 PM',
];

function requireAdmin(req) {
  return getSession(req); // { username } or null
}

async function readJsonBody(req) {
  try {
    const text = await req.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

async function patientWithTotals(row) {
  const totalRows = await sql`SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE patient_id = ${row.id}`;
  return { ...row, total_fees_received: Number(totalRows[0].total) };
}

exports.handler = async (req, context) => {
  await ensureSchema();

  const url = new URL(req.url);
  // Strip the function mount prefix so routes match the original /api/... paths.
  let pathname = url.pathname.replace(/^\/\.netlify\/functions\/api/, '').replace(/^\/api/, '');
  if (pathname === '') pathname = '/';
  const method = req.method;
  const query = url.searchParams;

  try {
    // ---- Public API ----
    if (method === 'POST' && pathname === '/appointments') {
      const data = await readJsonBody(req);
      if (!data) return json(400, { error: 'Invalid request body' });
      const name = (data.name || '').toString().trim();
      const mobile = (data.mobile || '').toString().trim();
      const appointment_date = (data.date || '').toString().trim();
      const appointment_time = (data.time || '').toString().trim();
      if (!name) return json(400, { error: 'Patient name is required' });
      if (!isValidMobile(mobile)) return json(400, { error: 'Please enter a valid mobile number' });
      if (!appointment_date) return json(400, { error: 'Please choose a date' });
      if (!SLOTS.includes(appointment_time)) return json(400, { error: 'Please choose a valid time slot' });

      const clash = await sql`SELECT id FROM appointments WHERE appointment_date = ${appointment_date}
        AND appointment_time = ${appointment_time} AND status != 'cancelled'`;
      if (clash.length) return json(409, { error: 'That slot was just booked by someone else. Please pick another.' });

      const inserted = await sql`INSERT INTO appointments (name, mobile, appointment_date, appointment_time)
        VALUES (${name}, ${mobile}, ${appointment_date}, ${appointment_time}) RETURNING id`;
      return json(201, {
        message: `Appointment confirmed for ${name} on ${appointment_date} at ${appointment_time}.`,
        appointment_id: inserted[0].id,
      });
    }

    if (method === 'GET' && pathname === '/appointments/slots') {
      const date = query.get('date') || '';
      if (!date) return json(400, { error: 'date query param required' });
      const rows = await sql`SELECT appointment_time FROM appointments
        WHERE appointment_date = ${date} AND status != 'cancelled'`;
      return json(200, { all_slots: SLOTS, booked_slots: rows.map((r) => r.appointment_time) });
    }

    if (method === 'POST' && pathname === '/feedback') {
      const data = await readJsonBody(req);
      if (!data) return json(400, { error: 'Invalid request body' });
      const {
        patient_name = '', mobile = '', overall_experience = '', staff_friendliness = '',
        cleanliness = '', wait_time = '', would_recommend = '', comments = '',
      } = data;
      await sql`INSERT INTO feedback
        (patient_name, mobile, overall_experience, staff_friendliness, cleanliness, wait_time, would_recommend, comments)
        VALUES (${patient_name.toString().trim()}, ${mobile.toString().trim()}, ${overall_experience},
                ${staff_friendliness}, ${cleanliness}, ${wait_time}, ${would_recommend}, ${comments.toString().trim()})`;
      return json(201, { message: 'Thank you! Your feedback has been recorded.' });
    }

    // ---- Admin auth ----
    if (method === 'POST' && pathname === '/admin/login') {
      const data = await readJsonBody(req);
      if (!data) return json(400, { error: 'Invalid request body' });
      const user = await verifyUser((data.username || '').toString().trim(), (data.password || '').toString());
      if (!user) return json(401, { error: 'Invalid username or password' });
      const token = createSessionToken(user.username);
      return json(200, { message: 'Logged in', username: user.username },
        { 'Set-Cookie': sessionCookieHeader(token, 8 * 60 * 60) });
    }

    if (method === 'POST' && pathname === '/admin/logout') {
      return json(200, { message: 'Logged out' }, { 'Set-Cookie': sessionCookieHeader('', 0) });
    }

    if (method === 'GET' && pathname === '/admin/session') {
      const session = requireAdmin(req);
      return json(200, { authenticated: !!session, username: session ? session.username : null });
    }

    if (method === 'POST' && pathname === '/admin/change-password') {
      const session = requireAdmin(req);
      if (!session) return json(401, { error: 'Not authenticated' });
      const data = await readJsonBody(req);
      if (!data) return json(400, { error: 'Invalid request body' });
      const user = await verifyUser(session.username, (data.current_password || '').toString());
      if (!user) return json(401, { error: 'Current password is incorrect' });
      if (!data.new_password || data.new_password.toString().length < 6) {
        return json(400, { error: 'New password must be at least 6 characters' });
      }
      await setPassword(session.username, data.new_password.toString());
      return json(200, { message: 'Password updated' });
    }

    // ---- Admin: patients ----
    if (method === 'GET' && pathname === '/admin/patients') {
      const session = requireAdmin(req);
      if (!session) return json(401, { error: 'Not authenticated' });
      const nameFilter = query.get('name') || '';
      const mobileFilter = query.get('mobile') || '';
      const rows = await sql`SELECT * FROM patients
        WHERE (${nameFilter} = '' OR name ILIKE ${'%' + nameFilter + '%'})
        AND (${mobileFilter} = '' OR mobile ILIKE ${'%' + mobileFilter + '%'})
        ORDER BY created_at DESC`;
      const patients = await Promise.all(rows.map(patientWithTotals));
      return json(200, { patients });
    }

    if (method === 'POST' && pathname === '/admin/patients') {
      const session = requireAdmin(req);
      if (!session) return json(401, { error: 'Not authenticated' });
      const data = await readJsonBody(req);
      if (!data) return json(400, { error: 'Invalid request body' });
      const name = (data.name || '').toString().trim();
      const mobile = (data.mobile || '').toString().trim();
      if (!name) return json(400, { error: 'Name is required' });
      if (!isValidMobile(mobile)) return json(400, { error: 'Valid mobile number is required' });
      const inserted = await sql`INSERT INTO patients (name, mobile) VALUES (${name}, ${mobile}) RETURNING *`;
      await sql`INSERT INTO clinical_records (patient_id) VALUES (${inserted[0].id})`;
      return json(201, { patient: await patientWithTotals(inserted[0]) });
    }

    let m;
    if ((m = pathname.match(/^\/admin\/patients\/(\d+)$/)) && method === 'GET') {
      const session = requireAdmin(req);
      if (!session) return json(401, { error: 'Not authenticated' });
      const id = m[1];
      const patients = await sql`SELECT * FROM patients WHERE id = ${id}`;
      if (!patients.length) return json(404, { error: 'Patient not found' });
      const clinicalRows = await sql`SELECT * FROM clinical_records WHERE patient_id = ${id} ORDER BY id DESC LIMIT 1`;
      const clinical = clinicalRows[0] || { examination_notes: '', diagnosis: '', treatment_advice: '' };
      const payments = await sql`SELECT * FROM payments WHERE patient_id = ${id} ORDER BY paid_at DESC`;
      const reports = await sql`SELECT id, original_name, mime_type, size_bytes, uploaded_at FROM reports
        WHERE patient_id = ${id} ORDER BY uploaded_at DESC`;
      const appointments = await sql`SELECT * FROM appointments WHERE patient_id = ${id} ORDER BY appointment_date DESC`;
      const total = payments.reduce((sum, p) => sum + Number(p.amount), 0);
      return json(200, { patient: patients[0], clinical, payments, reports, appointments, total_fees_received: total });
    }

    if ((m = pathname.match(/^\/admin\/patients\/(\d+)\/clinical$/)) && method === 'PUT') {
      const session = requireAdmin(req);
      if (!session) return json(401, { error: 'Not authenticated' });
      const id = m[1];
      const patients = await sql`SELECT id FROM patients WHERE id = ${id}`;
      if (!patients.length) return json(404, { error: 'Patient not found' });
      const data = await readJsonBody(req);
      if (!data) return json(400, { error: 'Invalid request body' });
      const { examination_notes = '', diagnosis = '', treatment_advice = '' } = data;
      const existing = await sql`SELECT id FROM clinical_records WHERE patient_id = ${id}`;
      if (existing.length) {
        await sql`UPDATE clinical_records SET examination_notes = ${examination_notes}, diagnosis = ${diagnosis},
          treatment_advice = ${treatment_advice}, updated_at = now() WHERE patient_id = ${id}`;
      } else {
        await sql`INSERT INTO clinical_records (patient_id, examination_notes, diagnosis, treatment_advice)
          VALUES (${id}, ${examination_notes}, ${diagnosis}, ${treatment_advice})`;
      }
      return json(200, { message: 'Clinical record updated' });
    }

    if ((m = pathname.match(/^\/admin\/patients\/(\d+)\/payments$/)) && method === 'POST') {
      const session = requireAdmin(req);
      if (!session) return json(401, { error: 'Not authenticated' });
      const id = m[1];
      const patients = await sql`SELECT id FROM patients WHERE id = ${id}`;
      if (!patients.length) return json(404, { error: 'Patient not found' });
      const data = await readJsonBody(req);
      if (!data) return json(400, { error: 'Invalid request body' });
      const amount = parseFloat(data.amount);
      const note = (data.note || '').toString().trim();
      if (!Number.isFinite(amount) || amount <= 0) return json(400, { error: 'Enter a valid payment amount' });
      await sql`INSERT INTO payments (patient_id, amount, note) VALUES (${id}, ${amount}, ${note})`;
      const totalRows = await sql`SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE patient_id = ${id}`;
      return json(201, { message: 'Payment recorded', total_fees_received: Number(totalRows[0].total) });
    }

    if ((m = pathname.match(/^\/admin\/patients\/(\d+)\/reports$/)) && method === 'POST') {
      const session = requireAdmin(req);
      if (!session) return json(401, { error: 'Not authenticated' });
      const id = m[1];
      const patients = await sql`SELECT id FROM patients WHERE id = ${id}`;
      if (!patients.length) return json(404, { error: 'Patient not found' });
      const data = await readJsonBody(req);
      if (!data) return json(400, { error: 'Invalid request body' });
      const { filename, mime_type, base64_data } = data;
      if (!filename || !base64_data) return json(400, { error: 'filename and base64_data are required' });
      const sizeBytes = Buffer.from(base64_data, 'base64').length;
      if (sizeBytes > 25 * 1024 * 1024) return json(413, { error: 'File too large (max 25MB)' });
      await sql`INSERT INTO reports (patient_id, original_name, mime_type, size_bytes, data_base64)
        VALUES (${id}, ${filename}, ${mime_type || 'application/octet-stream'}, ${sizeBytes}, ${base64_data})`;
      return json(201, { message: 'Report uploaded' });
    }

    if ((m = pathname.match(/^\/admin\/reports\/(\d+)\/file$/)) && method === 'GET') {
      const session = requireAdmin(req);
      if (!session) return new Response('Not authenticated', { status: 401 });
      const rows = await sql`SELECT * FROM reports WHERE id = ${m[1]}`;
      if (!rows.length) return new Response('Not found', { status: 404 });
      const report = rows[0];
      const buffer = Buffer.from(report.data_base64, 'base64');
      return new Response(buffer, {
        status: 200,
        headers: {
          'Content-Type': report.mime_type,
          'Content-Disposition': `inline; filename="${report.original_name.replace(/"/g, '')}"`,
        },
      });
    }

    if ((m = pathname.match(/^\/admin\/reports\/(\d+)$/)) && method === 'DELETE') {
      const session = requireAdmin(req);
      if (!session) return json(401, { error: 'Not authenticated' });
      const rows = await sql`SELECT id FROM reports WHERE id = ${m[1]}`;
      if (!rows.length) return json(404, { error: 'Report not found' });
      await sql`DELETE FROM reports WHERE id = ${m[1]}`;
      return json(200, { message: 'Report deleted' });
    }

    // ---- Admin: appointments ----
    if (method === 'GET' && pathname === '/admin/appointments') {
      const session = requireAdmin(req);
      if (!session) return json(401, { error: 'Not authenticated' });
      const upcoming = query.get('upcoming') === '1';
      const rows = upcoming
        ? await sql`SELECT * FROM appointments WHERE appointment_date >= to_char(now(), 'YYYY-MM-DD')
            ORDER BY appointment_date ASC, appointment_time ASC`
        : await sql`SELECT * FROM appointments ORDER BY appointment_date ASC, appointment_time ASC`;
      return json(200, { appointments: rows });
    }

    if ((m = pathname.match(/^\/admin\/appointments\/(\d+)\/link$/)) && method === 'POST') {
      const session = requireAdmin(req);
      if (!session) return json(401, { error: 'Not authenticated' });
      const apptRows = await sql`SELECT * FROM appointments WHERE id = ${m[1]}`;
      if (!apptRows.length) return json(404, { error: 'Appointment not found' });
      const appt = apptRows[0];
      const data = (await readJsonBody(req)) || {};
      let patientId = data.patient_id;
      if (!patientId) {
        const existing = await sql`SELECT id FROM patients WHERE mobile = ${appt.mobile} AND name = ${appt.name}`;
        if (existing.length) {
          patientId = existing[0].id;
        } else {
          const inserted = await sql`INSERT INTO patients (name, mobile) VALUES (${appt.name}, ${appt.mobile}) RETURNING id`;
          patientId = inserted[0].id;
          await sql`INSERT INTO clinical_records (patient_id) VALUES (${patientId})`;
        }
      }
      await sql`UPDATE appointments SET patient_id = ${patientId} WHERE id = ${m[1]}`;
      return json(200, { message: 'Appointment linked to patient', patient_id: patientId });
    }

    if ((m = pathname.match(/^\/admin\/appointments\/(\d+)\/status$/)) && method === 'POST') {
      const session = requireAdmin(req);
      if (!session) return json(401, { error: 'Not authenticated' });
      const apptRows = await sql`SELECT id FROM appointments WHERE id = ${m[1]}`;
      if (!apptRows.length) return json(404, { error: 'Appointment not found' });
      const data = await readJsonBody(req);
      if (!data) return json(400, { error: 'Invalid request body' });
      const status = (data.status || '').toString();
      if (!['booked', 'completed', 'cancelled'].includes(status)) {
        return json(400, { error: 'status must be booked, completed, or cancelled' });
      }
      await sql`UPDATE appointments SET status = ${status} WHERE id = ${m[1]}`;
      return json(200, { message: 'Appointment updated' });
    }

    // ---- Admin: feedback ----
    if (method === 'GET' && pathname === '/admin/feedback') {
      const session = requireAdmin(req);
      if (!session) return json(401, { error: 'Not authenticated' });
      const rows = await sql`SELECT * FROM feedback ORDER BY created_at DESC`;
      return json(200, { feedback: rows });
    }

    return json(404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Server error' });
  }
};

// Netlify Functions v2: mount this function directly at /api/* -- no
// netlify.toml redirect needed.
exports.config = { path: '/api/*' };
