import 'dotenv/config';
import http from 'http';
import { Server } from 'socket.io';
import app from './app.js';
import { startExpirationWorker } from './services/expirationService.js';

const PORT = process.env.PORT || 5000;
const server = http.createServer(app);

// Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST']
  }
});

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

// Make io accessible to routes
app.locals.io = io;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Socket.io server initialized`);
});

// Phase 7: start the background expiration worker. It polls the database every
// EXPIRATION_POLL_INTERVAL_MS (default 1000ms) and atomically expires ACTIVE
// reservations whose expiresAt has passed, restoring their stock. The database
// remains the source of truth for what actually expires.
startExpirationWorker();

export { server, io };
