import { env } from './env';

const allowedOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim());

/**
 * Checks whether an incoming HTTP or WebSocket origin is permitted.
 * Automatically accepts configured CORS_ORIGINS as well as any local network (LAN) IP.
 */
export const isOriginAllowed = (origin?: string): boolean => {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  // Allow localhost and local LAN IPs (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
  return /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?$/.test(origin);
};
