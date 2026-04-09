const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// подключение к БД
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});


// ==========================
// СЕССИИ
// ==========================

// создать сессию (ESP при запуске)
app.post("/session/start", async (req, res) => {
    const { device_ip } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO sessions (status, device_ip)
             VALUES ('active', $1)
             RETURNING id`,
            [device_ip]
        );

        res.json({ session_id: result.rows[0].id });
    } catch (err) {
        res.status(500).send(err.message);
    }
});


// завершить сессию (ESP при выключении)
app.post("/session/end", async (req, res) => {
    const { session_id } = req.body;

    try {
        await pool.query(
            `UPDATE sessions
             SET status='inactive', end_time=NOW()
             WHERE id=$1`,
            [session_id]
        );

        res.sendStatus(200);
    } catch (err) {
        res.status(500).send(err.message);
    }
});


// получить активную сессию
app.get("/session/active", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM sessions
             WHERE status='active'
             ORDER BY start_time DESC
             LIMIT 1`
        );

        res.json(result.rows[0] || null);
    } catch (err) {
        res.status(500).send(err.message);
    }
});


// ==========================
// ДАННЫЕ СЕНСОРОВ
// ==========================

// ESP отправляет данные
app.post("/data", async (req, res) => {
    const { temperature, humidity, light, session_id } = req.body;

    try {
        await pool.query(
            `INSERT INTO sensor_data (temperature, humidity, light, session_id)
             VALUES ($1, $2, $3, $4)`,
            [temperature, humidity, light, session_id]
        );

        res.sendStatus(200);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.get("/", (req, res) => {
    res.send("Server is working");
});

// история по сессии
app.get("/data/history/:session_id", async (req, res) => {
    const { session_id } = req.params;

    try {
        const result = await pool.query(
            `SELECT * FROM sensor_data
             WHERE session_id=$1
             ORDER BY created_at ASC`,
            [session_id]
        );

        res.json(result.rows);
    } catch (err) {
        res.status(500).send(err.message);
    }
});


// ==========================
// НАСТРОЙКИ
// ==========================

// получить настройки
app.get("/settings", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM settings
             ORDER BY id DESC
             LIMIT 1`
        );

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).send(err.message);
    }
});


// обновить настройки
app.post("/settings", async (req, res) => {
    const { max_temp, min_hum, min_light } = req.body;

    try {
        await pool.query(
            `INSERT INTO settings (max_temp, min_hum, min_light)
             VALUES ($1, $2, $3)`,
            [max_temp, min_hum, min_light]
        );

        res.sendStatus(200);
    } catch (err) {
        res.status(500).send(err.message);
    }
});


// ==========================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));