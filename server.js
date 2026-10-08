const express = require('express');
const mysql = require('mysql2/promise');
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
app.use(express.json());

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
      users 
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
      await connection.query(
        `INSERT INTO connects (id, schoolId, opportunityId, \`by\`, kind, mode, contactId, response, interest, blocker, blockerDetail, nextAction, nextActionOwner, nextActionAt, stage, expectedValue, probability, expectedClosure, notes, remarks, at, origin) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE notes=VALUES(notes), stage=VALUES(stage), expectedValue=VALUES(expectedValue)`,
        [c.id, c.schoolId, c.opportunityId, c.by, c.kind, c.mode, c.contactId, c.response, c.interest, c.blocker, c.blockerDetail, c.nextAction, c.nextActionOwner, c.nextActionAt, c.stage, c.expectedValue, c.probability, c.expectedClosure, c.notes, c.remarks, c.at, c.origin]
      );

      if (change.opportunity) {
        const o = change.opportunity;
        await connection.query(
          `INSERT INTO opportunities (id, schoolId, offering, variant, ownerKey, initialPotential, currentNeed, decisionMaker, expectedClosure, probability, stage, status, closedValue, lossReason, closedAt, origin, createdAt) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE status=VALUES(status), stage=VALUES(stage), closedValue=VALUES(closedValue), lossReason=VALUES(lossReason), closedAt=VALUES(closedAt), probability=VALUES(probability), expectedClosure=VALUES(expectedClosure)`,
          [o.id, o.schoolId, o.offering, o.variant, o.ownerKey, o.initialPotential, o.currentNeed, o.decisionMaker, o.expectedClosure, o.probability, o.stage, o.status, o.closedValue, o.lossReason, o.closedAt, o.origin, o.createdAt]
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
      await connection.query(
        `INSERT INTO contacts (id, schoolId, name, role, phone, email) 
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name=VALUES(name), role=VALUES(role), phone=VALUES(phone), email=VALUES(email)`,
        [co.id, co.schoolId, co.name, co.role, co.phone, co.email]
      );
    }
    else if (change.type === 'opportunity_add' && change.opportunity) {
      const o = change.opportunity;
      await connection.query(
        `INSERT INTO opportunities (id, schoolId, offering, variant, ownerKey, initialPotential, currentNeed, decisionMaker, expectedClosure, probability, stage, status, closedValue, lossReason, closedAt, origin, createdAt) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status=VALUES(status), stage=VALUES(stage), initialPotential=VALUES(initialPotential)`,
        [o.id, o.schoolId, o.offering, o.variant, o.ownerKey, o.initialPotential, o.currentNeed, o.decisionMaker, o.expectedClosure, o.probability, o.stage, o.status, o.closedValue, o.lossReason, o.closedAt, o.origin, o.createdAt]
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Robobox CRM Server running on port ${PORT}`);
});