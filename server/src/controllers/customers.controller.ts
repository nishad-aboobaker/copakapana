import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Customer } from '../models/Customer';
import { Order } from '../models/Order';
import { Bill } from '../models/Bill';
import { BillStatus, ItemStatus } from '../types';

export const lookupCustomer = async (req: Request, res: Response): Promise<void> => {
  const phone = (req.query.phone as string)?.trim();
  if (!phone || phone.length < 10) {
    res.status(400).json({ code: 'INVALID_PHONE', message: 'Valid 10-digit phone number is required' });
    return;
  }

  const customer = await Customer.findOne({ phone });
  if (!customer) {
    res.status(404).json({ found: false, message: 'Customer not found' });
    return;
  }

  res.json({
    found: true,
    customer: {
      _id: customer._id,
      phone: customer.phone,
      name: customer.name,
      orderCount: customer.orderCount,
      lastOrderAt: customer.lastOrderAt,
      addresses: customer.addresses.map((a) => ({
        label: a.label,
        text: a.text,
        isDefault: a.isDefault,
      })),
    },
  });
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Paid-bill totals per customer: { customerId → { spent, paidOrders } } */
const spendByCustomer = async (customerIds: mongoose.Types.ObjectId[]) => {
  if (!customerIds.length) return new Map<string, { spent: number; paidOrders: number }>();
  const rows: { _id: mongoose.Types.ObjectId; spent: number; paidOrders: number }[] = await Order.aggregate([
    { $match: { customerId: { $in: customerIds } } },
    { $lookup: { from: Bill.collection.name, localField: '_id', foreignField: 'orderId', as: 'bill' } },
    { $unwind: '$bill' },
    { $match: { 'bill.status': BillStatus.Paid } },
    { $group: { _id: '$customerId', spent: { $sum: '$bill.total' }, paidOrders: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), { spent: r.spent, paidOrders: r.paidOrders }]));
};

/** GET /customers?q=&page=&limit= — takeaway/delivery customers, most recent first. */
export const listCustomers = async (req: Request, res: Response): Promise<void> => {
  const q = String(req.query.q ?? '').trim();
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));

  const filter: Record<string, unknown> = {};
  if (q) {
    const digits = q.replace(/\D/g, '');
    const or: Record<string, unknown>[] = [{ name: { $regex: escapeRegex(q), $options: 'i' } }];
    if (digits.length >= 3) or.push({ phone: { $regex: escapeRegex(digits) } });
    filter.$or = or;
  }

  const [total, customers] = await Promise.all([
    Customer.countDocuments(filter),
    Customer.find(filter)
      .sort({ lastOrderAt: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
  ]);

  const spend = await spendByCustomer(customers.map((c) => c._id as mongoose.Types.ObjectId));

  res.json({
    total,
    page,
    limit,
    customers: customers.map((c) => ({
      _id: c._id,
      name: c.name,
      phone: c.phone,
      orderCount: c.orderCount,
      lastOrderAt: c.lastOrderAt,
      createdAt: c.createdAt,
      addressCount: c.addresses?.length ?? 0,
      totalSpent: spend.get(String(c._id))?.spent ?? 0,
    })),
  });
};

/** GET /customers/:id — profile, spend summary, favourite dishes and past orders (newest first). */
export const getCustomer = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Customer not found' });
    return;
  }
  const customer = await Customer.findById(id).lean();
  if (!customer) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Customer not found' });
    return;
  }

  const orders = await Order.find({ customerId: customer._id })
    .sort({ createdAt: -1 })
    .limit(200)
    .populate('waiterId', 'name')
    .lean();
  const bills = await Bill.find({ orderId: { $in: orders.map((o) => o._id) } })
    .sort({ createdAt: -1 })
    .lean();
  // Latest bill per order (a voided bill may have been replaced)
  const billByOrder = new Map<string, (typeof bills)[number]>();
  for (const b of bills) if (!billByOrder.has(String(b.orderId))) billByOrder.set(String(b.orderId), b);

  let totalSpent = 0;
  let paidOrders = 0;
  const dishCount = new Map<string, number>();

  const history = orders.map((o) => {
    const bill = billByOrder.get(String(o._id));
    const activeItems = o.items.filter((i) => i.status !== ItemStatus.Cancelled);
    if (bill?.status === BillStatus.Paid) {
      totalSpent += bill.total;
      paidOrders += 1;
      for (const i of activeItems) dishCount.set(i.name, (dishCount.get(i.name) ?? 0) + i.qty);
    }
    return {
      _id: o._id,
      number: o.number,
      type: o.type,
      status: o.status,
      createdAt: o.createdAt,
      waiterName: (o.waiterId as unknown as { name?: string } | null)?.name ?? '',
      address: o.customerSnapshot?.address ?? '',
      items: o.items.map((i) => ({
        name: i.name,
        qty: i.qty,
        price: i.price,
        portion: i.portion,
        note: i.note,
        cancelled: i.status === ItemStatus.Cancelled,
      })),
      itemsTotal: activeItems.reduce((sum, i) => sum + i.price * i.qty, 0),
      bill: bill
        ? {
            number: bill.number,
            status: bill.status,
            total: bill.total,
            discountAmount: bill.discountAmount,
            paidAt: bill.paidAt,
            paymentModes: [...new Set((bill.payments ?? []).map((p) => p.mode))],
          }
        : null,
    };
  });

  const favourites = [...dishCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, qty]) => ({ name, qty }));

  res.json({
    customer: {
      _id: customer._id,
      name: customer.name,
      phone: customer.phone,
      addresses: customer.addresses ?? [],
      orderCount: customer.orderCount,
      lastOrderAt: customer.lastOrderAt,
      createdAt: customer.createdAt,
    },
    summary: {
      totalSpent,
      paidOrders,
      averageBill: paidOrders ? Math.round(totalSpent / paidOrders) : 0,
      favourites,
    },
    orders: history,
  });
};
