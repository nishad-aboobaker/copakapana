import { Router } from 'express';
import {
  getKdsStatus,
  listKots,
  listOrderKots,
  listStationKots,
  markKotServed,
  recallStationKot,
  resendKot,
  updateStationKotStatus,
} from '../controllers/kots.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth, requireKitchen } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { Role } from '../types';

const router = Router();

// Staff
router.get('/orders/:id/kots', requireAuth, asyncHandler(listOrderKots));
router.get('/kots', requireAuth, asyncHandler(listKots));
router.post('/kots/:id/served', requireAuth, asyncHandler(markKotServed));
router.post('/kots/:id/resend', requireAuth, requireRole(Role.Cashier), asyncHandler(resendKot));
router.get('/kds/status', requireAuth, requireRole(Role.Cashier), asyncHandler(getKdsStatus));

// Station screens (kitchen accounts) — scoped to their own station in the service layer
router.get('/kds/kots', requireKitchen, asyncHandler(listStationKots));
router.post('/kds/kots/:id/status', requireKitchen, asyncHandler(updateStationKotStatus));
router.post('/kds/kots/:id/recall', requireKitchen, asyncHandler(recallStationKot));

export default router;
