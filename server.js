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

      CREATE TABLE IF NOT EXISTS question_attempts (
        id SERIAL PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        candidate_name TEXT NOT NULL,
        question_text TEXT NOT NULL,
        topic TEXT NOT NULL,
        options JSONB NOT NULL,
        correct_answer_index INTEGER NOT NULL,
        correct_answer_text TEXT NOT NULL,
        user_answer_index INTEGER,
        user_answer_text TEXT,
        is_correct BOOLEAN NOT NULL,
        is_unattempted BOOLEAN NOT NULL DEFAULT false,
        submitted_at TIMESTAMP DEFAULT NOW()
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
// SSE
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
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════
// SSE ENDPOINT
// ═══════════════════════════════════════
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  res.write('event: connected\ndata: {"status":"ok"}\n\n');
  sseClients.add(res);
  console.log(`SSE client connected. Total: ${sseClients.size}`);
  const heartbeat = setInterval(() => {
    try { res.write(':heartbeat\n\n'); } catch (e) { clearInterval(heartbeat); }
  }, 25000);
  req.on('close', () => {
    sseClients.delete(res);
    clearInterval(heartbeat);
  });
});

// ═══════════════════════════════════════
// CANDIDATES API
// ═══════════════════════════════════════
app.get('/api/candidates', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM candidates ORDER BY created_at ASC');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/candidates', async (req, res) => {
  const { id, name, pass, status, score, result, qAnswered } = req.body;
  try {
    await pool.query(`
      INSERT INTO candidates (id, name, pass, status, score, result, q_answered)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (id) DO UPDATE SET
        name=EXCLUDED.name, pass=EXCLUDED.pass, status=EXCLUDED.status,
        score=EXCLUDED.score, result=EXCLUDED.result, q_answered=EXCLUDED.q_answered
    `, [id, name, pass, status||'pending', score??null,
        result ? JSON.stringify(result) : null, qAnswered||0]);
    const updated = await pool.query('SELECT * FROM candidates ORDER BY created_at ASC');
    broadcast('candidates_updated', updated.rows);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/candidates/bulk', async (req, res) => {
  const { candidates } = req.body;
  if (!Array.isArray(candidates) || !candidates.length)
    return res.status(400).json({ error: 'No candidates' });
  try {
    for (const c of candidates) {
      await pool.query(`
        INSERT INTO candidates (id,name,pass,status,score,result,q_answered)
        VALUES ($1,$2,$3,'pending',NULL,NULL,0) ON CONFLICT (id) DO NOTHING
      `, [c.id, c.name, c.pass]);
    }
    const updated = await pool.query('SELECT * FROM candidates ORDER BY created_at ASC');
    broadcast('candidates_updated', updated.rows);
    res.json({ success: true, added: candidates.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/candidates/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM candidates WHERE id=$1', [req.params.id]);
    await pool.query('DELETE FROM question_attempts WHERE candidate_id=$1', [req.params.id]);
    const updated = await pool.query('SELECT * FROM candidates ORDER BY created_at ASC');
    broadcast('candidates_updated', updated.rows);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/candidates', async (req, res) => {
  try {
    await pool.query('DELETE FROM candidates');
    await pool.query('DELETE FROM question_attempts');
    broadcast('candidates_updated', []);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════
// RESULTS API
// ═══════════════════════════════════════
app.get('/api/results', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM results ORDER BY submitted_at DESC');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/results', async (req, res) => {
  const { id, name, score, correct, wrong, unattempted, timeTaken, terminated } = req.body;
  try {
    await pool.query(`
      INSERT INTO results (id,name,score,correct,wrong,unattempted,time_taken,terminated)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id) DO UPDATE SET
        score=EXCLUDED.score, correct=EXCLUDED.correct, wrong=EXCLUDED.wrong,
        unattempted=EXCLUDED.unattempted, time_taken=EXCLUDED.time_taken,
        terminated=EXCLUDED.terminated, submitted_at=NOW()
    `, [id, name, score, correct, wrong, unattempted, timeTaken, terminated||false]);
    const updated = await pool.query('SELECT * FROM results ORDER BY submitted_at DESC');
    broadcast('results_updated', updated.rows);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/results', async (req, res) => {
  try {
    await pool.query('DELETE FROM results');
    await pool.query('DELETE FROM question_attempts');
    broadcast('results_updated', []);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════
// QUESTION ATTEMPTS API
// ═══════════════════════════════════════

// Save all attempts on submit
app.post('/api/attempts', async (req, res) => {
  const { candidateId, candidateName, attempts } = req.body;
  if (!candidateId || !Array.isArray(attempts))
    return res.status(400).json({ error: 'Invalid data' });
  try {
    await pool.query('DELETE FROM question_attempts WHERE candidate_id=$1', [candidateId]);
    for (const a of attempts) {
      await pool.query(`
        INSERT INTO question_attempts
          (candidate_id, candidate_name, question_text, topic, options,
           correct_answer_index, correct_answer_text,
           user_answer_index, user_answer_text, is_correct, is_unattempted)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `, [
        candidateId, candidateName,
        a.questionText, a.topic,
        JSON.stringify(a.options),
        a.correctAnswerIndex, a.correctAnswerText,
        a.userAnswerIndex ?? null, a.userAnswerText ?? null,
        a.isCorrect, a.isUnattempted,
      ]);
    }
    // Broadcast to admin that new attempt detail is available
    broadcast('attempt_saved', { candidateId, candidateName, total: attempts.length });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// GET all attempts for a candidate
app.get('/api/attempts/:candidateId', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM question_attempts WHERE candidate_id=$1 ORDER BY id ASC',
      [req.params.candidateId]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET only wrong attempts for a candidate
app.get('/api/attempts/:candidateId/wrong', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM question_attempts
       WHERE candidate_id=$1 AND is_correct=false AND is_unattempted=false
       ORDER BY topic ASC, id ASC`,
      [req.params.candidateId]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════
// TEST CONFIG API
// ═══════════════════════════════════════
app.get('/api/config', async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM test_config WHERE id='main'");
    res.json(r.rows[0] || { duration: 60, q_count: 30, difficulty: 'hard' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/config', async (req, res) => {
  const { duration, qCount, difficulty } = req.body;
  try {
    await pool.query(
      "UPDATE test_config SET duration=$1, q_count=$2, difficulty=$3 WHERE id='main'",
      [duration, qCount, difficulty]
    );
    broadcast('config_updated', { duration, q_count: qCount, difficulty });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════
// INCIDENTS API
// ═══════════════════════════════════════
app.get('/api/incidents', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM incidents ORDER BY created_at DESC LIMIT 100');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/incidents', async (req, res) => {
  const { candidateId, candidateName, reason, time } = req.body;
  try {
    await pool.query(
      'INSERT INTO incidents (candidate_id,candidate_name,reason,happened_at) VALUES ($1,$2,$3,$4)',
      [candidateId, candidateName, reason, time]
    );
    broadcast('incident_logged', { candidateId, candidateName, reason, time });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════
// HEALTH
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
  .then(() => app.listen(PORT, () => console.log(`🚀 NexusAssess running on port ${PORT}`)))
  .catch(err => {
    console.error('DB init failed:', err);
    app.listen(PORT, () => console.log(`🚀 NexusAssess running on port ${PORT} (no DB)`));
  });
