import { Router } from 'express';
import { lookupCustomer } from '../controllers/customers.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/requireAuth';

const router = Router();

// Waiter and above can lookup customers
router.get('/lookup', requireAuth, asyncHandler(lookupCustomer));

export default router;
