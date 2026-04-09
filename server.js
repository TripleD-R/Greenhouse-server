const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(express.json());
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// ==========================
// ПОДКЛЮЧЕНИЕ К БД
// ==========================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pool.connect()
    .then(() => console.log("DB connected"))
    .catch(err => console.error("DB error:", err));

// ==========================
// СОСТОЯНИЕ СЕРВЕРА
// ==========================

// Текущая активная сессия микроконтроллера
let currentSessionId = null;
// Последние настройки (кэшируются)
let cachedSettings = null;
// Последние 20 значений текущей сессии (в памяти для скорости)
let currentSessionData = [];

// ==========================
// SOCKET.IO — КЛИЕНТЫ И МИКРОКОНТРОЛЛЕР
// ==========================

io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    // --- Микроконтроллер отправляет данные ---
    socket.on("esp_data", async (data) => {
        // Помечаем сокет как ESP
        socket.isESP = true;
        const { temperature, humidity, light } = data;

        // Если сессия ещё не начата — создаём
        if (!currentSessionId) {
            try {
                const res = await pool.query(
                    `INSERT INTO sessions (status, device_ip) VALUES ('active', $1) RETURNING id`,
                    [socket.handshake.address]
                );
                currentSessionId = res.rows[0].id;
                currentSessionData = [];
                console.log("New ESP session started:", currentSessionId);
            } catch (err) {
                console.error("Session create error:", err);
                return;
            }
        }

        // Сохраняем в БД
        try {
            const result = await pool.query(
                `INSERT INTO sensor_data (temperature, humidity, light, session_id)
                 VALUES ($1, $2, $3, $4) RETURNING *`,
                [temperature, humidity, light, currentSessionId]
            );
            const newData = result.rows[0];

            // Добавляем в буфер текущей сессии
            currentSessionData.push(newData);
            // Храним только последние 20
            if (currentSessionData.length > 20) {
                currentSessionData = currentSessionData.slice(-20);
            }

            // Рассылаем всем клиентам (кроме ESP)
            socket.broadcast.emit("sensor_update", newData);
        } catch (err) {
            console.error("Sensor data insert error:", err);
        }
    });

    // --- Микроконтроллер отключился ---
    socket.on("disconnect", () => {
        console.log("Client disconnected:", socket.id, "isESP:", socket.isESP);

        if (socket.isESP) {
            // Завершаем сессию
            if (currentSessionId) {
                pool.query(
                    `UPDATE sessions SET status='inactive', end_time=NOW() WHERE id=$1`,
                    [currentSessionId]
                ).catch(err => console.error("Session end error:", err));
                currentSessionId = null;
                currentSessionData = [];
                console.log("ESP session ended");
            }
        }
    });

    // --- Клиент отправляет настройки ---
    socket.on("settings_push", async (settings) => {
        const { max_temp, min_hum, min_light } = settings;

        try {
            // Обновляем настройки в БД
            const result = await pool.query(
                `UPDATE settings
                 SET max_temp=$1, min_hum=$2, min_light=$3, updated_at=NOW()
                 WHERE id=1
                 RETURNING *`,
                [max_temp, min_hum, min_light]
            );
            const updatedSettings = result.rows[0];
            cachedSettings = updatedSettings;

            // Рассылаем ВСЕМ клиентам (включая отправителя)
            io.emit("settings_update", updatedSettings);

            // Если ESP подключена — отправляем ей настройки
            io.sockets.sockets.forEach(s => {
                if (s.isESP) {
                    s.emit("esp_settings", updatedSettings);
                }
            });
        } catch (err) {
            console.error("Settings update error:", err);
            socket.emit("settings_error", { error: err.message });
        }
    });

    // --- Клиент запрашивает последние 20 значений ---
    socket.on("get_history", async (callback) => {
        try {
            // Возвращаем данные только текущей активной сессии
            if (currentSessionData.length > 0) {
                if (typeof callback === "function") {
                    callback(currentSessionData);
                }
            } else {
                if (typeof callback === "function") {
                    callback([]);
                }
            }
        } catch (err) {
            console.error("History error:", err);
            if (typeof callback === "function") callback([]);
        }
    });

    // --- Клиент запрашивает текущие настройки ---
    socket.on("get_settings", async (callback) => {
        try {
            if (cachedSettings) {
                if (typeof callback === "function") callback(cachedSettings);
            } else {
                const result = await pool.query(`SELECT * FROM settings WHERE id=1`);
                cachedSettings = result.rows[0] || null;
                if (typeof callback === "function") callback(cachedSettings);
            }
        } catch (err) {
            console.error("Get settings error:", err);
            if (typeof callback === "function") callback(null);
        }
    });
});

// ==========================
// HTTP API — для микроконтроллера и клиентов
// ==========================

// Микроконтроллер: инициализация сессии (опционально, если ESP не использует WebSocket)
app.post("/api/session/start", async (req, res) => {
    const { device_ip } = req.body;
    try {
        // Завершаем предыдущую сессию если была
        if (currentSessionId) {
            await pool.query(
                `UPDATE sessions SET status='inactive', end_time=NOW() WHERE id=$1`,
                [currentSessionId]
            );
        }

        const result = await pool.query(
            `INSERT INTO sessions (status, device_ip) VALUES ('active', $1) RETURNING id`,
            [device_ip]
        );
        currentSessionId = result.rows[0].id;
        currentSessionData = [];

        res.json({ session_id: currentSessionId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Микроконтроллер: отправка данных (HTTP fallback)
app.post("/api/data", async (req, res) => {
    const { temperature, humidity, light, session_id } = req.body;

    try {
        // Если сессия не начата — создаём
        if (!currentSessionId) {
            const sessionRes = await pool.query(
                `INSERT INTO sessions (status, device_ip) VALUES ('active', $1) RETURNING id`,
                [req.ip]
            );
            currentSessionId = sessionRes.rows[0].id;
            currentSessionData = [];
        }

        const result = await pool.query(
            `INSERT INTO sensor_data (temperature, humidity, light, session_id)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [temperature, humidity, light, currentSessionId]
        );
        const newData = result.rows[0];

        currentSessionData.push(newData);
        if (currentSessionData.length > 20) {
            currentSessionData = currentSessionData.slice(-20);
        }

        // Рассылаем клиентам через WebSocket
        io.emit("sensor_update", newData);

        res.sendStatus(200);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Клиент: получить последние 20 значений текущей сессии
app.get("/api/data", async (req, res) => {
    try {
        // Отдаём только данные текущей активной сессии
        if (currentSessionId) {
            res.json(currentSessionData);
        } else {
            res.json([]);
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Клиент: получить текущие настройки
app.get("/api/settings", async (req, res) => {
    try {
        if (cachedSettings) {
            res.json(cachedSettings);
        } else {
            const result = await pool.query(`SELECT * FROM settings WHERE id=1`);
            cachedSettings = result.rows[0] || null;
            res.json(cachedSettings);
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Клиент: отправить настройки
app.post("/api/settings", async (req, res) => {
    const { max_temp, min_hum, min_light } = req.body;

    try {
        const result = await pool.query(
            `UPDATE settings
             SET max_temp=$1, min_hum=$2, min_light=$3, updated_at=NOW()
             WHERE id=1
             RETURNING *`,
            [max_temp, min_hum, min_light]
        );
        const updatedSettings = result.rows[0];
        cachedSettings = updatedSettings;

        // Рассылаем всем клиентам через WebSocket
        io.emit("settings_update", updatedSettings);

        // Отправляем настройки ESP если подключена
        io.sockets.sockets.forEach(s => {
            if (s.isESP) {
                s.emit("esp_settings", updatedSettings);
            }
        });

        res.json(updatedSettings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Root endpoint
app.get("/", (req, res) => {
    res.send("Greenhouse Server is running (WebSocket + HTTP API)");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on port " + PORT));
