import { Router } from 'express';
import {
  getKdsStatus,
  listTickets,
  listOrderTickets,
  listStationTickets,
  markTicketServed,
  recallStationTicket,
  resendTicket,
  updateStationTicketStatus,
} from '../controllers/tickets.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth, requireKitchen } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { Role } from '../types';

const router = Router();

// Staff
router.get('/orders/:id/tickets', requireAuth, asyncHandler(listOrderTickets));
router.get('/tickets', requireAuth, asyncHandler(listTickets));
router.post('/tickets/:id/served', requireAuth, asyncHandler(markTicketServed));
router.post('/tickets/:id/resend', requireAuth, requireRole(Role.Cashier), asyncHandler(resendTicket));
router.get('/kds/status', requireAuth, requireRole(Role.Cashier), asyncHandler(getKdsStatus));

// Station screens (kitchen accounts) — scoped to their own station in the service layer
router.get('/kds/tickets', requireKitchen, asyncHandler(listStationTickets));
router.post('/kds/tickets/:id/status', requireKitchen, asyncHandler(updateStationTicketStatus));
router.post('/kds/tickets/:id/recall', requireKitchen, asyncHandler(recallStationTicket));

export default router;
