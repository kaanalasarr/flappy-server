const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'scores.json');
const useDB = !!process.env.DATABASE_URL;
let pool;

if (useDB) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  (async () => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS scores (
        id SERIAL PRIMARY KEY,
        name VARCHAR(20) NOT NULL,
        score INTEGER NOT NULL DEFAULT 0,
        difficulty VARCHAR(10) DEFAULT 'normal',
        date BIGINT,
        UNIQUE(name, difficulty)
      )`);
      await pool.query(`ALTER TABLE scores DROP CONSTRAINT IF EXISTS scores_name_key`);
      await pool.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scores_name_difficulty_key') THEN
          ALTER TABLE scores ADD CONSTRAINT scores_name_difficulty_key UNIQUE(name, difficulty);
        END IF;
      END $$`);
      console.log('DB table ready');
    } catch (e) { console.error('DB init error:', e.message); }
  })();
}

app.use(cors());
app.use(express.json());

function loadScores() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
  return [];
}
function saveScores(scores) { fs.writeFileSync(DATA_FILE, JSON.stringify(scores)); }

app.post('/api/score', async (req, res) => {
  try {
    const { name, score, difficulty } = req.body;
    if (!name || score === undefined) return res.status(400).json({ error: 'name ve score gerekli' });
    const n = String(name).slice(0, 20), s = Number(score), d = difficulty || 'normal';

    if (useDB) {
      await pool.query(
        `INSERT INTO scores (name, score, difficulty, date) VALUES ($1, $2, $3, $4)
         ON CONFLICT (name, difficulty) DO UPDATE SET score = GREATEST(scores.score, $2), date = $4`,
        [n, s, d, Date.now()]
      );
      const r = await pool.query('SELECT COUNT(*) as rank FROM scores WHERE difficulty=$1 AND score > (SELECT score FROM scores WHERE name=$2 AND difficulty=$1)', [d, n]);
      res.json({ ok: true, rank: Number(r.rows[0].rank) + 1 });
    } else {
      const scores = loadScores();
      const entry = { name: n, score: s, difficulty: d, date: Date.now() };
      const existing = scores.findIndex(x => x.name === n && x.difficulty === d);
      if (existing >= 0) { if (s > scores[existing].score) scores[existing] = entry; }
      else scores.push(entry);
      scores.sort((a, b) => b.score - a.score);
      if (scores.length > 500) scores.length = 500;
      saveScores(scores);
      const diff_scores = scores.filter(x => x.difficulty === d);
      res.json({ ok: true, rank: diff_scores.findIndex(x => x.name === n) + 1 });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const diff = req.query.difficulty;
    if (useDB) {
      let r;
      if (diff) {
        r = await pool.query('SELECT name, score, difficulty, date FROM scores WHERE difficulty=$1 ORDER BY score DESC LIMIT $2', [diff, limit]);
      } else {
        r = await pool.query('SELECT name, score, difficulty, date FROM scores ORDER BY score DESC LIMIT $1', [limit]);
      }
      res.json(r.rows);
    } else {
      let scores = loadScores();
      if (diff) scores = scores.filter(x => x.difficulty === diff);
      res.json(scores.slice(0, limit));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rank/:name', async (req, res) => {
  try {
    const diff = req.query.difficulty || 'normal';
    if (useDB) {
      const r = await pool.query('SELECT score FROM scores WHERE name=$1 AND difficulty=$2', [req.params.name, diff]);
      if (r.rows.length === 0) return res.json({ rank: 0, score: 0 });
      const cnt = await pool.query('SELECT COUNT(*) as rank FROM scores WHERE difficulty=$1 AND score > $2', [diff, r.rows[0].score]);
      res.json({ rank: Number(cnt.rows[0].rank) + 1, score: r.rows[0].score });
    } else {
      const scores = loadScores().filter(x => x.difficulty === diff);
      const idx = scores.findIndex(x => x.name === req.params.name);
      if (idx < 0) return res.json({ rank: 0, score: 0 });
      res.json({ rank: idx + 1, score: scores[idx].score });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/check-name/:name', async (req, res) => {
  try {
    const n = String(req.params.name).slice(0, 20);
    if (useDB) {
      const r = await pool.query('SELECT name FROM scores WHERE LOWER(name)=LOWER($1) LIMIT 1', [n]);
      res.json({ taken: r.rows.length > 0 });
    } else {
      const scores = loadScores();
      res.json({ taken: scores.some(x => x.name.toLowerCase() === n.toLowerCase()) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/register', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name gerekli' });
    const n = String(name).slice(0, 20);
    if (useDB) {
      const exists = await pool.query('SELECT name FROM scores WHERE LOWER(name)=LOWER($1) LIMIT 1', [n]);
      if (exists.rows.length > 0) return res.json({ ok: false, error: 'Bu isim zaten alinmis' });
      res.json({ ok: true });
    } else {
      const scores = loadScores();
      if (scores.some(x => x.name.toLowerCase() === n.toLowerCase())) return res.json({ ok: false, error: 'Bu isim zaten alinmis' });
      res.json({ ok: true });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', async (req, res) => {
  try {
    if (useDB) {
      const r = await pool.query('SELECT COUNT(DISTINCT name) as cnt FROM scores');
      res.json({ totalUsers: Number(r.rows[0].cnt) });
    } else {
      const scores = loadScores();
      const unique = new Set(scores.map(x => x.name));
      res.json({ totalUsers: unique.size });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', async (req, res) => {
  try {
    if (useDB) {
      const r = await pool.query('SELECT COUNT(*) as cnt FROM scores');
      res.json({ status: 'Flappy Bird Leaderboard Server', db: 'PostgreSQL', players: Number(r.rows[0].cnt) });
    } else {
      res.json({ status: 'Flappy Bird Leaderboard Server', db: 'JSON', players: loadScores().length });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log('Server running on port ' + PORT + ' | DB: ' + (useDB ? 'PostgreSQL' : 'JSON file')));
