import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

// All phones and screens on the restaurant WiFi share one public IP, so per-IP
// limits are generous. Per-account lockout (5 wrong PINs) still stops guessing.
export const loginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: env.NODE_ENV === 'test' ? 1000 : 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many login attempts. Please try again after 60 seconds.',
  },
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: env.NODE_ENV === 'test' ? 10000 : 3000,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests. Please slow down.',
  },
});
