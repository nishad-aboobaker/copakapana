import { Bill } from '../models/Bill';
import { BusinessDay, IBusinessDay } from '../models/BusinessDay';
import { Order } from '../models/Order';
import { BillStatus, OrderStatus } from '../types';
import { addDays, maxYmd } from '../utils/ymd';

/**
 * If the counter is never closed, the day still ends at this hour (India time) the next
 * morning — so a forgotten "Close counter" never spills into the next day's sales.
 */
export const DAY_CUTOFF_HOUR = 6;

const ymdIST = (d: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);

/** The business date a moment falls in, by the clock alone: before 6 am counts as the previous day. */
export const naturalBusinessDate = (at: Date = new Date()): string =>
  ymdIST(new Date(at.getTime() - DAY_CUTOFF_HOUR * 60 * 60 * 1000));

/** When the cut-off for a business date happens (6 am India time the next morning). */
const cutoffOf = (date: string): Date =>
  new Date(`${addDays(date, 1)}T${String(DAY_CUTOFF_HOUR).padStart(2, '0')}:00:00+05:30`);

/** Sales figures for one business date. */
export const daySummary = async (date: string): Promise<NonNullable<IBusinessDay['summary']>> => {
  const [rows, openOrders] = await Promise.all([
    Bill.aggregate<{ bills: number; total: number; discount: number; cash: number; upi: number }>([
      { $match: { status: BillStatus.Paid, businessDate: date } },
      {
        $project: {
          total: 1,
          discountAmount: 1,
          cash: { $sum: { $map: { input: { $filter: { input: '$payments', cond: { $eq: ['$$this.mode', 'cash'] } } }, in: '$$this.amount' } } },
          upi: { $sum: { $map: { input: { $filter: { input: '$payments', cond: { $eq: ['$$this.mode', 'upi'] } } }, in: '$$this.amount' } } },
        },
      },
      { $group: { _id: null, bills: { $sum: 1 }, total: { $sum: '$total' }, discount: { $sum: '$discountAmount' }, cash: { $sum: '$cash' }, upi: { $sum: '$upi' } } },
    ]),
    Order.countDocuments({ status: { $in: [OrderStatus.Open, OrderStatus.Billed] } }),
  ]);
  const r = rows[0] ?? { bills: 0, total: 0, discount: 0, cash: 0, upi: 0 };
  return { bills: r.bills, total: r.total, cash: r.cash, upi: r.upi, discount: r.discount, openOrders };
};

const closeDay = async (day: IBusinessDay, by: { id?: string; name: string }, at = new Date()): Promise<IBusinessDay> => {
  day.closedAt = at;
  day.closedByName = by.name;
  if (by.id) day.closedBy = by.id as never;
  day.summary = await daySummary(day.date);
  await day.save();
  return day;
};

/** The day still open, if any. Auto-closes it when its cut-off has passed. */
export const findOpenDay = async (now = new Date()): Promise<IBusinessDay | null> => {
  const open = await BusinessDay.findOne({ closedAt: { $exists: false } }).sort({ date: -1 });
  if (open && now >= cutoffOf(open.date)) {
    await closeDay(open, { name: 'Automatic' }, cutoffOf(open.date));
    return null;
  }
  return open;
};

/**
 * The business date new sales go to right now. Normally the open day's date. With no day open:
 * today by the clock (before 6 am = yesterday), but never a date that was already closed —
 * a sale after "Close counter" belongs to the next day.
 */
export const currentBusinessDate = async (now = new Date()): Promise<string> => {
  const open = await findOpenDay(now);
  if (open) return open.date;
  const lastClosed = await BusinessDay.findOne({ closedAt: { $exists: true } }).sort({ date: -1 }).select('date').lean();
  const natural = naturalBusinessDate(now);
  return lastClosed ? maxYmd(natural, addDays(lastClosed.date, 1)) : natural;
};

/** Returns the open day, opening one if needed. Safe if two requests race. */
export const ensureOpenDay = async (now = new Date()): Promise<IBusinessDay> => {
  const open = await findOpenDay(now);
  if (open) return open;
  const date = await currentBusinessDate(now);
  try {
    return await BusinessDay.create({ date, openedAt: now });
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
    const existing = await BusinessDay.findOne({ date });
    if (existing && !existing.closedAt) return existing;
    throw err;
  }
};

/** When the current business day started (for "today" lists such as the rider's Done tab). */
export const currentDayStart = async (now = new Date()): Promise<Date> => {
  const open = await findOpenDay(now);
  if (open) return open.openedAt;
  const lastClosed = await BusinessDay.findOne({ closedAt: { $exists: true } }).sort({ closedAt: -1 }).select('closedAt').lean();
  const natural = new Date(`${naturalBusinessDate(now)}T${String(DAY_CUTOFF_HOUR).padStart(2, '0')}:00:00+05:30`);
  return lastClosed?.closedAt && lastClosed.closedAt > natural ? lastClosed.closedAt : natural;
};

export const BusinessDayService = { closeDay };
