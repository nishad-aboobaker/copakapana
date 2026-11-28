import { Request, Response } from 'express';
import { AuditLog } from '../models/AuditLog';
import { Bill } from '../models/Bill';
import { BusinessDay } from '../models/BusinessDay';
import { Order } from '../models/Order';
import { emitToStaff } from '../socket';
import {
  BusinessDayService,
  currentBusinessDate,
  daySummary,
  ensureOpenDay,
  findOpenDay,
} from '../services/businessDay.service';
import { OrderStatus } from '../types';

/** GET /business-day — the current business date, whether it's open, and its sales so far. */
export const getBusinessDay = async (_req: Request, res: Response): Promise<void> => {
  const open = await findOpenDay();
  const date = open?.date ?? (await currentBusinessDate());
  const [summary, lastClosed] = await Promise.all([
    daySummary(date),
    BusinessDay.findOne({ closedAt: { $exists: true } }).sort({ date: -1 }).lean(),
  ]);
  res.json({
    date,
    open: !!open,
    openedAt: open?.openedAt ?? null,
    summary,
    lastClosed: lastClosed ? { date: lastClosed.date, closedAt: lastClosed.closedAt, closedByName: lastClosed.closedByName, summary: lastClosed.summary } : null,
  });
};

/**
 * POST /business-day/close — "Close counter". Files everything since the day opened under its
 * date and starts a new day for the next sale. Orders still open are listed first; send
 * { force: true } to close anyway (they're billed into the next day).
 */
export const closeBusinessDay = async (req: Request, res: Response): Promise<void> => {
  const openOrders = await Order.find({ status: { $in: [OrderStatus.Open, OrderStatus.Billed] } })
    .select('number type status')
    .sort({ number: 1 })
    .lean();
  if (openOrders.length > 0 && !req.body?.force) {
    res.status(409).json({
      code: 'OPEN_ORDERS',
      message: `${openOrders.length} order${openOrders.length === 1 ? ' is' : 's are'} still open`,
      openOrders,
    });
    return;
  }

  const day = await ensureOpenDay();
  await BusinessDayService.closeDay(day, { id: req.user!.id, name: req.user!.name });

  await AuditLog.create({
    action: 'counter_closed',
    userId: req.user!.id,
    entity: 'BusinessDay',
    entityId: day._id,
    after: { date: day.date, summary: day.summary, forced: openOrders.length > 0 },
  });
  emitToStaff('day:closed', { date: day.date });

  res.json({ day, nextDate: await currentBusinessDate() });
};

/**
 * POST /business-day/reopen — undo a "Close counter" pressed by mistake. Only while nothing has
 * been settled since (no bills under a later date); the last closed day becomes the open day again.
 */
export const reopenBusinessDay = async (req: Request, res: Response): Promise<void> => {
  const last = await BusinessDay.findOne({ closedAt: { $exists: true } }).sort({ date: -1 });
  if (!last) {
    res.status(404).json({ code: 'NOTHING_TO_REOPEN', message: 'No closed day to reopen' });
    return;
  }
  if (last.closedByName === 'Automatic') {
    res.status(409).json({ code: 'AUTO_CLOSED', message: 'That day ended automatically at 6 am and can’t be reopened' });
    return;
  }
  const laterSales = await Bill.exists({ businessDate: { $gt: last.date } });
  if (laterSales) {
    res.status(409).json({ code: 'NEW_DAY_STARTED', message: 'Bills have already been settled in the next day' });
    return;
  }
  await BusinessDay.deleteMany({ date: { $gt: last.date }, closedAt: { $exists: false } });
  last.set({ closedAt: undefined, closedBy: undefined, closedByName: undefined, summary: undefined });
  await last.save();
  await AuditLog.create({ action: 'counter_reopened', userId: req.user!.id, entity: 'BusinessDay', entityId: last._id, after: { date: last.date } });
  emitToStaff('day:closed', { date: last.date, reopened: true });
  res.json({ date: last.date });
};

/** GET /business-day/history — recently closed days (newest first). */
export const listBusinessDays = async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(Number(req.query.limit) || 30, 120);
  const days = await BusinessDay.find().sort({ date: -1 }).limit(limit).lean();
  res.json({ days });
};
