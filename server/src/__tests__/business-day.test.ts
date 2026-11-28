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
jest.mock('../services/print.service', () => ({ PrintService: { enqueue: async () => undefined } }));

const app = require('../app').default;
const { User } = require('../models/User');
const { Order } = require('../models/Order');
const { Bill } = require('../models/Bill');
const { BusinessDay } = require('../models/BusinessDay');
const { Role, OrderStatus, OrderType, ItemStatus, Station, BillStatus } = require('../types');
const svc = require('../services/businessDay.service');
const { backfillBusinessDates } = require('../services/bootstrap.service');
const { ReportsService } = require('../services/reports.service');

let mongo: MongoMemoryServer;
let cashierToken: string;
let waiterId: string;
const ist = (s: string) => new Date(`${s}+05:30`);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const cashier = await User.create({ name: 'bd-cashier', role: Role.Cashier, passwordHash: 'x' });
  const waiter = await User.create({ name: 'bd-waiter', role: Role.Waiter, pinHash: 'x' });
  cashierToken = jwt.sign({ userId: String(cashier._id), role: cashier.role }, process.env.JWT_SECRET!, { expiresIn: '15m' });
  waiterId = String(waiter._id);
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await Promise.all([BusinessDay.deleteMany({}), Order.deleteMany({}), Bill.deleteMany({})]);
});

describe('Business date rules', () => {
  test('before 6 am counts as the previous day', () => {
    expect(svc.naturalBusinessDate(ist('2026-11-27T23:30:00'))).toBe('2026-11-27');
    expect(svc.naturalBusinessDate(ist('2026-11-28T00:45:00'))).toBe('2026-11-27');
    expect(svc.naturalBusinessDate(ist('2026-11-28T06:00:00'))).toBe('2026-11-28');
  });

  test('a day opened at 11 am keeps its date past midnight', async () => {
    const day = await svc.ensureOpenDay(ist('2026-11-27T11:05:00'));
    expect(day.date).toBe('2026-11-27');
    expect((await svc.ensureOpenDay(ist('2026-11-28T01:10:00'))).date).toBe('2026-11-27');
  });

  test('after closing, a late sale goes to the next day — and so does the next morning', async () => {
    const day = await svc.ensureOpenDay(ist('2026-11-27T11:05:00'));
    await svc.BusinessDayService.closeDay(day, { name: 'test' }, ist('2026-11-28T01:15:00'));
    expect(await svc.currentBusinessDate(ist('2026-11-28T01:30:00'))).toBe('2026-11-28');
    expect(await svc.currentBusinessDate(ist('2026-11-28T11:00:00'))).toBe('2026-11-28');
  });

  test('a forgotten close ends automatically at 6 am', async () => {
    await svc.ensureOpenDay(ist('2026-11-27T11:05:00'));
    const next = await svc.ensureOpenDay(ist('2026-11-28T10:30:00'));
    expect(next.date).toBe('2026-11-28');
    const old = await BusinessDay.findOne({ date: '2026-11-27' });
    expect(old.closedByName).toBe('Automatic');
    expect(old.closedAt.toISOString()).toBe(ist('2026-11-28T06:00:00').toISOString());
  });

  test('older bills are backfilled: a 12:40 am bill belongs to the day before', async () => {
    const order = await Order.create({ number: 1, type: OrderType.Takeaway, waiterId, status: OrderStatus.Paid, items: [] });
    await Bill.collection.insertMany([
      { number: 501, orderId: order._id, itemsSnapshot: [], subtotal: 100, discountAmount: 0, gst: 0, serviceCharge: 0, total: 100, payments: [{ mode: 'cash', amount: 100 }], status: 'paid', paidAt: ist('2026-11-27T21:00:00') },
      { number: 502, orderId: order._id, itemsSnapshot: [], subtotal: 200, discountAmount: 0, gst: 0, serviceCharge: 0, total: 200, payments: [{ mode: 'upi', amount: 200 }], status: 'paid', paidAt: ist('2026-11-28T00:40:00') },
    ]);
    await backfillBusinessDates();
    const bills = await Bill.find({ number: { $in: [501, 502] } }).sort({ number: 1 }).lean();
    expect(bills.map((b: any) => b.businessDate)).toEqual(['2026-11-27', '2026-11-27']);

    const daily = await ReportsService.getDailySales('2026-11-27', '2026-11-28');
    expect(daily).toEqual([expect.objectContaining({ date: '2026-11-27', totalRevenue: 300, orderCount: 2 })]);
  });
});

describe('Close counter', () => {
  const auth = () => ({ Authorization: `Bearer ${cashierToken}` });

  const paidBill = async (n: number, total: number) => {
    const order = await Order.create({
      number: n, type: OrderType.Takeaway, waiterId, status: OrderStatus.Billed,
      items: [{ menuItemId: 'x', name: 'Tea', price: total, qty: 1, station: Station.Juice, status: ItemStatus.Active }],
    });
    const bill = await Bill.create({
      number: 9000 + n, orderId: order._id, itemsSnapshot: [], subtotal: total, discountAmount: 0, gst: 0, serviceCharge: 0, total,
      payments: [{ mode: 'cash', amount: total }], status: BillStatus.Open,
    });
    await request(app).post(`/api/v1/bills/${bill._id}/close`).set(auth()).expect(200);
    return Bill.findById(bill._id).lean();
  };

  test('settled bills get the business date; closing files them and the next bill starts a new day', async () => {
    const b1 = await paidBill(1, 150);
    const current = await request(app).get('/api/v1/business-day').set(auth()).expect(200);
    expect(current.body.open).toBe(true);
    expect(b1.businessDate).toBe(current.body.date);
    expect(current.body.summary).toMatchObject({ bills: 1, total: 150, cash: 150 });

    const closed = await request(app).post('/api/v1/business-day/close').set(auth()).send({}).expect(200);
    expect(closed.body.day).toMatchObject({ date: current.body.date, summary: { bills: 1, total: 150 } });

    const b2 = await paidBill(2, 80);
    expect(b2.businessDate > b1.businessDate).toBe(true);
    expect(closed.body.nextDate).toBe(b2.businessDate);
  });

  test('undo a close by mistake — only while the next day has no sales', async () => {
    const b1 = await paidBill(11, 100);
    await request(app).post('/api/v1/business-day/close').set(auth()).send({}).expect(200);
    const re = await request(app).post('/api/v1/business-day/reopen').set(auth()).expect(200);
    expect(re.body.date).toBe(b1.businessDate);
    const b2 = await paidBill(12, 60);
    expect(b2.businessDate).toBe(b1.businessDate);

    await request(app).post('/api/v1/business-day/close').set(auth()).send({}).expect(200);
    await paidBill(13, 40); // first sale of the next day
    await request(app).post('/api/v1/business-day/reopen').set(auth()).expect(409);
  });

  test('open orders block the close until confirmed', async () => {
    await Order.create({ number: 7, type: OrderType.Takeaway, waiterId, status: OrderStatus.Open, items: [] });
    const r = await request(app).post('/api/v1/business-day/close').set(auth()).send({}).expect(409);
    expect(r.body.openOrders).toHaveLength(1);
    await request(app).post('/api/v1/business-day/close').set(auth()).send({ force: true }).expect(200);
  });
});
