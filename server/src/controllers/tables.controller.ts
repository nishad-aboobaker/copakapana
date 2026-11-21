import { Request, Response } from 'express';
import { AuditLog } from '../models/AuditLog';
import { Order } from '../models/Order';
import { Table } from '../models/Table';
import { emitTableUpdated, emitToStaff } from '../socket';
import { OrderStatus, Role, TableFloor, TableStatus } from '../types';

export const listTables = async (req: Request, res: Response): Promise<void> => {
  // ?all=1 (owner only) includes disabled tables so they can be re-enabled
  const includeInactive = req.query.all === '1' && req.user?.role === Role.Owner;
  const tables = await Table.find(includeInactive ? {} : { active: true }).sort({ floor: 1, name: 1, number: 1 });

  const ground = tables.filter((t) => t.floor === TableFloor.Ground);
  const first = tables.filter((t) => t.floor === TableFloor.First);

  res.json({
    tables,
    byFloor: {
      ground,
      first,
    },
  });
};

export const createTable = async (req: Request, res: Response): Promise<void> => {
  const { name, number, floor, capacity } = req.body;
  const rawIdentifier = (name || number || '').toString().trim();

  if (!rawIdentifier || !floor || !capacity) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Table name/number, floor, and capacity are required' });
    return;
  }

  // Check for duplicate name/number (case-insensitive)
  const existing = await Table.findOne({
    $or: [
      { name: { $regex: new RegExp(`^${rawIdentifier}$`, 'i') } },
      { number: rawIdentifier },
    ],
  });
  if (existing) {
    res.status(409).json({ code: 'DUPLICATE_TABLE', message: `Table "${rawIdentifier}" already exists` });
    return;
  }

  const table = await Table.create({
    name: rawIdentifier,
    number: rawIdentifier,
    floor,
    capacity: Number(capacity),
  });

  await AuditLog.create({
    action: 'table_created',
    userId: req.user?.id,
    entity: 'Table',
    entityId: table._id,
    after: { name: table.name, number: table.number, floor: table.floor, capacity: table.capacity },
  });

  emitTableUpdated(table);

  res.status(201).json({ table });
};

export const updateTable = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { name, number, floor, capacity, active } = req.body;

  const table = await Table.findById(id);
  if (!table) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Table not found' });
    return;
  }

  const before = {
    name: table.name,
    number: table.number,
    floor: table.floor,
    capacity: table.capacity,
    active: table.active,
  };

  if (name !== undefined || number !== undefined) {
    const rawIdentifier = (name !== undefined ? name : number).toString().trim();
    if (rawIdentifier && rawIdentifier !== table.name && rawIdentifier !== String(table.number)) {
      const duplicate = await Table.findOne({
        $or: [
          { name: { $regex: new RegExp(`^${rawIdentifier}$`, 'i') } },
          { number: rawIdentifier },
        ],
        _id: { $ne: id },
      });
      if (duplicate) {
        res.status(409).json({ code: 'DUPLICATE_TABLE', message: `Table "${rawIdentifier}" already exists` });
        return;
      }
      table.name = rawIdentifier;
      table.number = rawIdentifier;
    }
  }

  if (floor !== undefined) table.floor = floor;
  if (capacity !== undefined) table.capacity = Number(capacity);
  if (active !== undefined) table.active = Boolean(active);

  await table.save();

  await AuditLog.create({
    action: 'table_updated',
    userId: req.user?.id,
    entity: 'Table',
    entityId: table._id,
    before,
    after: { name: table.name, number: table.number, floor: table.floor, capacity: table.capacity, active: table.active },
  });

  emitTableUpdated(table);

  res.json({ table });
};

/**
 * POST /tables/:id/request-bill — waiter asks for the bill.
 * Sets the table to "billing" so the cashier sees it; the order stays open until
 * the cashier generates the bill.
 */
export const requestBill = async (req: Request, res: Response): Promise<void> => {
  const table = await Table.findById(req.params.id).catch(() => null);
  if (!table) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Table not found' });
    return;
  }

  const order = await Order.findOne({ tableId: table._id, status: OrderStatus.Open });
  if (!order) {
    res.status(400).json({ code: 'NO_OPEN_ORDER', message: 'Table has no open order' });
    return;
  }
  if (req.user?.role === Role.Waiter && order.waiterId.toString() !== req.user.id) {
    res.status(403).json({ code: 'FORBIDDEN', message: 'You can only request the bill for your own orders' });
    return;
  }

  table.status = TableStatus.Billing;
  await table.save();

  await AuditLog.create({
    action: 'bill_requested',
    userId: req.user?.id,
    entity: 'Table',
    entityId: table._id,
    after: { orderId: order._id },
  });

  emitTableUpdated(table);
  emitToStaff('bill:requested', { tableId: table._id, tableName: table.name || table.number, orderId: order._id });

  res.json({ table });
};
