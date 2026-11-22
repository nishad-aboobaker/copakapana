import { Router } from 'express';
import {
  getFailedJobs,
  getSettings,
  testPrinter,
  retryPrintJob,
  updateSettings,
} from '../controllers/settings.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAnyAuth, requireAuth } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { Role } from '../types';

const router = Router();

router.get('/', requireAnyAuth, asyncHandler(getSettings));
router.patch('/', requireAuth, requireRole(Role.Owner), asyncHandler(updateSettings));
router.post('/printers/bill/test', requireAuth, requireRole(Role.Owner), asyncHandler(testPrinter));
router.get('/failed-jobs', requireAuth, requireRole(Role.Cashier), asyncHandler(getFailedJobs));
router.post('/jobs/:jobId/retry', requireAuth, requireRole(Role.Cashier), asyncHandler(retryPrintJob));

export default router;
