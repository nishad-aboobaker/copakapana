import { Request, Response } from 'express';
import { AuditLog } from '../models/AuditLog';
import { PrintJob } from '../models/PrintJob';
import { Settings } from '../models/Settings';
import { PrintService } from '../services/print.service';
import { emitToRoom } from '../socket';
import { PrintStatus } from '../types';

// Only these fields can be changed through PATCH /settings
const EDITABLE_FIELDS = [
  'restaurantName',
  'address',
  'phone',
  'billFooter',
  'billFooterNote',
  'printLogo',
  'gstEnabled',
  'gstRate',
  'serviceChargeEnabled',
  'serviceChargePercent',
  'billPrinterIp',
  'includeCustomerPiiInExports',
  'kdsWarnMinutes',
  'kdsLateMinutes',
  'kdsSoundEnabled',
] as const;

export const getSettings = async (_req: Request, res: Response): Promise<void> => {
  let settings = await Settings.findOne();
  if (!settings) {
    settings = await Settings.create({});
  }
  res.json({ settings });
};

export const updateSettings = async (req: Request, res: Response): Promise<void> => {
  let settings = await Settings.findOne();
  if (!settings) {
    settings = await Settings.create({});
  }

  const before = settings.toObject();
  for (const key of EDITABLE_FIELDS) {
    if (req.body[key] !== undefined) (settings as any)[key] = req.body[key];
  }
  if (settings.kdsLateMinutes < settings.kdsWarnMinutes) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'KDS "late" minutes must be at least the "warn" minutes' });
    return;
  }
  await settings.save();

  await AuditLog.create({
    action: 'settings_updated',
    userId: req.user?.id,
    entity: 'Settings',
    entityId: settings._id,
    before,
    after: settings.toObject(),
  });

  // Station screens pick up new timer thresholds / sound setting live
  emitToRoom('station:fried_chicken', 'kds:settings', pickKdsSettings(settings));
  emitToRoom('station:juice', 'kds:settings', pickKdsSettings(settings));
  emitToRoom('station:main', 'kds:settings', pickKdsSettings(settings));

  res.json({ settings });
};

const pickKdsSettings = (s: any) => ({
  kdsWarnMinutes: s.kdsWarnMinutes,
  kdsLateMinutes: s.kdsLateMinutes,
  kdsSoundEnabled: s.kdsSoundEnabled,
});

/** POST /settings/printers/bill/test — the bill printer is the only printer now. */
export const testPrinter = async (req: Request, res: Response): Promise<void> => {
  const { station } = req.params;
  if (station !== 'bill') {
    res.status(400).json({
      code: 'INVALID_PRINTER',
      message: 'Only the bill printer can be tested; kitchen stations use screens',
    });
    return;
  }

  const settings = await Settings.findOne();
  const targetIp = settings?.billPrinterIp || '192.168.1.100';
  const printJob = await PrintService.enqueue('test', targetIp, {
    station: 'bill',
    targetIp,
    timestamp: new Date().toISOString(),
    restaurantName: settings?.restaurantName || 'Copakapana Restaurant',
  });

  res.json({ message: `Test print queued for the bill printer (${targetIp})`, printJob });
};

export const getFailedJobs = async (_req: Request, res: Response): Promise<void> => {
  const jobs = await PrintJob.find({ status: PrintStatus.Failed }).sort({ createdAt: -1 }).limit(50);
  res.json({ jobs });
};

/** POST /settings/jobs/:jobId/retry — cashier one-click reprint of a failed bill. */
export const retryPrintJob = async (req: Request, res: Response): Promise<void> => {
  const job = await PrintService.retry(req.params.jobId, req.user?.id);
  if (!job) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Print job not found' });
    return;
  }
  res.json({ job });
};
