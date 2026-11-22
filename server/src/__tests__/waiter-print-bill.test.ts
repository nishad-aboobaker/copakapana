import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Request, Response } from 'express';
import { Order } from '../models/Order';
import { Bill } from '../models/Bill';
import { Table } from '../models/Table';
import { User } from '../models/User';
import { ItemStatus, OrderStatus, OrderType, Role, Station, TableStatus } from '../types';

const queued: { type: string; payload: any }[] = [];
jest.mock('../services/print.service', () => ({
  PrintService: { enqueue: async (type: string, _ip: string, payload: unknown) => queued.push({ type, payload: payload as any }) },
}));
jest.mock('../socket', () => ({ emitOrderUpdated: () => undefined, emitTableUpdated: () => undefined }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { printOrderBill, generateBill, closeBill, reprintBill } = require('../controllers/billing.controller');

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(() => {
  queued.length = 0;
});

const call = async (id: string, user: { id: string; role: Role; name: string }, handler: any = printOrderBill) => {
  let status = 200;
  let body: any;
  const res = {
    status(c: number) {
      status = c;
      return this;
    },
    json(d: unknown) {
      body = d;
      return this;
    },
  } as unknown as Response;
  await handler({ params: { id }, user } as unknown as Request, res);
  return { status, body };
};

let n = 0;
const setup = async () => {
  n++;
  const waiter = await User.create({ name: `shabil-${n}`, role: Role.Waiter, pinHash: 'x' });
  const table = await Table.create({ name: `G${n}`, number: `G${n}`, floor: 'ground', capacity: 4, status: TableStatus.Occupied });
  const order = await Order.create({
    number: 40 + n,
    type: OrderType.DineIn,
    tableId: table._id,
    waiterId: waiter._id,
    status: OrderStatus.Open,
    items: [
      { menuItemId: 'a', name: '7 UP 40', price: 40, qty: 2, station: Station.Juice, status: ItemStatus.Active, skipKitchen: true },
      { menuItemId: 'b', name: 'Lime Juice', price: 30, qty: 1, station: Station.Juice, status: ItemStatus.Cancelled },
    ],
  });
  return { waiter, table, order, user: { id: waiter.id, role: Role.Waiter, name: waiter.name } };
};

describe('Waiter prints the bill', () => {
  test('generates the bill and prints it on the counter printer', async () => {
    const { table, order, user } = await setup();
    const r = await call(order.id, user);
    expect(r.status).toBe(201);
    expect(r.body.bill.total).toBe(80);
    expect((await Order.findById(order._id))!.status).toBe(OrderStatus.Billed);
    expect((await Table.findById(table._id))!.status).toBe(TableStatus.Billing);
    expect(queued).toHaveLength(1);
    expect(queued[0].type).toBe('bill');
    expect(queued[0].payload).toMatchObject({ isReprint: false, total: 80, tableName: table.name, payments: [] });
    expect(queued[0].payload.itemsSnapshot).toHaveLength(1);
  });

  test('pressing it again prints a copy of the same bill', async () => {
    const { order, user } = await setup();
    const first = await call(order.id, user);
    const second = await call(order.id, user);
    expect(second.status).toBe(200);
    expect(second.body.bill._id.toString()).toBe(first.body.bill._id.toString());
    expect(await Bill.countDocuments({ orderId: order._id })).toBe(1);
    expect(queued).toHaveLength(2);
    expect(queued[1].payload.isReprint).toBe(false);
  });

  test("a waiter can't print another waiter's bill", async () => {
    const { order } = await setup();
    const other = await User.create({ name: `other-${n}`, role: Role.Waiter, pinHash: 'x' });
    const r = await call(order.id, { id: other.id, role: Role.Waiter, name: other.name });
    expect(r.status).toBe(403);
    expect(queued).toHaveLength(0);
    expect(await Bill.countDocuments({ orderId: order._id })).toBe(0);
  });

  test('a paid order is not billed again', async () => {
    const { order, user } = await setup();
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.Paid });
    const r = await call(order.id, user);
    expect(r.status).toBe(409);
    expect(queued).toHaveLength(0);
  });
});

describe('Cashier: print on Generate bill, Settle & save only records payment', () => {
  const cashier = { id: new mongoose.Types.ObjectId().toString(), role: Role.Cashier, name: 'nishad' };

  test('generate prints once; settling saves the payment without printing', async () => {
    const { order } = await setup();
    const gen = await call(order.id, cashier, generateBill);
    expect(gen.status).toBe(201);
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toMatchObject({ isReprint: false, total: 80, payments: [] });

    // Selecting the order again returns the same bill and prints nothing
    await call(order.id, cashier, generateBill);
    expect(queued).toHaveLength(1);

    await Bill.updateOne({ _id: gen.body.bill._id }, { payments: [{ mode: 'cash', amount: 80 }] });
    const close = await call(gen.body.bill._id.toString(), cashier, closeBill);
    expect(close.status).toBe(200);
    expect(queued).toHaveLength(1);
    expect((await Bill.findById(gen.body.bill._id))!.status).toBe('paid');
    expect((await Order.findById(order._id))!.status).toBe(OrderStatus.Paid);
  });

  test('printing an open bill again is not marked REPRINT; a paid bill is', async () => {
    const { order } = await setup();
    const gen = await call(order.id, cashier, generateBill);
    const billId = gen.body.bill._id.toString();
    await call(billId, cashier, reprintBill);
    expect(queued[1].payload.isReprint).toBe(false);
    await Bill.updateOne({ _id: billId }, { status: 'paid' });
    await call(billId, cashier, reprintBill);
    expect(queued[2].payload.isReprint).toBe(true);
  });

  test('delivery orders print the delivery bill on generate', async () => {
    const { order } = await setup();
    await Order.updateOne(
      { _id: order._id },
      { type: OrderType.Delivery, $unset: { tableId: 1 }, customerSnapshot: { name: 'Nishad', phone: '9895321914', address: 'Karumathil' } },
    );
    await call(order.id, cashier, generateBill);
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toMatchObject({ deliveryBill: true, amountDue: 80 });
  });
});
