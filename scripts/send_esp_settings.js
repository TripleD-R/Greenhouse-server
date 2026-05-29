// Simple test client to send esp_settings to the server
// Usage: node scripts/send_esp_settings.js [HOST] [PORT]

const { io } = require("socket.io-client");

const host = process.argv[2] || "http://localhost";
const port = process.argv[3] || 3000;
const url = `${host}:${port}`;

console.log("Connecting to", url);

const socket = io(url, {
  transports: ["websocket"],
  reconnectionDelayMax: 10000,
});

socket.on("connect", () => {
  console.log("connected", socket.id);

  const settings = {
    maxTemp: 28,
    minSoil: 35,
    minLight: 25
  };

  console.log("Emitting esp_settings:", settings);
  socket.emit("esp_settings", settings);
});

socket.on("settings_ok", (data) => {
  console.log("Server ack settings_ok:", data);
  socket.close();
});

socket.on("settings_error", (err) => {
  console.error("Server reported error:", err);
  socket.close();
});

socket.on("disconnect", () => {
  console.log("disconnected");
});
