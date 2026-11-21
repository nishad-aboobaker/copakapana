import { Router } from 'express';
import {
  getDailyReport,
  getEodReport,
  getItemsReport,
  getKitchenReport,
  getOrderTypesReport,
  getPaymentsReport,
  getWaitersReport,
} from '../controllers/reports.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { Role } from '../types';

const router = Router();

// Manager and above only
router.use(requireAuth, requireRole(Role.Manager));

router.get('/daily', asyncHandler(getDailyReport));
router.get('/items', asyncHandler(getItemsReport));
router.get('/payments', asyncHandler(getPaymentsReport));
router.get('/order-types', asyncHandler(getOrderTypesReport));
router.get('/waiters', asyncHandler(getWaitersReport));
router.get('/kitchen', asyncHandler(getKitchenReport));
router.get('/eod', asyncHandler(getEodReport));

export default router;
