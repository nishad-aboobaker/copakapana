import { Router } from 'express';
import { createUser, listUsers, listWaiters, resetPin, updateUser } from '../controllers/users.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { optionalAuth, requireAuth } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { Role } from '../types';

const router = Router();

// Publicly allow waiter login terminal to query active waiter names; full list requires auth
router.get('/waiters', asyncHandler(listWaiters));
router.get('/', optionalAuth, asyncHandler(listUsers));
router.post('/', requireAuth, requireRole(Role.Owner), asyncHandler(createUser));
router.patch('/:id', requireAuth, requireRole(Role.Owner), asyncHandler(updateUser));
router.post('/:id/reset-pin', requireAuth, requireRole(Role.Owner), asyncHandler(resetPin));

export default router;
