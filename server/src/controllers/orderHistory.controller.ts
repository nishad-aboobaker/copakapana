import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Bill } from '../models/Bill';
import { Order } from '../models/Order';
import { currentBusinessDate } from '../services/businessDay.service';
import { parseDateRange } from '../services/reports.service';
import { BillStatus, ItemStatus, OrderStatus, OrderType } from '../types';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * GET /orders/history — every order for a range of business days, newest first.
 * Query: from, to (YYYY-MM-DD business dates, default: the current day), type, status,
 * q (order number, customer name/phone or table), page, limit.
 * An order belongs to the business day its bill was settled in; unpaid orders to the
 * day they were taken (a 12:30 am order counts for the day before).
 */
export const listOrderHistory = async (req: Request, res: Response): Promise<void> => {
  const { from, to, startDate, endDate } = parseDateRange(
    req.query.from as string | undefined,
    req.query.to as string | undefined,
    await currentBusinessDate(),
  );
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const page = Math.max(Number(req.query.page) || 1, 1);

  // Orders whose paid bill is filed under these business days
  const paidInRange = await Bill.find({ status: BillStatus.Paid, businessDate: { $gte: from, $lte: to } }).distinct('orderId');

  const filter: Record<string, unknown> = {
    $or: [{ createdAt: { $gte: startDate, $lte: endDate } }, { _id: { $in: paidInRange } }],
  };
  const type = String(req.query.type ?? '');
  if ((Object.values(OrderType) as string[]).includes(type)) filter.type = type;
  const status = String(req.query.status ?? '');
  if ((Object.values(OrderStatus) as string[]).includes(status)) filter.status = status;

  const q = String(req.query.q ?? '').trim();
  if (q) {
    const or: Record<string, unknown>[] = [
      { 'customerSnapshot.name': { $regex: escapeRegex(q), $options: 'i' } },
    ];
    if (/^\d+$/.test(q)) {
      or.push({ number: Number(q) });
      if (q.length >= 3) or.push({ 'customerSnapshot.phone': { $regex: escapeRegex(q) } });
    }
    // Table name, e.g. "G1" or "T5"
    const tables = await mongoose.model('Table').find({ $or: [{ name: { $regex: `^${escapeRegex(q.replace(/^t/i, ''))}$`, $options: 'i' } }, { name: { $regex: `^${escapeRegex(q)}$`, $options: 'i' } }] }).distinct('_id');
    if (tables.length) or.push({ tableId: { $in: tables } });
    filter.$and = [{ $or: or }];
  }

  const [total, orders, allIds] = await Promise.all([
    Order.countDocuments(filter),
    Order.find(filter)
      .populate('tableId', 'name number floor')
      .populate('waiterId', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Order.find(filter).distinct('_id'),
  ]);

  // Latest bill per order (a voided bill is replaced by a newer one)
  const bills = await Bill.find({ orderId: { $in: orders.map((o) => o._id) } })
    .sort({ createdAt: 1 })
    .select('orderId number total status paidAt businessDate payments discountAmount')
    .lean();
  const billOf = new Map(bills.map((b) => [String(b.orderId), b]));

  // Totals for everything matching the filter, not just this page
  const [sums] = await Bill.aggregate<{ paidTotal: number; paidCount: number }>([
    { $match: { orderId: { $in: allIds }, status: BillStatus.Paid } },
    { $group: { _id: null, paidTotal: { $sum: '$total' }, paidCount: { $sum: 1 } } },
  ]);
  const byStatus = await Order.aggregate<{ _id: string; n: number }>([{ $match: { _id: { $in: allIds } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);

  res.json({
    from,
    to,
    page,
    limit,
    total,
    totals: {
      paidTotal: sums?.paidTotal ?? 0,
      paidCount: sums?.paidCount ?? 0,
      byStatus: Object.fromEntries(byStatus.map((s) => [s._id, s.n])),
    },
    orders: orders.map((o) => {
      const table = o.tableId as unknown as { name?: string; number?: string; floor?: string } | null;
      const active = o.items.filter((i) => i.status === ItemStatus.Active);
      const bill = billOf.get(String(o._id));
      return {
        _id: o._id,
        number: o.number,
        type: o.type,
        status: o.status,
        createdAt: o.createdAt,
        table: table ? { name: table.name ?? table.number, floor: table.floor } : null,
        customer: o.customerSnapshot ?? null,
        waiterName: (o.waiterId as unknown as { name?: string } | null)?.name ?? '',
        itemCount: active.reduce((n, i) => n + i.qty, 0),
        itemsTotal: active.reduce((n, i) => n + i.price * i.qty, 0),
        bill: bill
          ? {
              _id: bill._id,
              number: bill.number,
              total: bill.total,
              status: bill.status,
              paidAt: bill.paidAt,
              businessDate: bill.businessDate,
              discountAmount: bill.discountAmount,
              modes: [...new Set((bill.payments ?? []).map((p) => p.mode))],
            }
          : null,
      };
    }),
  });
};
