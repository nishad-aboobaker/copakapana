import { Router } from 'express';
import { listDeliveries, markDelivered, markOut, undoDelivery } from '../controllers/delivery.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireDelivery } from '../middleware/requireAuth';

const router = Router();

// Delivery staff app
router.get('/orders', requireDelivery, asyncHandler(listDeliveries));
router.post('/orders/:id/out', requireDelivery, asyncHandler(markOut));
router.post('/orders/:id/delivered', requireDelivery, asyncHandler(markDelivered));
router.post('/orders/:id/undo', requireDelivery, asyncHandler(undoDelivery));

export default router;
