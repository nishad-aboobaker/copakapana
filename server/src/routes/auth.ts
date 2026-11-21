import { Router } from 'express';
import { getMe, login, logout, refreshToken } from '../controllers/auth.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAnyAuth } from '../middleware/requireAuth';
import { loginLimiter } from '../middleware/rateLimiters';

const router = Router();

router.post('/login', loginLimiter, asyncHandler(login));
router.post('/refresh', asyncHandler(refreshToken));
router.post('/logout', requireAnyAuth, asyncHandler(logout));
router.get('/me', requireAnyAuth, asyncHandler(getMe));

export default router;
