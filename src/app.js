import express from 'express';
import cors from 'cors';
import dropRoutes from './routes/dropRoutes.js';
import reservationRoutes from './routes/reservationRoutes.js';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes & Health Check
app.use('/api/drops', dropRoutes);
app.use('/api/reservations', reservationRoutes);
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'API is running'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error'
  });
});

export default app;
