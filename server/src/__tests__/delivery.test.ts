/* eslint-disable @typescript-eslint/no-require-imports */
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Fixed secrets for this test run (set before the app reads its config)
process.env.JWT_SECRET = 'test-secret-'.padEnd(40, 'x');
process.env.JWT_REFRESH_SECRET = 'test-refresh-'.padEnd(40, 'y');
process.env.AGENT_TOKEN = 'agent-token-for-tests';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://placeholder';
process.env.NODE_ENV = 'test';

jest.mock('../socket', () => ({
  emitOrderUpdated: () => undefined,
  emitTableUpdated: () => undefined,
  emitMenuUpdated: () => undefined,
  emitToRoom: () => undefined,
  emitToStaff: () => undefined,
  registerSocketHandlers: () => undefined,
  stationRoom: (s: string) => `station:${s}`,
  isAgentConnected: () => false,
  getStationStatus: () => ({}),
}));

const app = require('../app').default;
const { User } = require('../models/User');
const { Order } = require('../models/Order');
const { Bill } = require('../models/Bill');
const { BillStatus, ItemStatus, OrderStatus, OrderType, Role, Station } = require('../types');

let mongo: MongoMemoryServer;
let riderToken: string;
let waiterId: string;

const tokenFor = (u: { _id: unknown; role: string }) =>
  jwt.sign({ userId: String(u._id), role: u.role }, process.env.JWT_SECRET!, { expiresIn: '15m' });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const rider = await User.create({ name: 'faisal', role: Role.Delivery, pinHash: 'x' });
  const waiter = await User.create({ name: 'rasheed', role: Role.Waiter, pinHash: 'x' });
  riderToken = tokenFor(rider);
  waiterId = String(waiter._id);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

const makeOrder = async (opts: { status?: string; type?: string; billTotal?: number; billStatus?: string } = {}) => {
  const order = await Order.create({
    number: Math.floor(Math.random() * 1000),
    type: opts.type ?? OrderType.Delivery,
    waiterId,
    customerSnapshot: { name: 'Nishad', phone: '9895321914', address: 'Karumathil' },
    status: opts.status ?? OrderStatus.Open,
    items: [
      { menuItemId: 'a', name: 'Chikku Shake', price: 90, qty: 1, station: Station.Juice, status: ItemStatus.Active },
      { menuItemId: 'b', name: 'Lime', price: 40, qty: 1, station: Station.Juice, status: ItemStatus.Cancelled },
    ],
  });
  if (opts.billTotal) {
    await Bill.create({
      number: Math.floor(Math.random() * 1e6), orderId: order._id, itemsSnapshot: [], subtotal: opts.billTotal,
      discountAmount: 0, gst: 0, serviceCharge: 0, total: opts.billTotal, payments: [], status: opts.billStatus ?? BillStatus.Open,
    });
  }
  return order;
};

const api = (method: 'get' | 'post', path: string, token = riderToken) =>
  request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

describe('Delivery staff app', () => {
  test('delivery accounts are kept out of staff pages', async () => {
    expect((await api('get', '/orders')).status).toBe(403);
    expect((await api('get', '/items')).status).toBe(403);
    expect((await api('get', '/tickets')).status).toBe(403);
    expect((await api('get', '/customers?q=a')).status).toBe(403);
    expect((await api('get', '/auth/me')).status).toBe(200);
  });

  test('staff cannot use the delivery endpoints', async () => {
    const waiter = await User.findById(waiterId);
    expect((await api('get', '/delivery/orders', tokenFor(waiter))).status).toBe(403);
  });

  test('rider sees the order, takes it out, delivers it and records cash', async () => {
    const order = await makeOrder({ billTotal: 90 });
    const takeaway = await makeOrder({ type: OrderType.Takeaway });

    const list = await api('get', '/delivery/orders');
    expect(list.status).toBe(200);
    const mine = list.body.active.find((o: any) => o._id === String(order._id));
    expect(mine).toMatchObject({ amountDue: 90, billed: true, paid: false, delivery: { status: 'waiting' } });
    expect(mine.items.map((i: any) => i.name)).toEqual(['Chikku Shake']); // cancelled items hidden
    expect(list.body.active.some((o: any) => o._id === String(takeaway._id))).toBe(false);

    expect((await api('post', `/delivery/orders/${order._id}/out`)).status).toBe(200);
    expect((await Order.findById(order._id)).delivery).toMatchObject({ status: 'out', riderName: 'faisal' });

    const bad = await api('post', `/delivery/orders/${order._id}/delivered`).send({ mode: 'cash', amount: 0 });
    expect(bad.status).toBe(400);
    const ok = await api('post', `/delivery/orders/${order._id}/delivered`).send({ mode: 'cash', amount: 90 });
    expect(ok.status).toBe(200);

    const after = await api('get', '/delivery/orders');
    expect(after.body.active.some((o: any) => o._id === String(order._id))).toBe(false);
    expect(after.body.done[0]).toMatchObject({ _id: String(order._id), delivery: { status: 'delivered', collectedMode: 'cash', collectedAmount: 90 } });
    expect(after.body.totals).toMatchObject({ delivered: 1, cash: 90, upi: 0 });
  });

  test('prepaid orders show nothing to collect; undo steps back; settled cash bills cannot be undone', async () => {
    const prepaid = await makeOrder({ status: OrderStatus.Paid, billTotal: 90, billStatus: BillStatus.Paid });
    const list = await api('get', '/delivery/orders');
    expect(list.body.active.find((o: any) => o._id === String(prepaid._id))).toMatchObject({ paid: true, amountDue: 0 });

    await api('post', `/delivery/orders/${prepaid._id}/out`);
    expect((await api('post', `/delivery/orders/${prepaid._id}/undo`)).status).toBe(200);
    expect((await Order.findById(prepaid._id)).delivery.status).toBe('waiting');

    const cash = await makeOrder({ billTotal: 90 });
    await api('post', `/delivery/orders/${cash._id}/delivered`).send({ mode: 'cash', amount: 90 });
    await Order.updateOne({ _id: cash._id }, { status: OrderStatus.Paid }); // cashier settled
    expect((await api('post', `/delivery/orders/${cash._id}/undo`)).status).toBe(409);
  });

  test('cancelled or non-delivery orders are refused', async () => {
    const cancelled = await makeOrder({ status: OrderStatus.Cancelled });
    expect((await api('post', `/delivery/orders/${cancelled._id}/out`)).status).toBe(409);
    const dineIn = await makeOrder({ type: OrderType.DineIn });
    expect((await api('post', `/delivery/orders/${dineIn._id}/out`)).status).toBe(404);
  });
});
