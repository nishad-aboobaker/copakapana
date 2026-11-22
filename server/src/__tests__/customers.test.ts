import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Request, Response } from 'express';
import { getCustomer, listCustomers } from '../controllers/customers.controller';
import { Customer } from '../models/Customer';
import { Order } from '../models/Order';
import { Bill } from '../models/Bill';
import { User } from '../models/User';
import { BillStatus, ItemStatus, OrderStatus, OrderType, Role, Station } from '../types';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

const call = async (handler: (req: Request, res: Response) => Promise<void>, req: Partial<Request>) => {
  let status = 200;
  let body: any;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(data: unknown) {
      body = data;
      return this;
    },
  } as unknown as Response;
  await handler({ query: {}, params: {}, ...req } as Request, res);
  return { status, body };
};

const item = (name: string, qty: number, price: number, status = ItemStatus.Active) => ({
  menuItemId: new mongoose.Types.ObjectId().toString(),
  name,
  qty,
  price,
  station: Station.Main,
  status,
});

describe('Customers list and order history', () => {
  let ammuId: string;

  beforeAll(async () => {
    const waiter = await User.create({ name: 'shabil', role: Role.Waiter, pinHash: 'x' });
    const ammu = await Customer.create({
      name: 'ammu',
      phone: '9876543210',
      addresses: [{ text: 'Near temple, Chamravattam', isDefault: true }],
      orderCount: 3,
      lastOrderAt: new Date('2026-11-21T10:00:00Z'),
    });
    await Customer.create({ name: 'basheer', phone: '9000011111', orderCount: 1, lastOrderAt: new Date('2026-11-01T10:00:00Z') });
    ammuId = String(ammu._id);

    const snapshot = { name: 'ammu', phone: '9876543210', address: 'Near temple, Chamravattam' };
    const paid1 = await Order.create({
      number: 5, type: OrderType.Delivery, waiterId: waiter._id, customerId: ammu._id, customerSnapshot: snapshot,
      status: OrderStatus.Paid, items: [item('Biryani', 2, 180), item('Lime Juice', 1, 40, ItemStatus.Cancelled)],
      createdAt: new Date('2026-11-20T10:00:00Z'),
    });
    const paid2 = await Order.create({
      number: 9, type: OrderType.Takeaway, waiterId: waiter._id, customerId: ammu._id, customerSnapshot: snapshot,
      status: OrderStatus.Paid, items: [item('Biryani', 1, 180)], createdAt: new Date('2026-11-21T10:00:00Z'),
    });
    await Order.create({
      number: 11, type: OrderType.Takeaway, waiterId: waiter._id, customerId: ammu._id, customerSnapshot: snapshot,
      status: OrderStatus.Cancelled, items: [item('Shawarma', 1, 120, ItemStatus.Cancelled)],
    });
    const bill = (orderId: unknown, number: number, total: number, status = BillStatus.Paid) => ({
      number, orderId, itemsSnapshot: [], subtotal: total, discountAmount: 0, gst: 0, serviceCharge: 0, total,
      payments: [{ mode: 'cash', amount: total }], status, paidAt: new Date(),
    });
    await Bill.create(bill(paid1._id, 101, 360));
    await Bill.create(bill(paid2._id, 102, 180));
  });

  test('lists customers newest first with paid totals, and searches by name or phone digits', async () => {
    const all = await call(listCustomers, {});
    expect(all.body.total).toBe(2);
    expect(all.body.customers.map((c: any) => c.name)).toEqual(['ammu', 'basheer']);
    expect(all.body.customers[0].totalSpent).toBe(540);
    expect(all.body.customers[1].totalSpent).toBe(0);

    const byPhone = await call(listCustomers, { query: { q: '11111' } });
    expect(byPhone.body.customers.map((c: any) => c.name)).toEqual(['basheer']);
    const byName = await call(listCustomers, { query: { q: 'AMM' } });
    expect(byName.body.customers.map((c: any) => c.name)).toEqual(['ammu']);
    const regexSafe = await call(listCustomers, { query: { q: '(.*' } });
    expect(regexSafe.body.total).toBe(0);
  });

  test('customer detail shows past orders with bills, totals and favourite dishes', async () => {
    const { status, body } = await call(getCustomer, { params: { id: ammuId } });
    expect(status).toBe(200);
    expect(body.customer.phone).toBe('9876543210');
    expect(body.orders.map((o: any) => o.number)).toEqual([11, 9, 5]);
    expect(body.summary).toMatchObject({ totalSpent: 540, paidOrders: 2, averageBill: 270 });
    expect(body.summary.favourites[0]).toEqual({ name: 'Biryani', qty: 3 });

    const first = body.orders.find((o: any) => o.number === 5);
    expect(first.bill).toMatchObject({ number: 101, total: 360, status: 'paid', paymentModes: ['cash'] });
    expect(first.waiterName).toBe('shabil');
    expect(first.itemsTotal).toBe(360); // cancelled juice not counted
    expect(first.items.find((i: any) => i.name === 'Lime Juice').cancelled).toBe(true);
    expect(body.orders.find((o: any) => o.number === 11).bill).toBeNull();
  });

  test('unknown or malformed id returns 404', async () => {
    expect((await call(getCustomer, { params: { id: 'nope' } })).status).toBe(404);
    expect((await call(getCustomer, { params: { id: new mongoose.Types.ObjectId().toString() } })).status).toBe(404);
  });
});
