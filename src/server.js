import "dotenv/config";
import http from "http";
import { Server } from "socket.io";
import app from "./app.js";
import { startExpirationWorker } from "./services/expirationService.js";
import { initSocket } from "./services/socketService.js";

const PORT = process.env.PORT || 5000;
const server = http.createServer(app);

// Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

// Allow the services to broadcast events to clients.
initSocket(io);

// Socket.io connection handler
io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on("disconnect", () => {
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

// Make io accessible to routes
app.locals.io = io;

server.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT} health check at http://localhost:${PORT}/api/health`,
  );
  console.log(`Socket.io server initialized`);
});

startExpirationWorker();

export { server, io };
