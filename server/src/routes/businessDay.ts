import { Router } from 'express';
import { closeBusinessDay, getBusinessDay, listBusinessDays, reopenBusinessDay } from '../controllers/businessDay.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { Role } from '../types';

const router = Router();
router.use(requireAuth, requireRole(Role.Cashier));

router.get('/', asyncHandler(getBusinessDay));
router.get('/history', asyncHandler(listBusinessDays));
router.post('/close', asyncHandler(closeBusinessDay));
router.post('/reopen', asyncHandler(reopenBusinessDay));

export default router;
