import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { isAgentConnected } from '../socket';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    mongoState: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    agentOnline: isAgentConnected(),
    ts: new Date().toISOString(),
    env: process.env.NODE_ENV,
  });
});

export default router;
