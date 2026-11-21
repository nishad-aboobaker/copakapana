import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('5000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  AGENT_TOKEN: z.string().min(16, 'AGENT_TOKEN must be at least 16 characters'),
  CORS_ORIGINS: z.string().default('http://localhost:4200'),
  // 'true' (one proxy hop, e.g. Nginx) or a hop count; leave empty when not behind a proxy
  TRUST_PROXY: z.string().default(''),
  SEED_OWNER_NAME: z.string().default('owner'),
  SEED_OWNER_PASSWORD: z.string().default('changeme123'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
