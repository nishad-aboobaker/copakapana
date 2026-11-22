import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { AuditLog } from '../models/AuditLog';
import { Bill } from '../models/Bill';
import { Counter } from '../models/Counter';
import { Customer } from '../models/Customer';
import { Ticket } from '../models/Ticket';
import { MenuItem } from '../models/MenuItem';
import { IOrder, IOrderItemDocument, Order } from '../models/Order';
import { Table } from '../models/Table';
import { TicketService } from '../services/ticket.service';
import { emitOrderUpdated, emitTableUpdated } from '../socket';
import { ItemStatus, OrderStatus, OrderType, Role, TableStatus } from '../types';

/** Waiters may only touch orders they opened (PRD permission rule). */
const canAccessOrder = (req: Request, order: IOrder): boolean =>
  req.user?.role !== Role.Waiter || order.waiterId.toString() === req.user.id;

export const createOrder = async (req: Request, res: Response): Promise<void> => {
  const { type, tableId, customerSnapshot, items, clientRequestId } = req.body;
  const waiterId = new mongoose.Types.ObjectId(req.user!.id);

  // 1. Idempotency check with clientRequestId
  if (clientRequestId) {
    const existingOrder = await Order.findOne({ clientRequestId })
      .populate('tableId', 'name number floor')
      .populate('waiterId', 'name');
    if (existingOrder) {
      res.json({ order: existingOrder, isDuplicate: true });
      return;
    }
  }

  // 2. Validate order type requirements
  if (!type || !Object.values(OrderType).includes(type)) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Valid order type is required' });
    return;
  }

  let table: any = null;
  if (type === OrderType.DineIn) {
    if (!tableId) {
      res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Table is required for Dine-In orders' });
      return;
    }
    table = await Table.findById(tableId);
    if (!table || !table.active) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Table not found or inactive' });
      return;
    }
    // A table with an open or billing (billed, unpaid) order cannot take a new one
    const openOrderOnTable = await Order.findOne({
      tableId,
      status: { $in: [OrderStatus.Open, OrderStatus.Billed] },
    });
    if (openOrderOnTable) {
      res.status(409).json({ code: 'TABLE_OCCUPIED', message: `Table ${table.name || table.number} already has an open order` });
      return;
    }
  } else if (type === OrderType.Takeaway) {
    if (!customerSnapshot?.name || !customerSnapshot?.phone) {
      res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Customer name and phone required for takeaway' });
      return;
    }
  } else if (type === OrderType.Delivery) {
    if (!customerSnapshot?.name || !customerSnapshot?.phone || !customerSnapshot?.address) {
      res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Customer name, phone, and address required for delivery' });
      return;
    }
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Order must contain at least one item' });
    return;
  }

  // 3. Snapshot items from current menu state
  const snapshottedItems: Partial<IOrderItemDocument>[] = [];
  for (const itemReq of items) {
    const menuItem = await MenuItem.findById(itemReq.menuItemId);
    if (!menuItem || !menuItem.active || !menuItem.available) {
      res.status(400).json({
        code: 'ITEM_UNAVAILABLE',
        message: `Item ${menuItem ? menuItem.name : itemReq.menuItemId} is currently unavailable`,
      });
      return;
    }

    let finalPrice = menuItem.price;
    if (itemReq.portion && menuItem.portions?.length) {
      const matchPortion = menuItem.portions.find((p) => p.label === itemReq.portion);
      if (matchPortion) finalPrice = matchPortion.price;
    }

    snapshottedItems.push({
      menuItemId: menuItem._id.toString(),
      name: menuItem.name,
      price: finalPrice,
      qty: Number(itemReq.qty) || 1,
      portion: itemReq.portion,
      note: itemReq.note,
      station: menuItem.station,
      status: ItemStatus.Active,
    });
  }

  // 4. Generate daily order sequence number
  const orderNumber = await Counter.nextSeq('order');

  // 4b. Customer auto-create/update for takeaway or delivery
  let customerId: mongoose.Types.ObjectId | undefined;
  if (customerSnapshot?.phone) {
    const phone = customerSnapshot.phone.trim();
    let customer = await Customer.findOne({ phone });
    if (customer) {
      customer.orderCount += 1;
      customer.lastOrderAt = new Date();
      if (customerSnapshot.name) customer.name = customerSnapshot.name.trim();
      if (customerSnapshot.address) {
        const addrText = customerSnapshot.address.trim();
        const exists = customer.addresses.some((a) => a.text.toLowerCase() === addrText.toLowerCase());
        if (!exists) {
          customer.addresses.push({ text: addrText, isDefault: customer.addresses.length === 0 });
          if (customer.addresses.length > 5) {
            customer.addresses.shift(); // keep max 5
          }
        }
      }
      await customer.save();
      customerId = customer._id as mongoose.Types.ObjectId;
    } else {
      const addresses = customerSnapshot.address
        ? [{ text: customerSnapshot.address.trim(), isDefault: true }]
        : [];
      customer = await Customer.create({
        phone,
        name: customerSnapshot.name?.trim() || 'Guest',
        addresses,
        orderCount: 1,
        lastOrderAt: new Date(),
      });
      customerId = customer._id as mongoose.Types.ObjectId;
    }
  }

  // 5. Create Order (unique clientRequestId index catches concurrent retries)
  let order: IOrder;
  try {
    order = await Order.create({
      number: orderNumber,
      type,
      tableId: table ? table._id : undefined,
      waiterId,
      customerId,
      customerSnapshot,
      status: OrderStatus.Open,
      items: snapshottedItems,
      clientRequestId,
    });
  } catch (err: any) {
    if (err?.code === 11000 && clientRequestId) {
      const existing = await Order.findOne({ clientRequestId });
      if (existing) {
        res.json({ order: existing, isDuplicate: true });
        return;
      }
    }
    throw err;
  }

  // 6. Update Table status to occupied if Dine-In
  if (table) {
    table.status = TableStatus.Occupied;
    await table.save();
    emitTableUpdated(table);
  }

  // 7. Generate initial tickets → pushed live to each station screen
  const tickets = await TicketService.generateInitialTickets(order, order.items, waiterId);

  // 8. Audit & WebSockets
  await AuditLog.create({
    action: 'order_created',
    userId: waiterId,
    entity: 'Order',
    entityId: order._id,
    after: { number: order.number, type: order.type, itemsCount: order.items.length },
  });

  emitOrderUpdated(waiterId.toString(), order);

  res.status(201).json({ order, tickets });
};

export const listOrders = async (req: Request, res: Response): Promise<void> => {
  const { status, type, tableId } = req.query;
  const filter: Record<string, unknown> = {};

  // status may be a comma-separated list, e.g. ?status=open,billed
  if (typeof status === 'string' && status) {
    const list = status.split(',').map((x) => x.trim()).filter((x) => (Object.values(OrderStatus) as string[]).includes(x));
    if (list.length) filter.status = list.length === 1 ? list[0] : { $in: list };
  }
  if (type) filter.type = type;
  if (tableId) filter.tableId = tableId;

  // Waiter sees only their own orders unless cashier/manager/owner
  if (req.user?.role === 'waiter') {
    filter.waiterId = req.user.id;
  }

  const orders = await Order.find(filter)
    .populate('tableId', 'name number floor capacity status')
    .populate('waiterId', 'name role')
    .sort({ createdAt: -1 });

  res.json({ orders });
};

export const getOrder = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const order = await Order.findById(id)
    .populate('tableId', 'name number floor capacity status')
    .populate('waiterId', 'name role');

  if (!order) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
    return;
  }
  if (!canAccessOrder(req, { waiterId: (order.waiterId as any)?._id ?? order.waiterId } as IOrder)) {
    res.status(403).json({ code: 'FORBIDDEN', message: 'You can only view your own orders' });
    return;
  }

  const tickets = await Ticket.find({ orderId: order._id }).sort({ createdAt: 1 });
  // Latest bill (if any) — only for cashier and above
  const bill =
    req.user?.role === Role.Waiter ? null : await Bill.findOne({ orderId: order._id }).sort({ createdAt: -1 });

  res.json({ order, tickets, bill });
};

export const addItemsToOrder = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { items, clientRequestId } = req.body;
  const userId = new mongoose.Types.ObjectId(req.user!.id);

  const order = await Order.findById(id);
  if (!order) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
    return;
  }
  if (!canAccessOrder(req, order)) {
    res.status(403).json({ code: 'FORBIDDEN', message: 'You can only edit your own orders' });
    return;
  }
  // Idempotency: an offline-queue retry of an already-applied add is a no-op
  if (clientRequestId && order.appliedRequestIds?.includes(clientRequestId)) {
    res.json({ order, editedTickets: [], isDuplicate: true });
    return;
  }
  if (order.status !== OrderStatus.Open) {
    res.status(400).json({ code: 'ORDER_NOT_OPEN', message: 'Order is not in open status' });
    return;
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Items array is required' });
    return;
  }

  const newlyAddedItems: Partial<IOrderItemDocument>[] = [];
  for (const itemReq of items) {
    const menuItem = await MenuItem.findById(itemReq.menuItemId);
    if (!menuItem || !menuItem.active || !menuItem.available) {
      res.status(400).json({ code: 'ITEM_UNAVAILABLE', message: `Item ${itemReq.menuItemId} is unavailable` });
      return;
    }

    let finalPrice = menuItem.price;
    if (itemReq.portion && menuItem.portions?.length) {
      const matchPortion = menuItem.portions.find((p) => p.label === itemReq.portion);
      if (matchPortion) finalPrice = matchPortion.price;
    }

    const snapItem = {
      menuItemId: menuItem._id.toString(),
      name: menuItem.name,
      price: finalPrice,
      qty: Number(itemReq.qty) || 1,
      portion: itemReq.portion,
      note: itemReq.note,
      station: menuItem.station,
      status: ItemStatus.Active,
    };

    order.items.push(snapItem as IOrderItemDocument);
    newlyAddedItems.push(snapItem);
  }

  if (clientRequestId) order.appliedRequestIds.push(clientRequestId);
  await order.save();

  // EDITED ticket (ADD lines) on each affected station screen
  const addedDocList = order.items.slice(order.items.length - newlyAddedItems.length);
  const editedTickets = await TicketService.generateEditedTickets(order, addedDocList, [], userId);

  await AuditLog.create({
    action: 'order_items_added',
    userId,
    entity: 'Order',
    entityId: order._id,
    after: { addedCount: newlyAddedItems.length },
  });

  emitOrderUpdated(order.waiterId.toString(), order);

  res.json({ order, editedTickets });
};

export const cancelOrderItem = async (req: Request, res: Response): Promise<void> => {
  const { id, itemId } = req.params;
  const userId = new mongoose.Types.ObjectId(req.user!.id);

  const order = await Order.findById(id);
  if (!order || order.status !== OrderStatus.Open) {
    res.status(400).json({ code: 'ORDER_NOT_OPEN', message: 'Order is not open' });
    return;
  }
  if (!canAccessOrder(req, order)) {
    res.status(403).json({ code: 'FORBIDDEN', message: 'You can only edit your own orders' });
    return;
  }

  const itemToCancel = order.items.find((i) => i._id.toString() === itemId && i.status === ItemStatus.Active);
  if (!itemToCancel) {
    res.status(404).json({ code: 'ITEM_NOT_FOUND', message: 'Active item not found on order' });
    return;
  }

  itemToCancel.status = ItemStatus.Cancelled;
  await order.save();

  // EDITED ticket (CANCEL line) on the item's station screen
  const editedTickets = await TicketService.generateEditedTickets(order, [], [itemToCancel], userId);

  await AuditLog.create({
    action: 'order_item_cancelled',
    userId,
    entity: 'Order',
    entityId: order._id,
    before: { itemId, itemName: itemToCancel.name, status: 'active' },
    after: { itemId, itemName: itemToCancel.name, status: 'cancelled' },
  });

  emitOrderUpdated(order.waiterId.toString(), order);

  res.json({ order, editedTickets });
};

export const transferOrder = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { targetTableId } = req.body;
  const userId = new mongoose.Types.ObjectId(req.user!.id);

  const order = await Order.findById(id);
  if (!order || order.status !== OrderStatus.Open || !order.tableId) {
    res.status(400).json({ code: 'INVALID_ORDER', message: 'Only open Dine-In orders can be transferred' });
    return;
  }

  const sourceTable = await Table.findById(order.tableId);
  const targetTable = await Table.findById(targetTableId);

  if (!targetTable || !targetTable.active) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Target table not found or inactive' });
    return;
  }

  const existingOnTarget = await Order.findOne({ tableId: targetTable._id, status: OrderStatus.Open });
  if (existingOnTarget) {
    res.status(409).json({ code: 'TARGET_OCCUPIED', message: `Target table ${targetTable.name || targetTable.number} is occupied` });
    return;
  }

  // Update order table reference
  const oldTableId = order.tableId;
  order.tableId = targetTable._id as mongoose.Types.ObjectId;
  await order.save();

  // Free source table
  if (sourceTable) {
    sourceTable.status = TableStatus.Free;
    await sourceTable.save();
    emitTableUpdated(sourceTable);
  }

  // Occupy target table
  targetTable.status = TableStatus.Occupied;
  await targetTable.save();
  emitTableUpdated(targetTable);

  await AuditLog.create({
    action: 'order_transferred',
    userId,
    entity: 'Order',
    entityId: order._id,
    before: { tableId: oldTableId },
    after: { tableId: targetTable._id },
  });

  emitOrderUpdated(order.waiterId.toString(), order);

  res.json({ order, message: `Order transferred to Table ${targetTable.name || targetTable.number}` });
};

export const mergeOrders = async (req: Request, res: Response): Promise<void> => {
  const { sourceOrderId, targetOrderId } = req.body;
  const userId = new mongoose.Types.ObjectId(req.user!.id);

  const sourceOrder = await Order.findById(sourceOrderId);
  const targetOrder = await Order.findById(targetOrderId);

  if (!sourceOrder || !targetOrder || sourceOrder.status !== OrderStatus.Open || targetOrder.status !== OrderStatus.Open) {
    res.status(400).json({ code: 'INVALID_ORDERS', message: 'Both orders must be in open status to merge' });
    return;
  }

  // Copy active items from source into target
  const activeItemsFromSource = sourceOrder.items.filter((i) => i.status === ItemStatus.Active);
  for (const item of activeItemsFromSource) {
    targetOrder.items.push(item);
  }
  await targetOrder.save();

  // Mark source order cancelled / merged
  sourceOrder.status = OrderStatus.Cancelled;
  await sourceOrder.save();

  // Free the source table — its items now live on the target order
  if (sourceOrder.tableId && String(sourceOrder.tableId) !== String(targetOrder.tableId)) {
    const sourceTable = await Table.findById(sourceOrder.tableId);
    if (sourceTable) {
      sourceTable.status = TableStatus.Free;
      await sourceTable.save();
      emitTableUpdated(sourceTable);
    }
  }

  await AuditLog.create({
    action: 'orders_merged',
    userId,
    entity: 'Order',
    entityId: targetOrder._id,
    before: { mergedFrom: sourceOrder._id },
  });

  emitOrderUpdated(targetOrder.waiterId.toString(), targetOrder);
  emitOrderUpdated(sourceOrder.waiterId.toString(), sourceOrder);

  res.json({ targetOrder, message: 'Orders successfully merged' });
};

/**
 * POST /orders/:id/cancel { reason? }
 * Closes an order that won't be billed and frees its table.
 *  - Nothing left to bill (every item cancelled): the owning waiter or any cashier+ may close it.
 *  - Items still active: cashier or higher only, with a reason; the remaining items are
 *    cancelled and the kitchen screens receive CANCEL tickets.
 * Billed orders must be voided/settled through billing instead.
 */
export const cancelOrder = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  const userId = new mongoose.Types.ObjectId(req.user!.id);

  if (!mongoose.isValidObjectId(id)) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
    return;
  }
  const order = await Order.findById(id);
  if (!order) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
    return;
  }
  if (order.status !== OrderStatus.Open) {
    res.status(409).json({
      code: 'ORDER_NOT_OPEN',
      message: order.status === OrderStatus.Billed ? 'This order has a bill — settle or void it instead' : 'Order is already closed',
    });
    return;
  }

  const active = order.items.filter((i) => i.status === ItemStatus.Active);
  const isStaffAbove = req.user?.role !== Role.Waiter;

  if (!isStaffAbove) {
    if (!canAccessOrder(req, order)) {
      res.status(403).json({ code: 'FORBIDDEN', message: 'You can only close your own orders' });
      return;
    }
    if (active.length > 0) {
      res.status(403).json({ code: 'FORBIDDEN', message: 'Cancel the remaining items first, or ask the cashier to cancel the order' });
      return;
    }
  } else if (active.length > 0 && !reason) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'A reason is required to cancel an order with items' });
    return;
  }

  // Cancel whatever is still active and tell the kitchen
  if (active.length) {
    active.forEach((i) => (i.status = ItemStatus.Cancelled));
  }
  order.status = OrderStatus.Cancelled;
  await order.save();
  if (active.length) await TicketService.generateEditedTickets(order, [], active, userId);

  // Free the table (only if no other open order holds it)
  if (order.tableId) {
    const table = await Table.findById(order.tableId);
    const otherOpen = await Order.exists({
      _id: { $ne: order._id },
      tableId: order.tableId,
      status: { $in: [OrderStatus.Open, OrderStatus.Billed] },
    });
    if (table && !otherOpen && table.status !== TableStatus.Free) {
      table.status = TableStatus.Free;
      await table.save();
      emitTableUpdated(table);
    }
  }

  await AuditLog.create({
    action: 'order_cancelled',
    userId,
    entity: 'Order',
    entityId: order._id,
    before: { status: 'open', activeItems: active.length },
    after: { status: 'cancelled', reason: reason || (active.length ? undefined : 'No items left to bill') },
  });

  emitOrderUpdated(order.waiterId.toString(), order);
  res.json({ order, message: `Order #${order.number} closed` });
};
