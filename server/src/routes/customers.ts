import { Router } from 'express';
import { getCustomer, listCustomers, lookupCustomer } from '../controllers/customers.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { Role } from '../types';

const router = Router();

// Waiter and above can look up a customer by phone while taking an order
router.get('/lookup', requireAuth, asyncHandler(lookupCustomer));

// Customer list and order history — cashier and above (contains phone numbers and addresses)
router.get('/', requireAuth, requireRole(Role.Cashier), asyncHandler(listCustomers));
router.get('/:id', requireAuth, requireRole(Role.Cashier), asyncHandler(getCustomer));

export default router;
