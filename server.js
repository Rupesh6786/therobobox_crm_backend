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

// 4. Bulk import of the Business export workbook.
//    The browser reads the .xlsx and posts two sheets:
//      - "Potential deals"  -> schools + opportunities
//      - "Connects"         -> connects (+ contacts named in them)
//    Existing records are matched and updated, new ones are added, and blank
//    cells never overwrite stored values. The users and pricing_targets tables
//    are never touched. Everything runs in ONE transaction: if anything fails,
//    nothing is saved.
//    Optional `mirror: true` also deletes opportunities / connects that are not
//    in the file (schools, contacts, users and pricing targets are always kept).
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
const cleanDate = (v) => {
  const t = cleanStr(v);
  return t && /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
};
const cleanTime = (v) => {
  const t = cleanStr(v);
  const m = t && t.match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
};
// lower-case, straight apostrophes, collapsed spaces: "DON’T  KNOW" == "don't know"
const lc = (v) => String(v || '').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
const newId = (prefix) => `${prefix}-${crypto.randomBytes(5).toString('hex')}`;

// Edit distance, only used to forgive one-letter typos in names ("AYIUSH" -> "AYUSH").
const lev = (a, b) => {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
};

// The sheet mixes casing (BAGLESS / Bagless). Snap each value to one spelling:
// the one already in the database, preferring a non-ALL-CAPS variant.
const makeCanon = (lists, trusted) => {
  const best = new Map();
  lists.flat().forEach((v) => {
    const s = cleanStr(v);
    if (!s) return;
    const k = lc(s);
    const cur = best.get(k);
    const isUpper = s === s.toUpperCase() && s !== s.toLowerCase();
    if (!cur || (cur === cur.toUpperCase() && !isUpper)) best.set(k, s);
  });
  // `trusted` (optional): known-good spellings that one-letter typos snap to.
  const known = new Map();
  (trusted || []).flat().forEach((v) => { const s = cleanStr(v); if (s && !known.has(lc(s))) known.set(lc(s), s); });
  return (v) => {
    const s = cleanStr(v);
    if (!s) return null;
    const k = lc(s);
    if (known.has(k)) return known.get(k);
    if (k.length >= 4) {
      for (const [kk, kv] of known) if (kk.length >= 4 && lev(k, kk) <= 1) return kv;
    }
    return best.get(k) || s;
  };
};

async function runBusinessImport(connection, { deals = [], connects = [], mirror = false }) {
  const stats = {
    dealRows: 0, schoolsCreated: 0, schoolsUpdated: 0, dealsCreated: 0, dealsUpdated: 0,
    connectRows: 0, connectsCreated: 0, connectsUpdated: 0, contactsCreated: 0, skipped: 0,
    dealsRemoved: 0, connectsRemoved: 0
  };
  const unknownOwners = new Set();
  const unknownSalespeople = new Set();

  /* ---------- people: read-only lookup, the users table is never written */
  const [users] = await connection.query('SELECT id, name, ownerKey FROM users');
  const peopleMap = new Map();
  const addPerson = (k, u) => { if (k && !peopleMap.has(k)) peopleMap.set(k, u); };
  users.forEach((u) => { addPerson(lc(u.name), u); addPerson(lc(u.ownerKey), u); addPerson(lc(u.id), u); });
  users.forEach((u) => addPerson(lc(u.name).split(' ')[0], u)); // first names last, so full names win
  const findPerson = (v) => {
    const k = lc(v);
    if (!k) return null;
    if (peopleMap.has(k)) return peopleMap.get(k);
    if (k.length >= 4) for (const [pk, pu] of peopleMap) if (pk.length >= 4 && lev(k, pk) <= 1) return pu;
    return null;
  };

  /* ---------- preload, so a few hundred rows do not mean thousands of queries */
  const [schoolRows] = await connection.query('SELECT id, name, location, region FROM schools');
  const schoolByKey = new Map();   // name|location -> id
  const schoolsByName = new Map(); // name -> [{ id, region }]
  const rememberSchool = (s) => {
    schoolByKey.set(`${lc(s.name)}|${lc(s.location)}`, s.id);
    if (!schoolsByName.has(lc(s.name))) schoolsByName.set(lc(s.name), []);
    schoolsByName.get(lc(s.name)).push({ id: s.id, region: lc(s.region) });
  };
  schoolRows.forEach(rememberSchool);

  const [oppRows] = await connection.query('SELECT id, schoolId, offering, variant FROM opportunities');
  const oppByKey = new Map();            // schoolId|offering|variant -> id
  const oppBySchoolOffering = new Map(); // schoolId|offering -> first id
  const rememberOpp = (o) => {
    oppByKey.set(`${o.schoolId}|${lc(o.offering)}|${lc(o.variant)}`, o.id);
    const k = `${o.schoolId}|${lc(o.offering)}`;
    if (!oppBySchoolOffering.has(k)) oppBySchoolOffering.set(k, o.id);
  };
  oppRows.forEach(rememberOpp);

  const [conRows] = await connection.query('SELECT id, schoolId, name FROM contacts');
  const contactByKey = new Map(conRows.map((c) => [`${c.schoolId}|${lc(c.name)}`, c.id]));

  const [exConnects] = await connection.query(
    "SELECT id, schoolId, `by`, kind, mode, notes, DATE_FORMAT(`at`, '%Y-%m-%d') AS d FROM connects");

  const col = async (sql) => (await connection.query(sql))[0];
  const dbSchools = await col('SELECT DISTINCT existingLab, competitor, leadSource, board FROM schools');
  const dbOpps = await col('SELECT DISTINCT offering, variant, stage FROM opportunities');
  const dbCx = await col('SELECT DISTINCT mode, response, interest, blocker FROM connects');
  const pick = (rows, f) => rows.map((r) => r[f]);

  const canonExistingLab = makeCanon([pick(dbSchools, 'existingLab'), ["Don't Know", 'Competitor', 'Robobox'], pick(deals, 'existingLab')]);
  const canonCompetitor = makeCanon([pick(dbSchools, 'competitor'), ['None', 'Other'], pick(deals, 'competitor')],
    [pick(dbSchools, 'competitor'), ['None', 'Other']]);
  const canonLeadSource = makeCanon([pick(dbSchools, 'leadSource'), pick(deals, 'leadSource')]);
  const canonBoard = makeCanon([pick(dbSchools, 'board'), pick(deals, 'schoolType'), pick(connects, 'schoolType')]);
  const canonOffering = makeCanon([pick(dbOpps, 'offering'), pick(deals, 'offering'), pick(connects, 'offering')]);
  const canonVariant = makeCanon([pick(dbOpps, 'variant'), pick(deals, 'variant')]);
  const canonStage = makeCanon([pick(dbOpps, 'stage'),
    ['New School', 'Connected', 'Meeting', 'Proposal', 'Closing / Negotiations', 'Lost'], pick(deals, 'stage')]);
  const canonMode = makeCanon([pick(dbCx, 'mode'), pick(connects, 'mode')]);
  const canonResponse = makeCanon([pick(dbCx, 'response'), pick(connects, 'response')]);
  const canonInterest = makeCanon([pick(dbCx, 'interest'), ['Hot', 'Warm', 'Cool'], pick(connects, 'interest')]);
  const canonBlocker = makeCanon([pick(dbCx, 'blocker'), ['None'], pick(connects, 'blocker')]);

  // "CLOSED" does not say won or lost, so it is ignored rather than guessed.
  const STATUSES = { 'open': 'Open', 'won': 'Won', 'lost': 'Lost', 'on hold': 'On Hold' };
  const touchedOpps = new Set();
  const touchedConnects = new Set();

  /* ================================================== Potential deals sheet */
  for (const r of deals) {
    const name = cleanStr(r.school);
    if (!name) { stats.skipped++; continue; }

    const location = cleanStr(r.location);
    const students = cleanNum(r.students);
    const owner = findPerson(r.owner);
    if (!owner && cleanStr(r.owner)) unknownOwners.add(cleanStr(r.owner));
    const ownerKey = owner ? owner.ownerKey : null;
    const board = canonBoard(r.schoolType);
    const existingLab = canonExistingLab(r.existingLab);
    const competitor = canonCompetitor(r.competitor);
    const leadSource = canonLeadSource(r.leadSource);

    // school: match on name + location, falling back to name alone
    let schoolId = schoolByKey.get(`${lc(name)}|${lc(location)}`) ||
                   (!location ? (schoolsByName.get(lc(name)) || [])[0]?.id : null);

    if (schoolId) {
      await connection.query(
        `UPDATE schools SET
           location = COALESCE(?, location), region = COALESCE(?, region),
           board = COALESCE(?, board), students = COALESCE(?, students),
           existingLab = COALESCE(?, existingLab), competitor = COALESCE(?, competitor),
           leadSource = COALESCE(?, leadSource), ownerKey = COALESCE(?, ownerKey)
         WHERE id = ?`,
        [location, cleanStr(r.region), board, students, existingLab, competitor, leadSource, ownerKey, schoolId]
      );
      stats.schoolsUpdated++;
    } else {
      schoolId = newId('SCH');
      const region = cleanStr(r.region) || 'Central';
      await connection.query(
        `INSERT INTO schools (id, name, location, region, board, students, existingLab, competitor, leadSource, ownerKey, origin, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'app', CURDATE())`,
        [schoolId, name, location, region, board, students, existingLab || "Don't Know", competitor || 'None', leadSource, ownerKey]
      );
      rememberSchool({ id: schoolId, name, location, region });
      stats.schoolsCreated++;
    }

    stats.dealRows++;

    // potential deal: only rows that actually name an offering
    const offering = canonOffering(r.offering);
    if (!offering) continue;

    const variant = canonVariant(r.variant);
    const oppKey = `${schoolId}|${lc(offering)}|${lc(variant)}`;
    const oppId = oppByKey.get(oppKey);

    const initialPotential = cleanNum(r.initialPotential);
    const closedValue = cleanNum(r.closed);
    const stage = canonStage(r.stage);
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
      touchedOpps.add(oppId);
      stats.dealsUpdated++;
    } else {
      const id = newId('OPP');
      await connection.query(
        `INSERT INTO opportunities (id, schoolId, offering, variant, ownerKey, initialPotential, studentCount, stage, status, closedValue, lossReason, origin, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'app', CURDATE())`,
        [id, schoolId, offering, variant, ownerKey, initialPotential, students, stage, status || 'Open', closedValue, lossReason]
      );
      rememberOpp({ id, schoolId, offering, variant });
      touchedOpps.add(id);
      stats.dealsCreated++;
    }
  }

  /* ========================================================= Connects sheet */
  // Existing connects are matched on school + day + person + type + mode + notes.
  // Identical rows are paired off one by one, so genuine duplicates survive.
  const personKey = (raw) => { const p = findPerson(raw); return p ? p.id : lc(raw); };
  const connectKey = (schoolId, day, by, kind, mode, notes) =>
    [schoolId, day, by, lc(kind), lc(mode), lc(notes)].join('|');
  const connectQueue = new Map();
  exConnects.forEach((c) => {
    const k = connectKey(c.schoolId, c.d, personKey(c.by), c.kind, c.mode, c.notes);
    if (!connectQueue.has(k)) connectQueue.set(k, []);
    connectQueue.get(k).push(c.id);
  });

  for (const r of connects) {
    const name = cleanStr(r.school);
    const day = cleanDate(r.date);
    if (!name || !day) { stats.skipped++; continue; }

    // school: by name, preferring the one in the same region; create it if unknown
    const candidates = schoolsByName.get(lc(name)) || [];
    let schoolId = (candidates.find((c) => c.region === lc(r.region)) || candidates[0] || {}).id;
    if (!schoolId) {
      schoolId = newId('SCH');
      const region = cleanStr(r.region) || 'Central';
      await connection.query(
        `INSERT INTO schools (id, name, region, board, origin, createdAt) VALUES (?, ?, ?, ?, 'app', CURDATE())`,
        [schoolId, name, region, canonBoard(r.schoolType)]
      );
      rememberSchool({ id: schoolId, name, location: null, region });
      stats.schoolsCreated++;
    }

    const person = findPerson(r.salesperson);
    if (!person && cleanStr(r.salesperson)) unknownSalespeople.add(cleanStr(r.salesperson));
    const by = person ? person.id : null;

    const kindRaw = lc(r.type);
    const kind = kindRaw === 'new' ? 'New' : kindRaw === 'reconnect' ? 'Reconnect' : (cleanStr(r.type) || 'Reconnect');
    const mode = canonMode(r.mode);
    const response = canonResponse(r.response);
    const interest = canonInterest(r.interest);
    const blocker = canonBlocker(r.blocker);
    const notes = cleanStr(r.notes);
    const time = cleanTime(r.time) || '00:00';
    const at = `${day} ${time}:00`;
    const nextDay = cleanDate(r.nextActionDue);
    const nextActionAt = nextDay ? `${nextDay} 00:00:00` : null;

    const offering = canonOffering(r.offering);
    const opportunityId = offering ? (oppBySchoolOffering.get(`${schoolId}|${lc(offering)}`) || null) : null;

    // contact: link to the school's existing contact of that name, or add it
    let contactId = null;
    const contactName = cleanStr(r.contact);
    if (contactName) {
      const ck = `${schoolId}|${lc(contactName)}`;
      contactId = contactByKey.get(ck) || null;
      if (!contactId) {
        contactId = newId('CON');
        await connection.query('INSERT INTO contacts (id, schoolId, name) VALUES (?, ?, ?)', [contactId, schoolId, contactName]);
        contactByKey.set(ck, contactId);
        stats.contactsCreated++;
      }
    }

    const quoted = cleanNum(r.quoted), negotiated = cleanNum(r.negotiated);
    const commercial = (quoted != null || negotiated != null)
      ? JSON.stringify({ quoted, negotiated }) : null;

    const queue = connectQueue.get(connectKey(schoolId, day, personKey(r.salesperson), kind, mode, notes));
    const existingId = queue && queue.length ? queue.shift() : null;

    if (existingId) {
      await connection.query(
        `UPDATE connects SET
           opportunityId = COALESCE(?, opportunityId), \`by\` = COALESCE(?, \`by\`),
           mode = COALESCE(?, mode), contactId = COALESCE(?, contactId),
           response = COALESCE(?, response), interest = COALESCE(?, interest),
           blocker = COALESCE(?, blocker), blockerDetail = COALESCE(?, blockerDetail),
           commercial = COALESCE(?, commercial), nextAction = COALESCE(?, nextAction),
           nextActionAt = COALESCE(?, nextActionAt), notes = COALESCE(?, notes)
         WHERE id = ?`,
        [opportunityId, by, mode, contactId, response, interest, blocker, cleanStr(r.blockerDetail),
         commercial, cleanStr(r.nextStep), nextActionAt, notes, existingId]
      );
      touchedConnects.add(existingId);
      stats.connectsUpdated++;
    } else {
      const id = newId('CNX');
      await connection.query(
        `INSERT INTO connects (id, schoolId, opportunityId, \`by\`, kind, mode, contactId, response, interest,
                               blocker, blockerDetail, commercial, nextAction, nextActionAt, notes, \`at\`, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'app')`,
        [id, schoolId, opportunityId, by, kind, mode, contactId, response, interest || 'Warm',
         blocker || 'None', cleanStr(r.blockerDetail), commercial || '{}', cleanStr(r.nextStep),
         nextActionAt, notes, at]
      );
      touchedConnects.add(id);
      stats.connectsCreated++;
    }
    stats.connectRows++;
  }

  /* ============================== optional: make opportunities/connects match */
  if (mirror) {
    if (deals.length && touchedOpps.size) {
      const [d] = await connection.query('DELETE FROM opportunities WHERE id NOT IN (?)', [[...touchedOpps]]);
      stats.dealsRemoved = d.affectedRows;
      await connection.query(
        'UPDATE connects SET opportunityId = NULL WHERE opportunityId IS NOT NULL AND opportunityId NOT IN (SELECT id FROM opportunities)');
    }
    if (connects.length && touchedConnects.size) {
      const [d] = await connection.query('DELETE FROM connects WHERE id NOT IN (?)', [[...touchedConnects]]);
      stats.connectsRemoved = d.affectedRows;
    }
  }

  return { ...stats, unknownOwners: [...unknownOwners], unknownSalespeople: [...unknownSalespeople] };
}

const handleBusinessImport = async (req, res) => {
  const { rows, deals, connects, mirror, userId, pin } = req.body || {};
  const dealRows = Array.isArray(deals) ? deals : (Array.isArray(rows) ? rows : []);
  const connectRows = Array.isArray(connects) ? connects : [];

  if (!dealRows.length && !connectRows.length) {
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
    const result = await runBusinessImport(connection, {
      deals: dealRows, connects: connectRows, mirror: mirror === true
    });
    await connection.commit();
    connection.release();
    res.json({ success: true, count: result.dealRows + result.connectRows, ...result });
  } catch (err) {
    await connection.rollback().catch(() => {});
    connection.release();
    console.error('Business import error:', err);
    res.status(500).json({ error: err.message });
  }
};

app.post('/api/import/business-export', handleBusinessImport);
// Old endpoint kept so older cached front-ends keep working.
app.post('/api/import/potential-deals', handleBusinessImport);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Robobox CRM Server running on port ${PORT}`);
});