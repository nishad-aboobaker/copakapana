import { io, Socket } from 'socket.io-client';
import dotenv from 'dotenv';
import { JobQueue, PrintJobTask } from './queue/jobQueue';

dotenv.config();

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:5000';
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? '';

if (!AGENT_TOKEN) {
  console.error('❌ AGENT_TOKEN not set in .env');
  process.exit(1);
}

let socket: Socket;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

// Initialize Print Queue with result dispatch callback
const printQueue = new JobQueue((jobId, status, error) => {
  if (socket && socket.connected) {
    socket.emit('print:result', { jobId, status, error });
  }
});

const connect = (): void => {
  socket = io(SERVER_URL, {
    auth: { agentToken: AGENT_TOKEN },
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionAttempts: Infinity,
  });

  socket.on('connect', () => {
    console.log(`✅ Print agent connected to ${SERVER_URL} [${socket.id}]`);
    startHeartbeat();
  });

  socket.on('disconnect', (reason) => {
    console.log(`📴 Disconnected: ${reason}. Reconnecting...`);
    stopHeartbeat();
  });

  socket.on('connect_error', (err) => {
    console.error(`❌ Connection error: ${err.message}`);
  });

  // Bill / test-print jobs from the server (KOTs go to kitchen station screens)
  socket.on('print:job', (job: PrintJobTask) => {
    console.log(`📄 Received print:job from server:`, job.type);
    printQueue.enqueue(job);
  });
};

const startHeartbeat = (): void => {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (socket.connected) {
      socket.emit('agent:status', { ts: Date.now() });
    }
  }, 15_000);
};

const stopHeartbeat = (): void => {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
};

// ─── Graceful Shutdown ───────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('📴 SIGTERM received — disconnecting');
  stopHeartbeat();
  socket.disconnect();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('📴 SIGINT received — disconnecting');
  stopHeartbeat();
  socket.disconnect();
  process.exit(0);
});

console.log(`🖨️  Bill Print Agent starting... → ${SERVER_URL}`);
connect();
