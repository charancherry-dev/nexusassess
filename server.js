const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════
// DATABASE
// ═══════════════════════════════════════
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        pass TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        score INTEGER DEFAULT NULL,
        result JSONB DEFAULT NULL,
        q_answered INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS results (
        id TEXT PRIMARY KEY,
        name TEXT,
        score INTEGER,
        correct INTEGER,
        wrong INTEGER,
        unattempted INTEGER,
        time_taken TEXT,
        terminated BOOLEAN DEFAULT false,
        submitted_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS test_config (
        id TEXT PRIMARY KEY DEFAULT 'main',
        duration INTEGER DEFAULT 60,
        q_count INTEGER DEFAULT 30,
        difficulty TEXT DEFAULT 'hard'
      );

      CREATE TABLE IF NOT EXISTS incidents (
        id SERIAL PRIMARY KEY,
        candidate_id TEXT,
        candidate_name TEXT,
        reason TEXT,
        happened_at TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      INSERT INTO test_config (id, duration, q_count, difficulty)
      VALUES ('main', 60, 30, 'hard')
      ON CONFLICT (id) DO NOTHING;
    `);
    console.log('✅ Database initialized');
  } finally {
    client.release();
  }
}

// ═══════════════════════════════════════
// SSE — SERVER-SENT EVENTS
// Real-time push to all connected browsers
// ═══════════════════════════════════════
const sseClients = new Set();

function broadcast(eventName, data) {
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch (e) { sseClients.delete(client); }
  }
}

// ═══════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════
// SSE ENDPOINT — browsers subscribe here
// ═══════════════════════════════════════
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send a heartbeat so connection stays alive
  res.write('event: connected\ndata: {"status":"ok"}\n\n');

  sseClients.add(res);
  console.log(`SSE client connected. Total: ${sseClients.size}`);

  // Heartbeat every 25 seconds
  const heartbeat = setInterval(() => {
    try { res.write(':heartbeat\n\n'); } catch (e) { clearInterval(heartbeat); }
  }, 25000);

  req.on('close', () => {
    sseClients.delete(res);
    clearInterval(heartbeat);
    console.log(`SSE client disconnected. Total: ${sseClients.size}`);
  });
});

// ═══════════════════════════════════════
// CANDIDATES API
// ═══════════════════════════════════════

// GET all candidates
app.get('/api/candidates', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM candidates ORDER BY created_at ASC'
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// POST — add or update a candidate
app.post('/api/candidates', async (req, res) => {
  const { id, name, pass, status, score, result, qAnswered } = req.body;
  try {
    await pool.query(`
      INSERT INTO candidates (id, name, pass, status, score, result, q_answered)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET
        name        = EXCLUDED.name,
        pass        = EXCLUDED.pass,
        status      = EXCLUDED.status,
        score       = EXCLUDED.score,
        result      = EXCLUDED.result,
        q_answered  = EXCLUDED.q_answered
    `, [id, name, pass, status || 'pending', score || null,
        result ? JSON.stringify(result) : null, qAnswered || 0]);

    const updated = await pool.query('SELECT * FROM candidates ORDER BY created_at ASC');
    broadcast('candidates_updated', updated.rows);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// POST bulk — add many candidates at once
app.post('/api/candidates/bulk', async (req, res) => {
  const { candidates } = req.body;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return res.status(400).json({ error: 'No candidates provided' });
  }
  try {
    for (const c of candidates) {
      await pool.query(`
        INSERT INTO candidates (id, name, pass, status, score, result, q_answered)
        VALUES ($1, $2, $3, 'pending', NULL, NULL, 0)
        ON CONFLICT (id) DO NOTHING
      `, [c.id, c.name, c.pass]);
    }
    const updated = await pool.query('SELECT * FROM candidates ORDER BY created_at ASC');
    broadcast('candidates_updated', updated.rows);
    res.json({ success: true, added: candidates.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE a candidate
app.delete('/api/candidates/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM candidates WHERE id = $1', [req.params.id]);
    const updated = await pool.query('SELECT * FROM candidates ORDER BY created_at ASC');
    broadcast('candidates_updated', updated.rows);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE all candidates
app.delete('/api/candidates', async (req, res) => {
  try {
    await pool.query('DELETE FROM candidates');
    broadcast('candidates_updated', []);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════
// RESULTS API
// ═══════════════════════════════════════

// GET all results
app.get('/api/results', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM results ORDER BY submitted_at DESC'
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST — save a result
app.post('/api/results', async (req, res) => {
  const { id, name, score, correct, wrong, unattempted, timeTaken, terminated } = req.body;
  try {
    await pool.query(`
      INSERT INTO results (id, name, score, correct, wrong, unattempted, time_taken, terminated)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        score       = EXCLUDED.score,
        correct     = EXCLUDED.correct,
        wrong       = EXCLUDED.wrong,
        unattempted = EXCLUDED.unattempted,
        time_taken  = EXCLUDED.time_taken,
        terminated  = EXCLUDED.terminated,
        submitted_at = NOW()
    `, [id, name, score, correct, wrong, unattempted, timeTaken, terminated || false]);

    const updated = await pool.query('SELECT * FROM results ORDER BY submitted_at DESC');
    broadcast('results_updated', updated.rows);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE all results
app.delete('/api/results', async (req, res) => {
  try {
    await pool.query('DELETE FROM results');
    broadcast('results_updated', []);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════
// TEST CONFIG API
// ═══════════════════════════════════════

// GET config
app.get('/api/config', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM test_config WHERE id = 'main'");
    res.json(result.rows[0] || { duration: 60, q_count: 30, difficulty: 'hard' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST — save config
app.post('/api/config', async (req, res) => {
  const { duration, qCount, difficulty } = req.body;
  try {
    await pool.query(`
      UPDATE test_config
      SET duration = $1, q_count = $2, difficulty = $3
      WHERE id = 'main'
    `, [duration, qCount, difficulty]);

    const updated = { duration, q_count: qCount, difficulty };
    broadcast('config_updated', updated);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════
// INCIDENTS API
// ═══════════════════════════════════════

app.get('/api/incidents', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM incidents ORDER BY created_at DESC LIMIT 100'
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/incidents', async (req, res) => {
  const { candidateId, candidateName, reason, time } = req.body;
  try {
    await pool.query(`
      INSERT INTO incidents (candidate_id, candidate_name, reason, happened_at)
      VALUES ($1, $2, $3, $4)
    `, [candidateId, candidateName, reason, time]);

    broadcast('incident_logged', { candidateId, candidateName, reason, time });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', clients: sseClients.size, time: new Date().toISOString() });
});

// ═══════════════════════════════════════
// SERVE FRONTEND
// ═══════════════════════════════════════
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ═══════════════════════════════════════
// START
// ═══════════════════════════════════════
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 NexusAssess running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    // Start anyway without DB (for testing without PostgreSQL)
    app.listen(PORT, () => {
      console.log(`🚀 NexusAssess running on port ${PORT} (no database)`);
    });
  });
