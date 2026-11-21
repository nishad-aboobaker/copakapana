import { Router } from 'express';
import { listAuditLogs } from '../controllers/audit.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { Role } from '../types';

const router = Router();

// Owner only
router.get('/', requireAuth, requireRole(Role.Owner), asyncHandler(listAuditLogs));

export default router;
