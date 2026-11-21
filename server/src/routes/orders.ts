import { Router } from 'express';
import {
  addItemsToOrder,
  cancelOrder,
  cancelOrderItem,
  createOrder,
  getOrder,
  listOrders,
  mergeOrders,
  transferOrder,
} from '../controllers/orders.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { Role } from '../types';

const router = Router();

router.post('/', requireAuth, asyncHandler(createOrder));
router.get('/', requireAuth, asyncHandler(listOrders));
router.get('/:id', requireAuth, asyncHandler(getOrder));
router.post('/:id/items', requireAuth, asyncHandler(addItemsToOrder));
router.patch('/:id/items/:itemId/cancel', requireAuth, asyncHandler(cancelOrderItem));
router.post('/:id/cancel', requireAuth, asyncHandler(cancelOrder));
router.post('/:id/transfer', requireAuth, requireRole(Role.Cashier), asyncHandler(transferOrder));
router.post('/merge', requireAuth, requireRole(Role.Cashier), asyncHandler(mergeOrders));

export default router;
