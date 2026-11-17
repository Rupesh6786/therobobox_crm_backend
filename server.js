const express = require('express');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Define allowed origins from environment variable, or fallback to trusted local development URLs
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : [
      'https://crm.therobobox.co', 
      'http://localhost:3000', 
      'http://localhost:5500', 
      'http://localhost:53670'
    ];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('CORS Policy: Access denied from unauthorized domain.'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
// Excel imports carry a few hundred rows, so the default 100kb body limit is too small.
app.use(express.json({ limit: '10mb' }));

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10
});

// 1. Fetch full state for the client app
// 1. Fetch full state for the client app
app.get('/api/state', async (req, res) => {
  try {
    // Fetch with explicit casting for numeric/decimal fields
    const [schools] = await pool.query(`
      SELECT id, name, location, region, cluster, board, 
             CAST(students AS SIGNED) as students, 
             stemLab, labType, 
             CAST(labSpend AS DECIMAL(12,2)) as labSpend, 
             existingLab, competitor, leadSource, referredBy, ownerKey, origin, createdAt 
      FROM schools
    `);
    
    const [contacts] = await pool.query('SELECT * FROM contacts');
    
    const [opportunities] = await pool.query(`
      SELECT id, schoolId, offering, variant, ownerKey, coOwners, 
             CAST(initialPotential AS DECIMAL(12,2)) as initialPotential, 
             CAST(studentCount AS SIGNED) as studentCount,
             currentNeed, decisionMaker, expectedClosure, 
             CAST(probability AS SIGNED) as probability, 
             stage, status, 
             CAST(closedValue AS DECIMAL(12,2)) as closedValue, 
             CAST(finalValue AS DECIMAL(12,2)) as finalValue, 
             lossReason, closedAt, origin, createdAt 
      FROM opportunities
    `);
    
    const [connects] = await pool.query(`
      SELECT id, schoolId, opportunityId, \`by\`, kind, mode, contactId, 
             response, interest, blocker, blockerDetail, commercial, 
             nextAction, nextActionOwner, nextActionAt, stage, 
             CAST(expectedValue AS DECIMAL(12,2)) as expectedValue, 
             CAST(probability AS SIGNED) as probability, 
             expectedClosure, notes, remarks, at, origin 
      FROM connects
    `);

    const [users] = await pool.query('SELECT * FROM users');
    
    // Fetch pricing targets from the database
    const [pricingTargets] = await pool.query('SELECT * FROM pricing_targets');

    // Map strings to actual numbers for safety in JS calculations
    const parseNum = (val) => val === null ? null : Number(val);

    const formattedSchools = schools.map(s => ({ ...s, students: parseNum(s.students), labSpend: parseNum(s.labSpend) }));
    const formattedOpps = opportunities.map(o => ({ 
      ...o, 
      initialPotential: parseNum(o.initialPotential), 
      closedValue: parseNum(o.closedValue), 
      finalValue: parseNum(o.finalValue),
      probability: parseNum(o.probability)
    }));
    const formattedConnects = connects.map(c => ({ 
      ...c, 
      expectedValue: parseNum(c.expectedValue),
      probability: parseNum(c.probability)
    }));

    res.json({ 
      version: 2, 
      schools: formattedSchools, 
      contacts, 
      opportunities: formattedOpps, 
      connects: formattedConnects, 
      users,
      pricingTargets 
    });
  } catch (err) {
    console.error('Database read error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Authentication route for verifying user PIN / Login
app.post('/api/login', async (req, res) => {
  const { id, pin } = req.body;
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ? AND pin = ?', [id, pin]);
    if (rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid user ID or PIN' });
    }
    res.json({ success: true, user: rows[0] });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Unified sync route handling changes and state persistence from frontend commits
app.post('/api/sync', async (req, res) => {
  const { change } = req.body;

  if (!change) {
    return res.status(400).json({ error: 'Invalid payload: missing change object' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    if (change.type === 'connect' && change.connect) {
      const c = change.connect;
      
      // Safeguard: ensure parent school exists
      if (c.schoolId) {
        await connection.query(
          `INSERT INTO schools (id, name, origin, createdAt) 
           VALUES (?, ?, 'app', NOW())
           ON DUPLICATE KEY UPDATE id = id`,
          [c.schoolId, `Auto-created School (${c.schoolId})`]
        );
      }

      await connection.query(
        `INSERT INTO connects (id, schoolId, opportunityId, \`by\`, kind, mode, contactId, response, interest, blocker, blockerDetail, nextAction, nextActionOwner, nextActionAt, stage, expectedValue, probability, expectedClosure, notes, remarks, at, origin) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE notes=VALUES(notes), stage=VALUES(stage), expectedValue=VALUES(expectedValue)`,
        [c.id, c.schoolId, c.opportunityId, c.by, c.kind, c.mode, c.contactId, c.response, c.interest, c.blocker, c.blockerDetail, c.nextAction, c.nextActionOwner, c.nextActionAt, c.stage, c.expectedValue, c.probability, c.expectedClosure, c.notes, c.remarks, c.at, c.origin]
      );

      if (change.opportunity) {
        const o = change.opportunity;
        await connection.query(
          `INSERT INTO opportunities (id, schoolId, offering, variant, ownerKey, initialPotential, studentCount, currentNeed, decisionMaker, expectedClosure, probability, stage, status, closedValue, lossReason, closedAt, origin, createdAt) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE status=VALUES(status), stage=VALUES(stage), studentCount=VALUES(studentCount), initialPotential=VALUES(initialPotential), closedValue=VALUES(closedValue), lossReason=VALUES(lossReason), closedAt=VALUES(closedAt), probability=VALUES(probability), expectedClosure=VALUES(expectedClosure)`,
          [o.id, o.schoolId, o.offering, o.variant, o.ownerKey, o.initialPotential, o.studentCount, o.currentNeed, o.decisionMaker, o.expectedClosure, o.probability, o.stage, o.status, o.closedValue, o.lossReason, o.closedAt, o.origin, o.createdAt]
        );
      }
    }
    else if (change.type === 'school_add' && change.school) {
      const s = change.school;
      await connection.query(
        `INSERT INTO schools (id, name, location, region, cluster, board, students, stemLab, labType, labSpend, existingLab, competitor, leadSource, referredBy, ownerKey, origin, createdAt) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name=VALUES(name), location=VALUES(location), region=VALUES(region)`,
        [s.id, s.name, s.location, s.region, s.cluster, s.board, s.students, s.stemLab, s.labType, s.labSpend, s.existingLab, s.competitor, s.leadSource, s.referredBy, s.ownerKey, s.origin, s.createdAt]
      );
    }
    else if (change.type === 'contact_add' && change.contact) {
      const co = change.contact;
      
      // Safeguard: ensure parent school exists
      if (co.schoolId) {
        await connection.query(
          `INSERT INTO schools (id, name, origin, createdAt) 
           VALUES (?, ?, 'app', NOW())
           ON DUPLICATE KEY UPDATE id = id`,
          [co.schoolId, `Auto-created School (${co.schoolId})`]
        );
      }

      await connection.query(
        `INSERT INTO contacts (id, schoolId, name, role, phone, email) 
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name=VALUES(name), role=VALUES(role), phone=VALUES(phone), email=VALUES(email)`,
        [co.id, co.schoolId, co.name, co.role, co.phone, co.email]
      );
    }
    else if (change.type === 'opportunity_add' && change.opportunity) {
      const o = change.opportunity;
      
      // Safeguard: ensure parent school exists to prevent foreign key errors
      if (o.schoolId) {
        await connection.query(
          `INSERT INTO schools (id, name, origin, createdAt) 
           VALUES (?, ?, 'app', NOW())
           ON DUPLICATE KEY UPDATE id = id`,
          [o.schoolId, `Auto-created School (${o.schoolId})`]
        );
      }

      await connection.query(
        `INSERT INTO opportunities (id, schoolId, offering, variant, ownerKey, initialPotential, currentNeed, decisionMaker, expectedClosure, probability, stage, status, closedValue, lossReason, closedAt, origin, createdAt) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status=VALUES(status), stage=VALUES(stage), initialPotential=VALUES(initialPotential)`,
        [o.id, o.schoolId, o.offening || o.offering, o.variant, o.ownerKey, o.initialPotential, o.currentNeed, o.decisionMaker, o.expectedClosure, o.probability, o.stage, o.status, o.closedValue, o.lossReason, o.closedAt, o.origin, o.createdAt]
      );
    }
    else if (change.type === 'user' && change.user) {
      const u = change.user;
      await connection.query(
        `INSERT INTO users (id, name, role, ownerKey, designation, region, email, pin, origin) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name=VALUES(name), role=VALUES(role), region=VALUES(region), pin=VALUES(pin)`,
        [u.id, u.name, u.role, u.ownerKey, u.designation, u.region, u.email, u.pin, u.origin]
      );
    }
    else if (change.type === 'user_delete' && change.userId) {
      await connection.query(
        `DELETE FROM users WHERE id = ?`,
        [change.userId]
      );
    }
    else if (change.type === 'pricing_target' && change.item) {
      const p = change.item;
      await connection.query(
        `INSERT INTO pricing_targets (id, category, label, offering, activity, mrp, sp, baseStudents, ownerKey, targetCount, isOneTime) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE 
           label=VALUES(label), mrp=VALUES(mrp), sp=VALUES(sp), 
           baseStudents=VALUES(baseStudents), targetCount=VALUES(targetCount)`,
        [p.id, p.category || 'offering', p.label, p.offering, p.activity, p.mrp || 0, p.sp || 0, p.baseStudents, p.ownerKey, p.targetCount || 0, p.isOneTime ? 1 : 0]
      );
    }
    else if (change.type === 'pricing_target_delete' && change.itemId) {
      await connection.query('DELETE FROM pricing_targets WHERE id = ?', [change.itemId]);
    }

    await connection.commit();
    connection.release();
    res.json({ success: true, message: 'Sync completed successfully' });
  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error('Sync transaction error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 4. Bulk import of the "Potential deals" sheet from the Business export.
//    Updates existing schools / opportunities and adds new ones. Blank cells in
//    the sheet never overwrite what is already stored.
const cleanStr = (v) => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
};
const cleanNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const lc = (v) => String(v || '').trim().toLowerCase();
const newId = (prefix) => `${prefix}-${crypto.randomBytes(5).toString('hex')}`;

app.post('/api/import/potential-deals', async (req, res) => {
  const { rows, userId, pin } = req.body || {};

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'No rows to import.' });
  }

  const connection = await pool.getConnection();
  try {
    // Only the CEO / Outsight may import (same people who see these controls).
    const [auth] = await connection.query(
      `SELECT id FROM users WHERE id = ? AND pin = ? AND role IN ('ceo', 'outsight')`,
      [userId, pin]
    );
    if (auth.length === 0) {
      connection.release();
      return res.status(403).json({ error: 'Only the CEO or Outsight can import data.' });
    }

    await connection.beginTransaction();

    // Preload so a few hundred rows do not mean a few thousand queries.
    const [users] = await connection.query('SELECT name, ownerKey FROM users');
    const ownerByName = new Map();
    users.forEach((u) => {
      ownerByName.set(lc(u.name), u.ownerKey);
      ownerByName.set(lc(u.ownerKey), u.ownerKey);
      ownerByName.set(lc(u.name).split(/\s+/)[0], ownerByName.get(lc(u.name).split(/\s+/)[0]) || u.ownerKey);
    });

    const [schoolRows] = await connection.query('SELECT id, name, location FROM schools');
    const schoolByKey = new Map();   // name|location -> id
    const schoolByName = new Map();  // name -> id (first)
    schoolRows.forEach((s) => {
      schoolByKey.set(`${lc(s.name)}|${lc(s.location)}`, s.id);
      if (!schoolByName.has(lc(s.name))) schoolByName.set(lc(s.name), s.id);
    });

    const [oppRows] = await connection.query('SELECT id, schoolId, offering, variant FROM opportunities');
    const oppByKey = new Map();      // schoolId|offering|variant -> id
    oppRows.forEach((o) => oppByKey.set(`${o.schoolId}|${lc(o.offering)}|${lc(o.variant)}`, o.id));

    // The sheet mixes casing (BAGLESS / Bagless, CONNECTED / Connected), so snap
    // values to the spelling already used in the database.
    const canon = (list) => {
      const m = new Map();
      list.forEach((v) => { if (v && !m.has(lc(v))) m.set(lc(v), v); });
      return (v) => (v ? (m.get(lc(v)) || v) : v);
    };
    const [distinct] = await connection.query('SELECT DISTINCT offering, stage FROM opportunities');
    const canonOffering = canon(distinct.map((d) => d.offering));
    const canonStage = canon(distinct.map((d) => d.stage).concat(
      ['New School', 'Connected', 'Meeting', 'Proposal', 'Closing / Negotiations', 'Lost']));
    // "CLOSED" does not say won or lost, so it is ignored rather than guessed.
    const STATUSES = { 'open': 'Open', 'won': 'Won', 'lost': 'Lost', 'on hold': 'On Hold' };

    const stats = { rows: 0, schoolsCreated: 0, schoolsUpdated: 0, dealsCreated: 0, dealsUpdated: 0, skipped: 0 };

    for (const r of rows) {
      const name = cleanStr(r.school);
      if (!name) { stats.skipped++; continue; }

      const location = cleanStr(r.location);
      const students = cleanNum(r.students);
      const ownerKey = ownerByName.get(lc(r.owner)) || null;

      // ---- school: match on name + location, falling back to name alone
      let schoolId = schoolByKey.get(`${lc(name)}|${lc(location)}`) ||
                     (!location ? schoolByName.get(lc(name)) : null);

      if (schoolId) {
        await connection.query(
          `UPDATE schools SET
             location = COALESCE(?, location), region = COALESCE(?, region),
             board = COALESCE(?, board), students = COALESCE(?, students),
             existingLab = COALESCE(?, existingLab), competitor = COALESCE(?, competitor),
             leadSource = COALESCE(?, leadSource), ownerKey = COALESCE(?, ownerKey)
           WHERE id = ?`,
          [location, cleanStr(r.region), cleanStr(r.schoolType), students,
           cleanStr(r.existingLab), cleanStr(r.competitor), cleanStr(r.leadSource), ownerKey, schoolId]
        );
        stats.schoolsUpdated++;
      } else {
        schoolId = newId('SCH');
        await connection.query(
          `INSERT INTO schools (id, name, location, region, board, students, existingLab, competitor, leadSource, ownerKey, origin, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'app', CURDATE())`,
          [schoolId, name, location, cleanStr(r.region) || 'Central', cleanStr(r.schoolType), students,
           cleanStr(r.existingLab) || "Don't Know", cleanStr(r.competitor) || 'None', cleanStr(r.leadSource), ownerKey]
        );
        schoolByKey.set(`${lc(name)}|${lc(location)}`, schoolId);
        if (!schoolByName.has(lc(name))) schoolByName.set(lc(name), schoolId);
        stats.schoolsCreated++;
      }

      // ---- potential deal: only rows that actually name an offering
      const offering = canonOffering(cleanStr(r.offering));
      if (!offering) { stats.rows++; continue; }

      const variant = cleanStr(r.variant);
      const oppKey = `${schoolId}|${lc(offering)}|${lc(variant)}`;
      const oppId = oppByKey.get(oppKey);

      const initialPotential = cleanNum(r.initialPotential);
      const closedValue = cleanNum(r.closed);
      const stage = canonStage(cleanStr(r.stage));
      const status = STATUSES[lc(r.status)] || null;
      const lossReason = cleanStr(r.lossReason);

      if (oppId) {
        await connection.query(
          `UPDATE opportunities SET
             ownerKey = COALESCE(?, ownerKey), initialPotential = COALESCE(?, initialPotential),
             studentCount = COALESCE(?, studentCount), stage = COALESCE(?, stage),
             status = COALESCE(?, status), closedValue = COALESCE(?, closedValue),
             lossReason = COALESCE(?, lossReason)
           WHERE id = ?`,
          [ownerKey, initialPotential, students, stage, status, closedValue, lossReason, oppId]
        );
        stats.dealsUpdated++;
      } else {
        const id = newId('OPP');
        await connection.query(
          `INSERT INTO opportunities (id, schoolId, offering, variant, ownerKey, initialPotential, studentCount, stage, status, closedValue, lossReason, origin, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'app', CURDATE())`,
          [id, schoolId, offering, variant, ownerKey, initialPotential, students, stage, status || 'Open', closedValue, lossReason]
        );
        oppByKey.set(oppKey, id);
        stats.dealsCreated++;
      }
      stats.rows++;
    }

    await connection.commit();
    connection.release();
    res.json({ success: true, count: stats.rows, ...stats });
  } catch (err) {
    await connection.rollback().catch(() => {});
    connection.release();
    console.error('Potential deals import error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Robobox CRM Server running on port ${PORT}`);
});