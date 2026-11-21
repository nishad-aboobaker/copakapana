import { Router } from 'express';
import {
  createCategory,
  createItem,
  deleteCategory,
  deleteItem,
  getMenu,
  listAllItems,
  listCategories,
  listStationMenu,
  setStationItemAvailability,
  toggleAvailability,
  updateCategory,
  updateItem,
} from '../controllers/menu.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth, requireKitchen } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { Role } from '../types';

const router = Router();

// Public menu browsing
router.get('/menu', asyncHandler(getMenu));

// Categories
router.get('/categories', requireAuth, asyncHandler(listCategories));
router.post('/categories', requireAuth, requireRole(Role.Owner), asyncHandler(createCategory));
router.patch('/categories/:id', requireAuth, requireRole(Role.Owner), asyncHandler(updateCategory));
router.delete('/categories/:id', requireAuth, requireRole(Role.Owner), asyncHandler(deleteCategory));

// Items
router.get('/items', requireAuth, asyncHandler(listAllItems));
router.post('/items', requireAuth, requireRole(Role.Owner), asyncHandler(createItem));
router.patch('/items/:id', requireAuth, requireRole(Role.Owner), asyncHandler(updateItem));
router.delete('/items/:id', requireAuth, requireRole(Role.Owner), asyncHandler(deleteItem));

// Availability toggle (Manager or higher)
router.patch('/items/:id/availability', requireAuth, requireRole(Role.Manager), asyncHandler(toggleAvailability));

// Station screens: mark their own dishes in / out of stock
router.get('/kds/menu', requireKitchen, asyncHandler(listStationMenu));
router.patch('/kds/items/:id/availability', requireKitchen, asyncHandler(setStationItemAvailability));

export default router;
