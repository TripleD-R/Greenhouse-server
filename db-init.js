const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

const createSchema = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        status VARCHAR(32) NOT NULL,
        device_ip TEXT,
        start_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        end_time TIMESTAMP WITH TIME ZONE
      );

      CREATE TABLE IF NOT EXISTS sensor_data (
        id SERIAL PRIMARY KEY,
        temperature NUMERIC,
        humidity NUMERIC,
        light NUMERIC,
        session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY,
        max_temp NUMERIC,
        min_hum NUMERIC,
        min_light NUMERIC,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      INSERT INTO settings (id, max_temp, min_hum, min_light)
      VALUES (1, 25, 40, 100)
      ON CONFLICT (id) DO NOTHING;
    `);

    console.log("Database schema created or verified successfully.");
  } catch (error) {
    console.error("Failed to create database schema:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
};

if (!process.env.DATABASE_URL) {
  console.error("Please set DATABASE_URL before running this script.");
  process.exit(1);
}

createSchema();
