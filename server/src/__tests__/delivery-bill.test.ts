import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Request, Response } from 'express';
import { Order } from '../models/Order';
import { Bill } from '../models/Bill';
import { User } from '../models/User';
import { BillStatus, ItemStatus, OrderStatus, OrderType, Role, Station } from '../types';

const queued: { type: string; payload: any }[] = [];
jest.mock('../services/print.service', () => ({
  PrintService: { enqueue: async (type: string, _ip: string, payload: unknown) => queued.push({ type, payload: payload as any }) },
}));
jest.mock('../socket', () => ({ emitOrderUpdated: () => undefined, emitTableUpdated: () => undefined }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { printDeliveryBill } = require('../controllers/billing.controller');

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

const call = async (id: string) => {
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
  await printDeliveryBill({ params: { id }, user: { id: new mongoose.Types.ObjectId().toString(), role: Role.Cashier, name: 'nishad' } } as unknown as Request, res);
  return { status, body };
};

let billNo = 22815;
const makeBill = async (type: OrderType, status: BillStatus, payments: any[] = []) => {
  const waiter = await User.create({ name: `rasheed-${new mongoose.Types.ObjectId()}`, role: Role.Waiter, pinHash: 'x' });
  const order = await Order.create({
    number: 9,
    type,
    waiterId: waiter._id,
    customerSnapshot: { name: 'Nishad', phone: '9895321914', address: 'Karumathil' },
    status: status === BillStatus.Paid ? OrderStatus.Paid : OrderStatus.Billed,
    items: [{ menuItemId: 'x', name: 'Chikku Shake', price: 90, qty: 1, station: Station.Juice, status: ItemStatus.Active }],
  });
  return Bill.create({
    number: billNo++, orderId: order._id, itemsSnapshot: [{ menuItemId: 'x', name: 'Chikku Shake', price: 90, qty: 1 }],
    subtotal: 290, discountAmount: 0, gst: 0, serviceCharge: 0, total: 290, payments, status,
  });
};

describe('Delivery bill for the rider', () => {
  test('open bill prints with customer details and the amount to collect', async () => {
    const bill = await makeBill(OrderType.Delivery, BillStatus.Open);
    const r = await call(bill.id);
    expect(r.status).toBe(200);
    expect(r.body.amountDue).toBe(290);
    expect(queued).toHaveLength(1);
    expect(queued[0].type).toBe('bill');
    expect(queued[0].payload).toMatchObject({
      deliveryBill: true,
      amountDue: 290,
      orderType: 'delivery',
      customer: { name: 'Nishad', phone: '9895321914', address: 'Karumathil' },
      cashierName: 'nishad',
    });
  });

  test('paid bill prints as PAID with nothing to collect', async () => {
    const bill = await makeBill(OrderType.Delivery, BillStatus.Paid, [{ mode: 'upi', amount: 290 }]);
    const r = await call(bill.id);
    expect(r.body.amountDue).toBe(0);
    expect(queued[0].payload.payments).toHaveLength(1);
  });

  test('refused for non-delivery orders and void bills', async () => {
    const takeaway = await makeBill(OrderType.Takeaway, BillStatus.Open);
    expect((await call(takeaway.id)).status).toBe(400);
    const voided = await makeBill(OrderType.Delivery, BillStatus.Void);
    expect((await call(voided.id)).status).toBe(409);
    expect(queued).toHaveLength(0);
  });
});
