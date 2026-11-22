import { Server as SocketIOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { Role, Station } from '../types';

// Store the global io instance for use in controllers/services
let _io: SocketIOServer | undefined;
let _agentSocketId: string | null = null;
let _lastAgentHeartbeat = 0;

// Connected station screens: station -> set of socket ids
const stationSockets = new Map<Station, Set<string>>(
  Object.values(Station).map((s) => [s, new Set<string>()]),
);

interface JwtPayload {
  userId: string;
  role: Role;
  station?: Station;
}

type ExtSocket = Socket & { isAgent?: boolean; user?: JwtPayload };

// Hooks registered by services (avoids circular imports with models)
type TicketReceivedHandler = (ticketId: string, socketUser: JwtPayload) => Promise<void>;
type PrintResultHandler = (result: { jobId: string; status: 'printed' | 'failed'; error?: string }) => Promise<void>;
type AgentConnectedHandler = () => Promise<void>;

let onTicketReceived: TicketReceivedHandler | null = null;
let onPrintResult: PrintResultHandler | null = null;
let onAgentConnected: AgentConnectedHandler | null = null;

export const registerSocketHandlers = (h: {
  ticketReceived?: TicketReceivedHandler;
  printResult?: PrintResultHandler;
  agentConnected?: AgentConnectedHandler;
}): void => {
  if (h.ticketReceived) onTicketReceived = h.ticketReceived;
  if (h.printResult) onPrintResult = h.printResult;
  if (h.agentConnected) onAgentConnected = h.agentConnected;
};

export const isAgentConnected = (): boolean => _agentSocketId !== null;

export const getStationStatus = (): Record<Station, { online: boolean; screens: number }> => {
  const out = {} as Record<Station, { online: boolean; screens: number }>;
  for (const [station, ids] of stationSockets.entries()) {
    out[station] = { online: ids.size > 0, screens: ids.size };
  }
  return out;
};

export const isStationOnline = (station: Station): boolean => (stationSockets.get(station)?.size ?? 0) > 0;

export const getIO = (): SocketIOServer => {
  if (!_io) throw new Error('Socket.IO not initialized');
  return _io;
};

// Rooms
export const STAFF_ROOMS = ['role:cashier', 'role:manager', 'role:owner'];
export const stationRoom = (station: Station | string): string => `station:${station}`;

const emitStationStatus = (): void => {
  for (const room of STAFF_ROOMS) _io?.to(room).emit('kds:status', getStationStatus());
};

const emitAgentStatus = (): void => {
  for (const room of STAFF_ROOMS) {
    _io?.to(room).emit('agent:status', { online: isAgentConnected(), lastHeartbeat: _lastAgentHeartbeat });
  }
};

export const initSocket = (io: SocketIOServer): void => {
  _io = io;

  // ─── Auth Middleware ─────────────────────────────────────────────────────────
  // `auth` is read on every (re)connect, so clients that pass a function can
  // supply a refreshed token after expiry.
  io.use((socket: Socket, next) => {
    const agentToken = socket.handshake.auth?.agentToken as string | undefined;
    if (agentToken && agentToken === env.AGENT_TOKEN) {
      (socket as ExtSocket).isAgent = true;
      return next();
    }

    const token =
      (socket.handshake.auth?.token as string | undefined) ??
      socket.handshake.headers?.authorization?.replace('Bearer ', '') ??
      '';

    if (!token) return next(new Error('Authentication token missing'));

    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
      if (payload.role === Role.Kitchen && !payload.station) {
        return next(new Error('Station screen token has no station'));
      }
      (socket as ExtSocket).user = payload;
      return next();
    } catch {
      return next(new Error('Invalid or expired token'));
    }
  });

  // ─── Connection Handler ──────────────────────────────────────────────────────
  io.on('connection', (socket: Socket) => {
    const ext = socket as ExtSocket;

    if (ext.isAgent) {
      console.log(`🖨️  Print agent connected [${socket.id}]`);
      _agentSocketId = socket.id;
      _lastAgentHeartbeat = Date.now();
      socket.join('print-agent');
      emitAgentStatus();

      socket.on('agent:status', () => {
        _lastAgentHeartbeat = Date.now();
      });

      socket.on('print:result', (result) => {
        onPrintResult?.(result).catch((err) => console.error('print:result handler failed', err));
      });

      onAgentConnected?.().catch((err) => console.error('agent drain failed', err));
    } else if (ext.user) {
      const user = ext.user;
      if (user.role === Role.Kitchen && user.station) {
        console.log(`📺 Station screen connected: ${user.station} [${socket.id}]`);
        socket.join(stationRoom(user.station));
        stationSockets.get(user.station)?.add(socket.id);
        emitStationStatus();

        // Screen confirms a ticket is displayed. Ack callback lets the screen know it was recorded.
        socket.on('ticket:received', (data: { ticketId?: string }, ack?: (ok: boolean) => void) => {
          if (!data?.ticketId || !onTicketReceived) return ack?.(false);
          onTicketReceived(data.ticketId, user)
            .then(() => ack?.(true))
            .catch(() => ack?.(false));
        });
      } else {
        socket.join(`role:${user.role}`);
        socket.join(`user:${user.userId}`);
        // Give staff panels the current screen / agent state immediately
        socket.emit('kds:status', getStationStatus());
        socket.emit('agent:status', { online: isAgentConnected(), lastHeartbeat: _lastAgentHeartbeat });
      }
    }

    socket.on('disconnect', (reason) => {
      if (ext.isAgent) {
        console.log(`🖨️  Print agent disconnected: ${reason}`);
        if (_agentSocketId === socket.id) _agentSocketId = null;
        emitAgentStatus();
      } else if (ext.user?.role === Role.Kitchen && ext.user.station) {
        console.log(`📺 Station screen disconnected: ${ext.user.station} (${reason})`);
        stationSockets.get(ext.user.station)?.delete(socket.id);
        emitStationStatus();
      }
    });
  });

  console.log('🔌 Socket.IO initialized');
};

// ─── Emit Helpers (used by controllers) ─────────────────────────────────────
export const emitToAll = (event: string, data: unknown): void => {
  _io?.emit(event, data);
};

export const emitToRoom = (room: string, event: string, data: unknown): void => {
  _io?.to(room).emit(event, data);
};

export const emitToStaff = (event: string, data: unknown): void => {
  for (const room of STAFF_ROOMS) _io?.to(room).emit(event, data);
};

export const emitTableUpdated = (table: unknown): void => {
  emitToAll('table:updated', table);
};

export const emitMenuUpdated = (item: unknown): void => {
  emitToAll('menu:updated', item);
};

export const emitOrderUpdated = (waiterId: string, order: unknown): void => {
  emitToStaff('order:updated', order);
  emitToRoom(`user:${waiterId}`, 'order:updated', order);
  // Delivery staff only need a "something changed" nudge; their app reloads its list
  const o = order as { _id?: unknown; type?: string } | null;
  if (o?.type === 'delivery') emitToRoom('role:delivery', 'delivery:changed', { orderId: String(o._id ?? '') });
};
