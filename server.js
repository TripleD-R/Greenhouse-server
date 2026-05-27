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
    .then(async () => {
        console.log("DB connected");
        // Попытка создать индекс для ускорения операций очистки
        try {
            await pool.query("CREATE INDEX IF NOT EXISTS idx_sensor_data_created_at ON sensor_data(created_at)");
            console.log("Ensured index idx_sensor_data_created_at");
        } catch (e) {
            // Таблица может ещё не существовать при первом запуске — игнорируем ошибку
            console.warn("Could not create index (table may not exist yet):", e.message);
        }
    })
    .catch(err => console.error("DB error:", err));

// Очистка старых данных — удаляем записи старше 7 дней
const cleanupOldSensorData = async () => {
    try {
        const res = await pool.query("DELETE FROM sensor_data WHERE created_at < NOW() - INTERVAL '7 days'");
        if (res && typeof res.rowCount === 'number') {
            console.log(`Cleanup: removed ${res.rowCount} old sensor_data rows`);
        }
    } catch (err) {
        console.error("Cleanup error:", err);
    }
};

// Выполнить очистку при старте и запускать раз в 24 часа
cleanupOldSensorData().catch(() => {});
setInterval(cleanupOldSensorData, 24 * 60 * 60 * 1000);

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
    console.log("Client connected:", socket.id, "addr:", socket.handshake.address);

    // --- Микроконтроллер отправляет данные ---
    socket.on("esp_data", async (data) => {
        // Помечаем сокет как ESP
        socket.isESP = true;
        try {
            console.log("Received esp_data from", socket.id, "data:", data);
        } catch (e) {
            console.log("Received esp_data (unserializable) from", socket.id);
        }

        const { temperature, soil, light } = data;
        const roundedTemperature = Math.round(parseFloat(temperature) * 10) / 10;

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
                [roundedTemperature, soil, light, currentSessionId]
            );
            const newData = result.rows[0];

            // Добавляем в буфер текущей сессии
            currentSessionData.push(newData);
            // Храним только последние 20
            if (currentSessionData.length > 20) {
                currentSessionData = currentSessionData.slice(-20);
            }
            // Рассылаем всем клиентам
            io.emit("sensor_update", newData);
            console.log("Inserted sensor_data id=", newData.id, "temp=", newData.temperature, "emitted sensor_update");
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

    // --- ESP запрашивает настройки после подключения ---
    socket.on("esp_init", async () => {
        socket.isESP = true;

        try {
            const result = await pool.query(`SELECT * FROM settings WHERE id=1`);
            const currentSettings = result.rows[0] || {
                max_temp: 30,
                min_hum: 40,
                min_light: 30,
            };
            const espSettings = {
                maxTemp: currentSettings.max_temp,
                minSoil: currentSettings.min_hum,
                minLight: currentSettings.min_light,
            };

            socket.emit("esp_settings", espSettings);
            console.log("Sent current settings to ESP on init", espSettings);
        } catch (err) {
            console.error("ESP init settings error:", err);
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

            const espSettings = {
                maxTemp: updatedSettings.max_temp,
                minSoil: updatedSettings.min_hum,
                minLight: updatedSettings.min_light,
            };

            // Рассылаем ВСЕМ клиентам (включая отправителя)
            io.emit("settings_update", updatedSettings);

            // Отправляем настройки ESP всем подключённым сокетам,
            // чтобы не зависеть от метки isESP на момент обновления
            io.emit("esp_settings", espSettings);
        } catch (err) {
            console.error("Settings update error:", err);
            socket.emit("settings_error", { error: err.message });
        }
    });

    const getLastSessionHistory = async (limit = 20) => {
        const sessionResult = await pool.query(
            `SELECT id FROM sessions ORDER BY id DESC LIMIT 1`
        );
        if (sessionResult.rows.length === 0) {
            return [];
        }

        const sessionId = sessionResult.rows[0].id;
        const dataResult = await pool.query(
            `SELECT temperature, humidity, light, created_at
             FROM sensor_data
             WHERE session_id = $1
             ORDER BY created_at DESC
             LIMIT $2`,
            [sessionId, limit]
        );

        return dataResult.rows.reverse();
    };

    // --- Клиент запрашивает последние 20 значений ---
    socket.on("get_history", async (callback) => {
        try {
            // Если в памяти есть активная сессия, отдаём её
            if (currentSessionData.length > 0) {
                if (typeof callback === "function") {
                    callback(currentSessionData);
                }
                return;
            }

            // В противном случае берём последние 20 точек из самой последней сессии из БД
            const history = await getLastSessionHistory(20);
            if (typeof callback === "function") {
                callback(history);
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
    const roundedTemperature = Math.round(parseFloat(temperature) * 10) / 10;

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
            [roundedTemperature, humidity, light, currentSessionId]
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
        const requestedSessionId = req.query.session_id ? parseInt(req.query.session_id, 10) : null;
        let sessionId = requestedSessionId;

        if (requestedSessionId && isNaN(requestedSessionId)) {
            return res.status(400).json({ error: 'Invalid session_id' });
        }

        // Если есть данные текущей активной сессии в памяти и не запрошен конкретный session_id — отдаём их
        if (!sessionId && currentSessionData.length > 0) {
            return res.json(currentSessionData);
        }

        if (!sessionId) {
            const sessionResult = await pool.query(
                `SELECT id FROM sessions ORDER BY id DESC LIMIT 1`
            );

            if (sessionResult.rows.length === 0) {
                return res.json([]);
            }

            sessionId = sessionResult.rows[0].id;
        }

        const result = await pool.query(
            `SELECT id, temperature, humidity, light, created_at
             FROM sensor_data
             WHERE session_id = $1
             ORDER BY created_at ASC`,
            [sessionId]
        );

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sessions', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 50;
        const result = await pool.query(
            `SELECT s.id, s.status, s.device_ip, s.start_time, s.end_time,
                    COUNT(sd.id) AS data_count
             FROM sessions s
             LEFT JOIN sensor_data sd ON sd.session_id = s.id
             GROUP BY s.id
             ORDER BY s.start_time DESC
             LIMIT $1`,
            [limit]
        );

        const sessions = result.rows.map(row => ({
            id: row.id,
            status: row.status,
            device_ip: row.device_ip,
            start_time: row.start_time,
            end_time: row.end_time,
            data_count: parseInt(row.data_count, 10),
        }));

        res.json(sessions);
    } catch (err) {
        console.error('Sessions list error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sessions/:id/data', async (req, res) => {
    try {
        const sessionId = parseInt(req.params.id, 10);
        if (isNaN(sessionId)) {
            return res.status(400).json({ error: 'Invalid session id' });
        }

        const result = await pool.query(
            `SELECT id, temperature, humidity, light, created_at
             FROM sensor_data
             WHERE session_id = $1
             ORDER BY created_at ASC`,
            [sessionId]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('Session data error:', err);
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

        const espSettings = {
            maxTemp: updatedSettings.max_temp,
            minSoil: updatedSettings.min_hum,
            minLight: updatedSettings.min_light,
        };

        // Рассылаем всем клиентам через WebSocket
        io.emit("settings_update", updatedSettings);

        // Отправляем настройки ESP всем подключённым сокетам
        io.emit("esp_settings", espSettings);

        res.json(updatedSettings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: посмотреть последние N записей и сколько старых
app.get('/admin/last-data', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const result = await pool.query(
            `SELECT id, temperature, humidity, light, created_at
             FROM sensor_data
             ORDER BY created_at DESC
             LIMIT $1`,
            [limit]
        );

        const oldCountRes = await pool.query(
            `SELECT COUNT(*) FROM sensor_data WHERE created_at < NOW() - INTERVAL '7 days'`
        );

        res.json({
            recent: result.rows,
            old_count: parseInt(oldCountRes.rows[0].count, 10)
        });
    } catch (err) {
        console.error('Admin last-data error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Root endpoint
app.get("/", (req, res) => {
    res.send("Greenhouse Server is running (WebSocket + HTTP API)");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on port " + PORT));
