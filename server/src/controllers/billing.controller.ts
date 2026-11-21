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
import { BillStatus, DiscountType, ItemStatus, OrderStatus, PaymentMode, TableStatus } from '../types';

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

export const generateBill = async (req: Request, res: Response): Promise<void> => {
  const { id: orderId } = req.params;
  const userId = req.user!.id;

  const order = await Order.findById(orderId).populate('tableId', 'name number floor');
  if (!order) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
    return;
  }

  // Check if an open bill already exists for this order
  let existingBill = await Bill.findOne({ orderId: order._id, status: BillStatus.Open });
  if (existingBill) {
    res.json({ bill: existingBill, message: 'Existing open bill retrieved' });
    return;
  }

  // Active items only (exclude cancelled items)
  const activeItems = order.items.filter((i) => i.status === ItemStatus.Active);
  if (activeItems.length === 0) {
    res.status(400).json({ code: 'NO_ACTIVE_ITEMS', message: 'Every item on this order was cancelled — close the order instead of billing it' });
    return;
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

  // Set order status to billed
  order.status = OrderStatus.Billed;
  await order.save();

  // If table, set table status to billing
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

  res.status(201).json({ bill, order });
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

  // Queue bill on the counter printer (persisted; survives agent downtime)
  const settings = await Settings.findOne().select('billPrinterIp').lean();
  await PrintService.enqueue('bill', settings?.billPrinterIp || '192.168.1.100', await buildBillPrintPayload(bill));

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
    await buildBillPrintPayload(bill, true, req.user?.name),
  );

  await AuditLog.create({
    action: 'bill_reprinted',
    userId: req.user?.id,
    entity: 'Bill',
    entityId: bill._id,
  });

  res.json({ message: 'Bill reprint dispatched to cashier counter printer' });
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
