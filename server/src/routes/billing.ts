import { Router } from 'express';
import {
  applyDiscount,
  closeBill,
  generateBill,
  getBill,
  printDeliveryBill,
  printOrderBill,
  recordPayments,
  reprintBill,
  voidBill,
} from '../controllers/billing.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { Role } from '../types';

const router = Router();

// Order billing
router.post('/orders/:id/bill', requireAuth, requireRole(Role.Cashier), asyncHandler(generateBill));
router.post('/orders/:id/print-bill', requireAuth, requireRole(Role.Waiter), asyncHandler(printOrderBill));

// Bill operations
router.get('/bills/:id', requireAuth, requireRole(Role.Cashier), asyncHandler(getBill));
router.post('/bills/:id/discount', requireAuth, requireRole(Role.Cashier), asyncHandler(applyDiscount));
router.post('/bills/:id/payments', requireAuth, requireRole(Role.Cashier), asyncHandler(recordPayments));
router.post('/bills/:id/close', requireAuth, requireRole(Role.Cashier), asyncHandler(closeBill));
router.post('/bills/:id/void', requireAuth, requireRole(Role.Owner), asyncHandler(voidBill));
router.post('/bills/:id/reprint', requireAuth, requireRole(Role.Cashier), asyncHandler(reprintBill));
router.post('/bills/:id/delivery-bill', requireAuth, requireRole(Role.Cashier), asyncHandler(printDeliveryBill));

export default router;
