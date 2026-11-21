import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import app from './app';
import { connectDB } from './config/db';
import { env } from './config/env';
import { isOriginAllowed } from './config/cors';
import { initSocket } from './socket';
import { bootstrapDefaultData } from './services/bootstrap.service';
import { initKotWatchers } from './services/kot.service';
import { initPrintWatchers } from './services/print.service';

const startServer = async (): Promise<void> => {
  // Connect to MongoDB first
  await connectDB();

  // Ensure default staff, tables, menu, and settings exist
  await bootstrapDefaultData();

  // Create HTTP server
  const httpServer = http.createServer(app);

  // Attach Socket.IO
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (isOriginAllowed(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
    },
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
      skipMiddlewares: false,
    },
  });

  // Initialize socket handlers
  initSocket(io);
  const watchers = [initKotWatchers(), initPrintWatchers()];

  // Start listening
  const port = Number(env.PORT);
  httpServer.listen(port, () => {
    console.log(`🚀 Server running on port ${port} [${env.NODE_ENV}]`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n📴 ${signal} received — shutting down gracefully`);
    watchers.forEach((t) => clearInterval(t));
    io.close();
    httpServer.close(() => {
      console.log('✅ HTTP server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

startServer().catch((err) => {
  console.error('💥 Failed to start server:', err);
  process.exit(1);
});
