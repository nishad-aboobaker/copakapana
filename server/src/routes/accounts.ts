import { Router } from 'express';
import {
  accountsReport,
  addSalaryPayment,
  addVendorEntry,
  createSalaryStaff,
  createVendor,
  deleteSalaryPayment,
  deleteVendorEntry,
  getSalaryStaff,
  getVendor,
  listSalaryStaff,
  listVendors,
  updateSalaryStaff,
  updateVendor,
} from '../controllers/accounts.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { Role } from '../types';

/** Accounts: vendor dues and staff salary — cashier and above. */
const router = Router();
router.use(requireAuth, requireRole(Role.Cashier));

router.get('/vendors', asyncHandler(listVendors));
router.post('/vendors', asyncHandler(createVendor));
router.get('/vendors/:id', asyncHandler(getVendor));
router.patch('/vendors/:id', asyncHandler(updateVendor));
router.post('/vendors/:id/entries', asyncHandler(addVendorEntry));
router.delete('/vendor-entries/:id', asyncHandler(deleteVendorEntry));

router.get('/staff', asyncHandler(listSalaryStaff));
router.post('/staff', asyncHandler(createSalaryStaff));
router.get('/staff/:id', asyncHandler(getSalaryStaff));
router.patch('/staff/:id', asyncHandler(updateSalaryStaff));
router.post('/staff/:id/payments', asyncHandler(addSalaryPayment));
router.delete('/salary-payments/:id', asyncHandler(deleteSalaryPayment));

router.get('/report', asyncHandler(accountsReport));

export default router;
