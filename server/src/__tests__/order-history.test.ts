/* eslint-disable @typescript-eslint/no-require-imports */
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';

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
const { Table } = require('../models/Table');
const { Role, OrderStatus, OrderType, ItemStatus, Station, BillStatus } = require('../types');

let mongo: MongoMemoryServer;
let cashier: string;
let waiterToken: string;
let waiterId: string;
const ist = (s: string) => new Date(`${s}+05:30`);
const sign = (u: { _id: unknown; role: string }) => jwt.sign({ userId: String(u._id), role: u.role }, process.env.JWT_SECRET!, { expiresIn: '15m' });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const c = await User.create({ name: 'oh-cashier', role: Role.Cashier, passwordHash: 'x' });
  const w = await User.create({ name: 'shabil', role: Role.Waiter, pinHash: 'x' });
  cashier = sign(c);
  waiterToken = sign(w);
  waiterId = String(w._id);

  const table = await Table.create({ name: 'G1', number: 'G1', floor: 'ground', capacity: 4 });
  const items = [{ menuItemId: 'a', name: 'Al Faham', price: 300, qty: 1, station: Station.Main, status: ItemStatus.Active }];
  const make = async (n: number, at: string, extra: Record<string, unknown> = {}) => {
    const o = await Order.create({ number: n, type: OrderType.DineIn, tableId: table._id, waiterId, status: OrderStatus.Open, items, ...extra });
    await Order.collection.updateOne({ _id: o._id }, { $set: { createdAt: ist(at) } });
    return o;
  };
  // 27 Nov: a dinner order paid at 9 pm, and a late one taken 11:50 pm, paid 12:20 am (still the 27th)
  const o1 = await make(1, '2026-11-27T20:30:00', { status: OrderStatus.Paid }); // one open order per table
  const o2 = await make(2, '2026-11-27T23:50:00', { type: OrderType.Delivery, tableId: undefined, customerSnapshot: { name: 'Nishad', phone: '9895321914', address: 'Karumathil' } });
  // 27 Nov 12:40 am belongs to the 26th; an open order on the 28th
  await make(3, '2026-11-27T00:40:00', { status: OrderStatus.Cancelled });
  await make(4, '2026-11-28T12:00:00');
  for (const [o, n, total, at, date] of [[o1, 101, 300, '2026-11-27T21:00:00', '2026-11-27'], [o2, 102, 450, '2026-11-28T00:20:00', '2026-11-27']] as const) {
    await Bill.create({
      number: n, orderId: o._id, itemsSnapshot: [], subtotal: total, discountAmount: 0, gst: 0, serviceCharge: 0, total,
      payments: [{ mode: 'cash', amount: total }], status: BillStatus.Paid, paidAt: ist(at), businessDate: date,
    });
    await Order.updateOne({ _id: o._id }, { status: OrderStatus.Paid });
  }
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

const get = (qs: string, token = cashier) => request(app).get(`/api/v1/orders/history?${qs}`).set({ Authorization: `Bearer ${token}` });

describe('Orders page history', () => {
  test('waiters are kept out', async () => {
    await get('from=2026-11-27', waiterToken).expect(403);
  });

  test('a business day includes after-midnight orders and excludes the early hours of the date', async () => {
    const r = await get('from=2026-11-27&to=2026-11-27').expect(200);
    expect(r.body.orders.map((o: any) => o.number)).toEqual([2, 1]);
    expect(r.body.totals).toMatchObject({ paidTotal: 750, paidCount: 2 });
    const delivery = r.body.orders[0];
    expect(delivery).toMatchObject({ type: 'delivery', customer: { name: 'Nishad' }, bill: { number: 102, total: 450, status: 'paid', modes: ['cash'] }, waiterName: 'shabil' });
  });

  test('filters by date range, status, type and search', async () => {
    const all = await get('from=2026-11-26&to=2026-11-28').expect(200);
    expect(all.body.total).toBe(4);
    expect(all.body.totals.byStatus).toMatchObject({ paid: 2, cancelled: 1, open: 1 });
    expect((await get('from=2026-11-26&to=2026-11-28&status=cancelled')).body.orders.map((o: any) => o.number)).toEqual([3]);
    expect((await get('from=2026-11-26&to=2026-11-28&type=delivery')).body.orders.map((o: any) => o.number)).toEqual([2]);
    expect((await get('from=2026-11-26&to=2026-11-28&q=nish')).body.orders.map((o: any) => o.number)).toEqual([2]);
    expect((await get('from=2026-11-26&to=2026-11-28&q=4')).body.orders.map((o: any) => o.number)).toEqual([4]);
    expect((await get('from=2026-11-26&to=2026-11-28&q=G1')).body.total).toBe(3);
  });

  test('pages through results', async () => {
    const p1 = await get('from=2026-11-26&to=2026-11-28&limit=3&page=1');
    const p2 = await get('from=2026-11-26&to=2026-11-28&limit=3&page=2');
    expect(p1.body.orders).toHaveLength(3);
    expect(p2.body.orders).toHaveLength(1);
  });
});
