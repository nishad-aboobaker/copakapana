import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { AuditLog } from '../models/AuditLog';
import { Bill, IBillItemSnapshot } from '../models/Bill';
import { Counter } from '../models/Counter';
import { Order } from '../models/Order';
import { Settings } from '../models/Settings';
import { Table } from '../models/Table';
import { PrintService } from '../services/print.service';
import { emitOrderUpdated, emitTableUpdated } from '../socket';
import { IBill } from '../models/Bill';
import { BillStatus, DiscountType, ItemStatus, OrderStatus, PaymentMode, Role, TableStatus } from '../types';

const FLOOR_LABEL: Record<string, string> = { ground: 'Ground Floor', first: 'First Floor' };

/** Full bill payload for the counter printer (PRD bill layout). */
/** "9072211810, 9072211820" or one per line → ['9072211810', '9072211820'] */
const splitPhones = (raw?: string): string[] =>
  (raw ?? '')
    .split(/[,\n;/]+/)
    .map((p) => p.trim())
    .filter(Boolean);

const buildBillPrintPayload = async (
  bill: IBill,
  isReprint = false,
  fallbackCashier?: string,
): Promise<Record<string, unknown>> => {
  const settings = await Settings.findOne().lean();
  const order = await Order.findById(bill.orderId).populate('tableId', 'name number floor').lean();
  const table = (order?.tableId as any) || null;
  return {
    isReprint,
    restaurantName: settings?.restaurantName,
    address: settings?.address,
    phone: settings?.phone,
    phones: splitPhones(settings?.phone),
    printLogo: !!settings?.printLogo,
    footer: settings?.billFooter ?? '***Thanks for visiting***',
    footerNote: settings?.billFooterNote ?? '',
    cashierName: bill.closedByName || fallbackCashier || '',
    number: bill.number,
    date: (bill.paidAt || bill.createdAt || new Date()).toISOString(),
    orderNumber: order?.number,
    orderType: order?.type,
    tableName: table ? table.name || table.number : undefined,
    floor: table ? FLOOR_LABEL[table.floor] || table.floor : undefined,
    customer: order?.type !== 'dine_in' ? order?.customerSnapshot : undefined,
    itemsSnapshot: bill.itemsSnapshot,
    subtotal: bill.subtotal,
    discountAmount: bill.discountAmount,
    discount: bill.discount,
    gst: bill.gst,
    gstEnabled: settings?.gstEnabled,
    serviceCharge: bill.serviceCharge,
    serviceChargeEnabled: settings?.serviceChargeEnabled,
    total: bill.total,
    payments: bill.payments,
  };
};

/** Delivery-bill payload: customer block + amount the rider collects (or PAID). */
const buildDeliveryPayload = async (bill: IBill, fallbackCashier?: string) => {
  const paid = bill.status === BillStatus.Paid;
  const paidSoFar = (bill.payments ?? []).reduce((sum, p) => sum + (p.amount || 0), 0);
  const amountDue = paid ? 0 : Math.max(0, bill.total - paidSoFar);
  const payload = {
    ...(await buildBillPrintPayload(bill, false, fallbackCashier)),
    deliveryBill: true,
    amountDue,
    payments: paid ? bill.payments : [],
  };
  return { payload, amountDue };
};

/** Queues the bill on the counter printer — the delivery layout for delivery orders. */
const enqueueBillPrint = async (bill: IBill, orderType: string | undefined, printedBy?: string): Promise<void> => {
  const settings = await Settings.findOne().select('billPrinterIp').lean();
  const payload =
    orderType === 'delivery'
      ? (await buildDeliveryPayload(bill, printedBy)).payload
      : await buildBillPrintPayload(bill, false, printedBy);
  await PrintService.enqueue('bill', settings?.billPrinterIp || '192.168.1.100', payload);
};

type BillResult = { ok: true; bill: IBill; order: any; created: boolean } | { ok: false; status: number; code: string; message: string };

/** Creates the open bill for an order (or returns the existing open one), marks the order billed. */
const createBillForOrder = async (orderId: string, userId: string): Promise<BillResult> => {
  const order = await Order.findById(orderId).catch(() => null);
  if (!order) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Order not found' };

  const existingBill = await Bill.findOne({ orderId: order._id, status: BillStatus.Open });
  if (existingBill) return { ok: true, bill: existingBill, order, created: false };

  if (order.status !== OrderStatus.Open && order.status !== OrderStatus.Billed) {
    return { ok: false, status: 409, code: 'ORDER_CLOSED', message: 'This order is already closed' };
  }

  // Active items only (exclude cancelled items)
  const activeItems = order.items.filter((i) => i.status === ItemStatus.Active);
  if (activeItems.length === 0) {
    return { ok: false, status: 400, code: 'NO_ACTIVE_ITEMS', message: 'Every item on this order was cancelled — close the order instead of billing it' };
  }

  const itemsSnapshot: IBillItemSnapshot[] = activeItems.map((item) => ({
    menuItemId: item.menuItemId,
    name: item.name,
    price: item.price,
    qty: item.qty,
    portion: item.portion,
    note: item.note,
    station: item.station,
  }));

  const subtotal = itemsSnapshot.reduce((sum, item) => sum + item.price * item.qty, 0);

  const settings = await Settings.findOne();
  const gst = settings?.gstEnabled ? Math.round((subtotal * (settings.gstRate || 0)) / 100) : 0;
  const serviceCharge = settings?.serviceChargeEnabled
    ? Math.round((subtotal * (settings.serviceChargePercent || 0)) / 100)
    : 0;

  const total = subtotal + gst + serviceCharge;

  // Continuous bill sequence (never resets)
  const billNumber = await Counter.nextSeq('bill_continuous', 'continuous');

  const bill = await Bill.create({
    number: billNumber,
    orderId: order._id,
    itemsSnapshot,
    subtotal,
    discountAmount: 0,
    gst,
    serviceCharge,
    total,
    payments: [],
    status: BillStatus.Open,
  });

  order.status = OrderStatus.Billed;
  await order.save();

  if (order.tableId) {
    const table = await Table.findById(order.tableId);
    if (table) {
      table.status = TableStatus.Billing;
      await table.save();
      emitTableUpdated(table);
    }
  }

  await AuditLog.create({
    action: 'bill_generated',
    userId: new mongoose.Types.ObjectId(userId),
    entity: 'Bill',
    entityId: bill._id,
    after: { number: bill.number, total: bill.total },
  });

  emitOrderUpdated(order.waiterId.toString(), order);

  return { ok: true, bill, order, created: true };
};

export const generateBill = async (req: Request, res: Response): Promise<void> => {
  const result = await createBillForOrder(req.params.id, req.user!.id);
  if (!result.ok) {
    res.status(result.status).json({ code: result.code, message: result.message });
    return;
  }
  if (!result.created) {
    res.json({ bill: result.bill, message: 'Existing open bill retrieved' });
    return;
  }
  // The bill prints as soon as it is generated; settling later only records the payment.
  await enqueueBillPrint(result.bill, result.order.type, req.user?.name);
  res.status(201).json({ bill: result.bill, order: result.order });
};

/**
 * POST /orders/:id/print-bill — the waiter prints the bill for the table on the counter printer.
 * Generates the bill if it doesn't exist yet; pressing it again prints another copy.
 * Payment is still taken and settled at the billing desk.
 */
export const printOrderBill = async (req: Request, res: Response): Promise<void> => {
  const order = await Order.findById(req.params.id).select('waiterId').lean().catch(() => null);
  if (!order) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
    return;
  }
  if (req.user?.role === Role.Waiter && order.waiterId.toString() !== req.user.id) {
    res.status(403).json({ code: 'FORBIDDEN', message: 'You can only print the bill for your own orders' });
    return;
  }

  const result = await createBillForOrder(req.params.id, req.user!.id);
  if (!result.ok) {
    res.status(result.status).json({ code: result.code, message: result.message });
    return;
  }

  await enqueueBillPrint(result.bill, result.order.type, req.user?.name);

  await AuditLog.create({
    action: 'bill_printed_by_waiter',
    userId: req.user?.id,
    entity: 'Bill',
    entityId: result.bill._id,
    after: { number: result.bill.number, total: result.bill.total },
  });

  res.status(result.created ? 201 : 200).json({ bill: result.bill, order: result.order });
};

export const applyDiscount = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { type, value, reason } = req.body;
  const userId = req.user!.id;

  if (!type || value === undefined || !reason?.trim()) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Type, positive value, and reason are required' });
    return;
  }

  const bill = await Bill.findById(id);
  if (!bill || bill.status !== BillStatus.Open) {
    res.status(400).json({ code: 'BILL_NOT_OPEN', message: 'Bill is not in open status' });
    return;
  }

  let discountAmount = 0;
  if (type === DiscountType.Flat) {
    discountAmount = Math.min(bill.subtotal, Number(value));
  } else if (type === DiscountType.Percent) {
    discountAmount = Math.min(bill.subtotal, Math.round((bill.subtotal * Number(value)) / 100));
  }

  bill.discount = {
    type,
    value: Number(value),
    reason: reason.trim(),
    appliedBy: req.user!.name,
    appliedAt: new Date(),
  };

  bill.discountAmount = discountAmount;
  bill.total = Math.max(0, bill.subtotal - discountAmount + bill.gst + bill.serviceCharge);

  await bill.save();

  await AuditLog.create({
    action: 'discount_applied',
    userId: new mongoose.Types.ObjectId(userId),
    entity: 'Bill',
    entityId: bill._id,
    after: { discountAmount, reason, newTotal: bill.total },
  });

  res.json({ bill });
};

export const recordPayments = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { payments } = req.body;

  if (!payments || !Array.isArray(payments) || payments.length === 0) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Valid payments array is required' });
    return;
  }

  const bill = await Bill.findById(id);
  if (!bill || bill.status !== BillStatus.Open) {
    res.status(400).json({ code: 'BILL_NOT_OPEN', message: 'Bill is not open' });
    return;
  }

  if (payments.some((p: any) => !Object.values(PaymentMode).includes(p?.mode) || !(Number(p?.amount) > 0))) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Each payment needs mode cash or upi and a positive amount' });
    return;
  }

  bill.payments = payments.map((p) => {
    const amount = Number(p.amount) || 0;
    const tendered = p.tendered !== undefined ? Number(p.tendered) : amount;
    const change = Math.max(0, tendered - amount);
    return {
      mode: p.mode,
      amount,
      tendered,
      change,
    };
  });

  await bill.save();
  res.json({ bill });
};

export const closeBill = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const userId = req.user!.id;

  const bill = await Bill.findById(id);
  if (!bill || bill.status !== BillStatus.Open) {
    res.status(400).json({ code: 'BILL_NOT_OPEN', message: 'Bill is not open' });
    return;
  }

  const totalPaid = (bill.payments || []).reduce((sum, p) => sum + p.amount, 0);
  if (totalPaid < bill.total) {
    res.status(400).json({
      code: 'INSUFFICIENT_PAYMENT',
      message: `Total payment recorded (₹${totalPaid}) is less than bill total (₹${bill.total})`,
    });
    return;
  }

  bill.status = BillStatus.Paid;
  bill.paidAt = new Date();
  bill.closedBy = new mongoose.Types.ObjectId(userId);
  bill.closedByName = req.user!.name;
  await bill.save();

  // Mark Order as Paid
  const order = await Order.findById(bill.orderId);
  if (order) {
    order.status = OrderStatus.Paid;
    await order.save();

    // Automatically free the table
    if (order.tableId) {
      const table = await Table.findById(order.tableId);
      if (table) {
        table.status = TableStatus.Free;
        await table.save();
        emitTableUpdated(table);
      }
    }

    emitOrderUpdated(order.waiterId.toString(), order);
  }

  // No print here: the bill was printed when it was generated. "Settle & save" only records payment.

  await AuditLog.create({
    action: 'bill_closed',
    userId: new mongoose.Types.ObjectId(userId),
    entity: 'Bill',
    entityId: bill._id,
    after: { total: bill.total, paidAt: bill.paidAt },
  });

  res.json({ bill, message: 'Bill paid and closed successfully' });
};

export const voidBill = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { voidReason } = req.body;
  const userId = new mongoose.Types.ObjectId(req.user!.id);

  if (!voidReason?.trim()) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Void reason is mandatory' });
    return;
  }

  const bill = await Bill.findById(id);
  if (!bill || bill.status !== BillStatus.Paid) {
    res.status(400).json({ code: 'INVALID_BILL', message: 'Only paid bills can be voided' });
    return;
  }

  const before = bill.toObject();

  bill.status = BillStatus.Void;
  bill.voidedBy = userId;
  bill.voidReason = voidReason.trim();
  await bill.save();

  // Re-open order — unless its table has since been given to a new order
  const order = await Order.findById(bill.orderId);
  if (order) {
    const tableTaken = order.tableId
      ? await Order.exists({
          _id: { $ne: order._id },
          tableId: order.tableId,
          status: { $in: [OrderStatus.Open, OrderStatus.Billed] },
        })
      : null;
    if (tableTaken) {
      // Keep the voided order off the table; it stays reviewable in history
      order.status = OrderStatus.Cancelled;
      await order.save();
      emitOrderUpdated(order.waiterId.toString(), order);
    } else {
    order.status = OrderStatus.Open;
    await order.save();

    // Set table back to occupied
    if (order.tableId) {
      const table = await Table.findById(order.tableId);
      if (table) {
        table.status = TableStatus.Occupied;
        await table.save();
        emitTableUpdated(table);
      }
    }

    emitOrderUpdated(order.waiterId.toString(), order);
    }
  }

  await AuditLog.create({
    action: 'bill_voided',
    userId,
    entity: 'Bill',
    entityId: bill._id,
    before,
    after: { status: 'void', voidReason: bill.voidReason },
  });

  res.json({ bill, message: 'Bill voided and order reopened' });
};

export const reprintBill = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const bill = await Bill.findById(id);

  if (!bill) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Bill not found' });
    return;
  }

  const settings = await Settings.findOne().select('billPrinterIp').lean();
  await PrintService.enqueue(
    'bill',
    settings?.billPrinterIp || '192.168.1.100',
    await buildBillPrintPayload(bill, bill.status !== BillStatus.Open, req.user?.name),
  );

  await AuditLog.create({
    action: 'bill_reprinted',
    userId: req.user?.id,
    entity: 'Bill',
    entityId: bill._id,
  });

  res.json({ message: 'Bill reprint dispatched to cashier counter printer' });
};

/**
 * POST /bills/:id/delivery-bill — slip that goes out with the delivery rider: customer name,
 * phone and address in large print, the items, and the amount the rider must collect
 * (or PAID when the customer has already paid). Works for open or paid delivery bills.
 */
export const printDeliveryBill = async (req: Request, res: Response): Promise<void> => {
  const bill = await Bill.findById(req.params.id);
  if (!bill) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Bill not found' });
    return;
  }
  const order = await Order.findById(bill.orderId).select('type').lean();
  if (order?.type !== 'delivery') {
    res.status(400).json({ code: 'NOT_DELIVERY', message: 'Delivery bills are only for delivery orders' });
    return;
  }
  if (bill.status === BillStatus.Void) {
    res.status(409).json({ code: 'BILL_VOID', message: 'This bill was voided' });
    return;
  }

  const { payload, amountDue } = await buildDeliveryPayload(bill, req.user?.name);
  const settings = await Settings.findOne().select('billPrinterIp').lean();
  await PrintService.enqueue('bill', settings?.billPrinterIp || '192.168.1.100', payload);

  await AuditLog.create({
    action: 'delivery_bill_printed',
    userId: req.user?.id,
    entity: 'Bill',
    entityId: bill._id,
    after: { amountDue },
  });

  res.json({ message: 'Delivery bill sent to the printer', amountDue });
};

export const getBill = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const bill = await Bill.findById(id).populate('orderId');
  if (!bill) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Bill not found' });
    return;
  }
  res.json({ bill });
};
