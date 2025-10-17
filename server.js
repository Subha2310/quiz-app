// ===== server.js =====
const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 5002;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ===== HOME =====
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ===== LOGIN =====
app.post("/api/login", async (req, res) => {
  const { id, name } = req.body;
  if (!id || !name) return res.status(400).json({ success: false, error: "ID and Name required" });

  try {
    const existing = await pool.query("SELECT * FROM participants WHERE id=$1", [id]);
    if (existing.rows.length > 0) {
      const user = existing.rows[0];
      if (["completed", "disqualified"].includes(user.status)) {
        return res.status(400).json({ success: false, error: "Already completed/disqualified" });
      }
      return res.json({ success: true, participant: user });
    }

    const result = await pool.query(
      "INSERT INTO participants (id, username, status, score, created_at) VALUES ($1, $2, 'active', 0, NOW()) RETURNING *",
      [id, name]
    );
    res.json({ success: true, participant: result.rows[0] });
  } catch (err) {
    console.error("Login DB error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// ===== CHECK PARTICIPANT =====
app.get("/api/check-participant/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, status FROM participants WHERE id=$1", [req.params.id]);
    if (result.rows.length === 0) return res.json({ exists: false });
    res.json({ exists: true, status: result.rows[0].status });
  } catch (err) {
    console.error("Check participant error:", err);
    res.status(500).json({ exists: false, error: "Server error" });
  }
});

// ===== FETCH QUESTIONS (ROUND 1 & 2) =====
app.get("/api/questions", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, question, options FROM questions ORDER BY id");
    const questions = result.rows.map(q => ({
      id: q.id,
      question: q.question,
      options: Array.isArray(q.options) ? [...q.options].sort(() => Math.random() - 0.5) : JSON.parse(q.options),
    }));
    res.json(questions);
  } catch (err) {
    console.error("Fetch questions error:", err);
    res.status(500).json({ error: "Failed to fetch questions" });
  }
});


// ===== SCORE CALCULATION =====
const calculateScore = async (participantId, answers, status) => {
  try {
    await pool.query(
      `
      UPDATE participants p
      SET score = sub.correct_count,
          status = $3,
          answers = $2::jsonb,
          submitted_at = NOW()
      FROM (
        SELECT p.id, COUNT(*) AS correct_count
        FROM participants p
        CROSS JOIN LATERAL jsonb_each_text($2::jsonb) AS a(qid, ans)
        JOIN correct_answers c 
          ON c.question_id = a.qid::int 
          AND LOWER(TRIM(a.ans)) = LOWER(TRIM(c.answer))
        WHERE p.id = $1
        GROUP BY p.id
      ) AS sub
      WHERE p.id = $1;
      `,
      [participantId, answers, status]
    );
  } catch (err) {
    console.error("Score calculation error:", err);
    throw err;
  }
};

// ===== SUBMIT QUIZ =====
app.post("/api/submit", async (req, res) => {
  const { participantId, answers, status } = req.body;
  if (!participantId || !answers || !status)
    return res.status(400).json({ success: false, error: "Invalid request" });

  try {
    const userCheck = await pool.query("SELECT * FROM participants WHERE id=$1 AND status='active'", [participantId]);
    if (!userCheck.rows.length) return res.status(400).json({ success: false, error: "Already submitted or disqualified" });

    await calculateScore(participantId, answers, status);

    const result = await pool.query("SELECT score, created_at, submitted_at FROM participants WHERE id=$1", [participantId]);
    res.json({ success: true, score: result.rows[0].score, created_at: result.rows[0].created_at, submitted_at: result.rows[0].submitted_at });
  } catch (err) {
    console.error("Submit quiz error:", err);
    res.status(500).json({ success: false, error: "Submission failed" });
  }
});

// ===== DISQUALIFY =====
app.post("/api/disqualify", async (req, res) => {
  const { participantId } = req.body;
  if (!participantId) return res.status(400).json({ success: false, error: "Missing participantId" });

  try {
    const result = await pool.query(
      "UPDATE participants SET status='disqualified', submitted_at=NOW() WHERE id=$1 AND status='active' RETURNING *",
      [participantId]
    );

    if (!result.rows.length) return res.json({ success: false, message: "Already submitted/disqualified" });
    res.json({ success: true, message: "Disqualified" });
  } catch (err) {
    console.error("Disqualify error:", err);
    res.status(500).json({ success: false, error: "Disqualification failed" });
  }
});

// ===== ADMIN DASHBOARD =====
app.get("/api/participants", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, username, status, score, submitted_at, created_at FROM participants ORDER BY submitted_at DESC NULLS LAST, id ASC");
    res.json(result.rows);
  } catch (err) {
    console.error("Fetch participants error:", err);
    res.status(500).json({ error: "Failed to fetch participants" });
  }
});

app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
