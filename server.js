const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(express.json());
app.use(cors());

// ==========================
// HTTP + SOCKET.IO
// ==========================

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*"
    }
});

// ==========================
// ПОДКЛЮЧЕНИЕ К БД
// ==========================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect()
    .then(() => console.log("DB connected"))
    .catch(err => console.error("DB error:", err));

// ==========================
// SOCKET CONNECTION
// ==========================

io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    socket.on("disconnect", () => {
        console.log("Client disconnected:", socket.id);
    });
});

// ==========================
// СЕССИИ
// ==========================

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
        res.status(500).json({ error: err.message });
    }
});

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
        res.status(500).json({ error: err.message });
    }
});

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
        res.status(500).json({ error: err.message });
    }
});

// ==========================
// ДАННЫЕ СЕНСОРОВ
// ==========================

// ESP отправляет данные
app.post("/data", async (req, res) => {
    const { temperature, humidity, light, session_id } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO sensor_data (temperature, humidity, light, session_id)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [temperature, humidity, light, session_id]
        );

        const newData = result.rows[0];

        // 🔥 рассылаем всем клиентам
        io.emit("sensor_update", newData);

        res.sendStatus(200);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// история
app.get("/data/history/:session_id", async (req, res) => {
    const { session_id } = req.params;

    try {
        const result = await pool.query(
            `SELECT * FROM sensor_data
             WHERE session_id=$1
             ORDER BY created_at ASC
             LIMIT 500`,
            [session_id]
        );

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================
// НАСТРОЙКИ
// ==========================

// получить
app.get("/settings", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM settings WHERE id=1`
        );

        res.json(result.rows[0] || null);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// обновить
app.post("/settings", async (req, res) => {
    const { max_temp, min_hum, min_light } = req.body;

    try {
        const result = await pool.query(
            `UPDATE settings
             SET max_temp=$1,
                 min_hum=$2,
                 min_light=$3,
                 updated_at=NOW()
             WHERE id=1
             RETURNING *`,
            [max_temp, min_hum, min_light]
        );

        const updatedSettings = result.rows[0];

        // 🔥 рассылаем всем
        io.emit("settings_update", updatedSettings);

        res.sendStatus(200);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================

app.get("/", (req, res) => {
    res.send("Server is working with WebSocket 🚀");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on port " + PORT));