import { Router } from 'express';
import { createTable, listTables, requestBill, updateTable } from '../controllers/tables.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { Role } from '../types';

const router = Router();

router.get('/', requireAuth, asyncHandler(listTables));
router.post('/', requireAuth, requireRole(Role.Owner), asyncHandler(createTable));
router.patch('/:id', requireAuth, requireRole(Role.Owner), asyncHandler(updateTable));
router.post('/:id/request-bill', requireAuth, asyncHandler(requestBill));

export default router;
