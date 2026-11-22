import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { AuditLog } from '../models/AuditLog';
import { Bill } from '../models/Bill';
import { IOrder, Order } from '../models/Order';
import { Ticket } from '../models/Ticket';
import { emitOrderUpdated } from '../socket';
import { BillStatus, CollectedMode, DeliveryStatus, ItemStatus, OrderStatus, OrderType, TicketStatus } from '../types';

/** Paid delivery orders older than this that were never marked delivered stop showing as active. */
const ACTIVE_WINDOW_MS = 18 * 60 * 60 * 1000;

const startOfTodayIST = (): Date => {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  return new Date(`${ymd}T00:00:00+05:30`);
};

type KitchenState = 'none' | 'cooking' | 'ready';

/** Shapes one delivery order for the rider's phone. */
const present = (
  o: IOrder & { _id: mongoose.Types.ObjectId },
  bill: { _id: unknown; number: number; total: number; status: BillStatus; payments?: { amount: number }[] } | undefined,
  kitchen: KitchenState,
) => {
  const activeItems = o.items.filter((i) => i.status !== ItemStatus.Cancelled);
  const itemsTotal = activeItems.reduce((s, i) => s + i.price * i.qty, 0);
  const paid = bill?.status === BillStatus.Paid || o.status === OrderStatus.Paid;
  const paidSoFar = (bill?.payments ?? []).reduce((s, p) => s + (p.amount || 0), 0);
  const total = bill?.total ?? itemsTotal;
  return {
    _id: o._id,
    number: o.number,
    createdAt: o.createdAt,
    status: o.status,
    customer: o.customerSnapshot ?? {},
    items: activeItems.map((i) => ({ name: i.name, qty: i.qty, portion: i.portion, note: i.note })),
    total,
    paid,
    amountDue: paid ? 0 : Math.max(0, total - paidSoFar),
    billNumber: bill?.number,
    billed: !!bill && bill.status !== BillStatus.Void,
    kitchen,
    delivery: {
      status: o.delivery?.status ?? DeliveryStatus.Waiting,
      outAt: o.delivery?.outAt,
      deliveredAt: o.delivery?.deliveredAt,
      collectedMode: o.delivery?.collectedMode,
      collectedAmount: o.delivery?.collectedAmount,
      riderName: o.delivery?.riderName,
    },
  };
};

const loadExtras = async (orders: (IOrder & { _id: mongoose.Types.ObjectId })[]) => {
  const ids = orders.map((o) => o._id);
  const [bills, tickets] = await Promise.all([
    Bill.find({ orderId: { $in: ids }, status: { $ne: BillStatus.Void } }).sort({ createdAt: -1 }).lean(),
    Ticket.find({ orderId: { $in: ids } }).select('orderId status').lean(),
  ]);
  const billByOrder = new Map<string, (typeof bills)[number]>();
  for (const b of bills) if (!billByOrder.has(String(b.orderId))) billByOrder.set(String(b.orderId), b);

  const kitchenByOrder = new Map<string, KitchenState>();
  for (const t of tickets) {
    const key = String(t.orderId);
    const done = t.status === TicketStatus.Ready || t.status === TicketStatus.Served;
    const cur = kitchenByOrder.get(key);
    if (!done) kitchenByOrder.set(key, 'cooking');
    else if (cur !== 'cooking') kitchenByOrder.set(key, 'ready');
  }
  return { billByOrder, kitchenByOrder };
};

/**
 * GET /delivery/orders — everything the rider needs:
 *  active: delivery orders not delivered yet (oldest first)
 *  done:   delivered today (newest first) + totals collected, so the rider knows what to hand over
 */
export const listDeliveries = async (_req: Request, res: Response): Promise<void> => {
  const since = new Date(Date.now() - ACTIVE_WINDOW_MS);
  const [activeOrders, doneOrders] = await Promise.all([
    Order.find({
      type: OrderType.Delivery,
      'delivery.status': { $ne: DeliveryStatus.Delivered },
      $or: [{ status: { $in: [OrderStatus.Open, OrderStatus.Billed] } }, { status: OrderStatus.Paid, createdAt: { $gte: since } }],
    }).sort({ createdAt: 1 }),
    Order.find({
      type: OrderType.Delivery,
      'delivery.status': DeliveryStatus.Delivered,
      'delivery.deliveredAt': { $gte: startOfTodayIST() },
    }).sort({ 'delivery.deliveredAt': -1 }),
  ]);

  const all = [...activeOrders, ...doneOrders] as (IOrder & { _id: mongoose.Types.ObjectId })[];
  const { billByOrder, kitchenByOrder } = await loadExtras(all);
  const shape = (o: IOrder & { _id: mongoose.Types.ObjectId }) =>
    present(o, billByOrder.get(String(o._id)) as any, kitchenByOrder.get(String(o._id)) ?? 'none');

  const done = doneOrders.map((o) => shape(o as IOrder & { _id: mongoose.Types.ObjectId }));
  const totals = { delivered: done.length, cash: 0, upi: 0 };
  for (const d of done) {
    if (d.delivery.collectedMode === CollectedMode.Cash) totals.cash += d.delivery.collectedAmount ?? 0;
    if (d.delivery.collectedMode === CollectedMode.UPI) totals.upi += d.delivery.collectedAmount ?? 0;
  }

  res.json({
    active: activeOrders.map((o) => shape(o as IOrder & { _id: mongoose.Types.ObjectId })),
    done,
    totals,
  });
};

const findDeliveryOrder = async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
    return null;
  }
  const order = await Order.findById(id);
  if (!order || order.type !== OrderType.Delivery) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Delivery order not found' });
    return null;
  }
  if (order.status === OrderStatus.Cancelled) {
    res.status(409).json({ code: 'ORDER_CANCELLED', message: 'This order was cancelled' });
    return null;
  }
  return order;
};

const audit = (req: Request, action: string, order: IOrder, before: unknown) =>
  AuditLog.create({
    action,
    userId: req.user?.id,
    entity: 'Order',
    entityId: order._id,
    before,
    after: order.delivery,
  });

/** POST /delivery/orders/:id/out — rider has picked the order up. */
export const markOut = async (req: Request, res: Response): Promise<void> => {
  const order = await findDeliveryOrder(req, res);
  if (!order) return;
  const before = order.delivery ? { ...order.delivery } : undefined;
  if (order.delivery?.status === DeliveryStatus.Delivered) {
    res.status(409).json({ code: 'ALREADY_DELIVERED', message: 'This order is already delivered' });
    return;
  }
  order.delivery = {
    ...(order.delivery ?? {}),
    status: DeliveryStatus.Out,
    outAt: new Date(),
    riderId: req.user!.id,
    riderName: req.user!.name,
  };
  await order.save();
  await audit(req, 'delivery_out', order, before);
  emitOrderUpdated(order.waiterId.toString(), order);
  res.json({ message: `Order #${order.number} is out for delivery`, delivery: order.delivery });
};

/**
 * POST /delivery/orders/:id/delivered { mode: cash|upi|prepaid, amount }
 * Records what the rider collected. The cashier still settles the bill when the money comes in.
 */
export const markDelivered = async (req: Request, res: Response): Promise<void> => {
  const order = await findDeliveryOrder(req, res);
  if (!order) return;
  const mode = req.body?.mode as CollectedMode;
  if (!Object.values(CollectedMode).includes(mode)) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Choose how the customer paid: cash, UPI or already paid' });
    return;
  }
  const amount = mode === CollectedMode.Prepaid ? 0 : Number(req.body?.amount);
  if (mode !== CollectedMode.Prepaid && !(amount > 0)) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Enter the amount collected' });
    return;
  }

  const before = order.delivery ? { ...order.delivery } : undefined;
  order.delivery = {
    ...(order.delivery ?? {}),
    status: DeliveryStatus.Delivered,
    outAt: order.delivery?.outAt ?? new Date(),
    deliveredAt: new Date(),
    riderId: req.user!.id,
    riderName: req.user!.name,
    collectedMode: mode,
    collectedAmount: amount,
  };
  await order.save();
  await audit(req, 'delivery_delivered', order, before);
  emitOrderUpdated(order.waiterId.toString(), order);
  res.json({ message: `Order #${order.number} delivered`, delivery: order.delivery });
};

/** POST /delivery/orders/:id/undo — step back once (mis-tap). Not allowed once the bill is settled from a collection. */
export const undoDelivery = async (req: Request, res: Response): Promise<void> => {
  const order = await findDeliveryOrder(req, res);
  if (!order) return;
  const before = order.delivery ? { ...order.delivery } : undefined;
  const status = order.delivery?.status ?? DeliveryStatus.Waiting;

  if (status === DeliveryStatus.Delivered) {
    if (order.status === OrderStatus.Paid && order.delivery?.collectedMode !== CollectedMode.Prepaid) {
      res.status(409).json({ code: 'ALREADY_SETTLED', message: 'The cashier has already settled this bill' });
      return;
    }
    order.delivery = {
      ...(order.delivery ?? {}),
      status: DeliveryStatus.Out,
      deliveredAt: undefined,
      collectedMode: undefined,
      collectedAmount: undefined,
    };
  } else if (status === DeliveryStatus.Out) {
    order.delivery = { ...(order.delivery ?? {}), status: DeliveryStatus.Waiting, outAt: undefined };
  } else {
    res.status(409).json({ code: 'NOTHING_TO_UNDO', message: 'Nothing to undo' });
    return;
  }
  order.markModified('delivery');
  await order.save();
  await audit(req, 'delivery_undone', order, before);
  emitOrderUpdated(order.waiterId.toString(), order);
  res.json({ message: 'Undone', delivery: order.delivery });
};
