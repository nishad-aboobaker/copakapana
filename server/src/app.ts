import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env';
import { isOriginAllowed } from './config/cors';
import { errorHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimiters';

// Route imports
import healthRouter from './routes/health';
import authRouter from './routes/auth';
import usersRouter from './routes/users';
import tablesRouter from './routes/tables';
import menuRouter from './routes/menu';
import ordersRouter from './routes/orders';
import settingsRouter from './routes/settings';
import billingRouter from './routes/billing';
import customerRouter from './routes/customers';
import reportsRouter from './routes/reports';
import auditRouter from './routes/audit';
import ticketsRouter from './routes/tickets';
import deliveryRouter from './routes/delivery';
import accountsRouter from './routes/accounts';

const app = express();

// Behind Nginx / an AWS load balancer: use the real client IP (X-Forwarded-For)
// so rate limits apply per device, not to everyone at once.
if (env.TRUST_PROXY) app.set('trust proxy', env.TRUST_PROXY === 'true' ? 1 : Number(env.TRUST_PROXY) || env.TRUST_PROXY);

// ─── Security & Parsing ───────────────────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Logging ─────────────────────────────────────────────────────────────────
if (env.NODE_ENV !== 'test') {
  app.use(morgan(env.NODE_ENV === 'development' ? 'dev' : 'combined'));
}

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/health', healthRouter);
app.use('/api/v1', apiLimiter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/users', usersRouter);
app.use('/api/v1/tables', tablesRouter);
app.use('/api/v1/orders', ordersRouter);
app.use('/api/v1/settings', settingsRouter);
app.use('/api/v1/customers', customerRouter);
app.use('/api/v1/delivery', deliveryRouter);
app.use('/api/v1/accounts', accountsRouter);
app.use('/api/v1/reports', reportsRouter);
app.use('/api/v1/audit', auditRouter);
app.use('/api/v1', ticketsRouter);
app.use('/api/v1', billingRouter);
app.use('/api/v1', menuRouter);

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((req: Request, res: Response) => {
  res.status(404).json({ code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` });
});

// ─── Global Error Handler ────────────────────────────────────────────────────
app.use(errorHandler);

export default app;
