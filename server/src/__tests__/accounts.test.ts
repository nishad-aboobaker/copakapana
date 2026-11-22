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
const { Role } = require('../types');
const { salaryEarned } = require('../services/accounts.service');
const { todayIST, addDays } = require('../utils/ymd');

let mongo: MongoMemoryServer;
const tokens: Record<string, string> = {};
const tokenFor = (u: { _id: unknown; role: string }) =>
  jwt.sign({ userId: String(u._id), role: u.role }, process.env.JWT_SECRET!, { expiresIn: '15m' });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  for (const role of [Role.Waiter, Role.Cashier, Role.Manager]) {
    const u = await User.create(role === Role.Waiter ? { name: `acc-${role}`, role, pinHash: 'x' } : { name: `acc-${role}`, role, passwordHash: 'x' });
    tokens[role] = tokenFor(u);
  }
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

const as = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });

describe('Salary earned day by day', () => {
  const staff = { startDate: '2026-01-01', rates: [{ from: '2026-01-01', monthly: 15000 }] };
  test('a full month earns the monthly salary, whatever its length', () => {
    expect(salaryEarned(staff, '2026-02-01', '2026-02-28')).toBe(15000);
    expect(salaryEarned(staff, '2026-01-01', '2026-01-31')).toBe(15000);
  });
  test('part of a month earns per day', () => {
    expect(salaryEarned(staff, '2026-01-01', '2026-01-10')).toBe(Math.round(15000 * 10 / 31));
  });
  test('nothing before the start date or after the end date', () => {
    expect(salaryEarned({ ...staff, startDate: '2026-01-16' }, '2026-01-01', '2026-01-31')).toBe(Math.round(15000 * 16 / 31));
    expect(salaryEarned({ ...staff, endDate: '2026-02-14' }, '2026-02-01', '2026-02-28')).toBe(7500);
  });
  test('a salary change applies from its date', () => {
    const raised = { ...staff, rates: [...staff.rates, { from: '2026-03-01', monthly: 18000 }] };
    expect(salaryEarned(raised, '2026-02-01', '2026-03-31')).toBe(33000);
  });
});
const roundTo = (n: number) => Math.round(n * 100) / 100;

describe('Accounts API', () => {
  test('waiters are kept out; cashiers are let in', async () => {
    await request(app).get('/api/v1/accounts/vendors').set(as(Role.Waiter)).expect(403);
    await request(app).get('/api/v1/accounts/vendors').set(as(Role.Cashier)).expect(200);
  });

  test('vendor: opening balance + bills − payments', async () => {
    const created = await request(app)
      .post('/api/v1/accounts/vendors')
      .set(as(Role.Cashier))
      .send({ name: 'Malabar Chicken', openingBalance: 5000 })
      .expect(201);
    const id = created.body.vendor._id;
    const yesterday = addDays(todayIST(), -1);
    await request(app).post(`/api/v1/accounts/vendors/${id}/entries`).set(as(Role.Cashier)).send({ date: yesterday, billAmount: 3200, paidAmount: 2000 }).expect(201);
    await request(app).post(`/api/v1/accounts/vendors/${id}/entries`).set(as(Role.Cashier)).send({ billAmount: 1800 }).expect(201);
    await request(app).post(`/api/v1/accounts/vendors/${id}/entries`).set(as(Role.Cashier)).send({}).expect(400);
    await request(app).post(`/api/v1/accounts/vendors/${id}/entries`).set(as(Role.Cashier)).send({ date: addDays(todayIST(), 2), billAmount: 10 }).expect(400);

    const detail = await request(app).get(`/api/v1/accounts/vendors/${id}`).set(as(Role.Cashier)).expect(200);
    expect(detail.body.summary).toEqual({ openingBalance: 5000, billed: 5000, paid: 2000, balance: 8000 });
    expect(detail.body.entries[0].balance).toBe(8000); // newest first, running balance
    expect(detail.body.entries[1].balance).toBe(6200);

    const list = await request(app).get('/api/v1/accounts/vendors').set(as(Role.Cashier)).expect(200);
    expect(list.body.vendors.find((v: any) => v._id === id).balance).toBe(8000);
  });

  test('staff: outstanding + earned − paid; report for a past month', async () => {
    const created = await request(app)
      .post('/api/v1/accounts/staff')
      .set(as(Role.Cashier))
      .send({ name: 'Ramesh (cook)', monthlySalary: 15000, openingBalance: 2000, startDate: '2026-01-01' })
      .expect(201);
    const id = created.body.staff._id;
    await request(app).post(`/api/v1/accounts/staff/${id}/payments`).set(as(Role.Cashier)).send({ date: '2026-02-05', amount: 500 }).expect(201);
    await request(app).post(`/api/v1/accounts/staff/${id}/payments`).set(as(Role.Cashier)).send({ date: '2026-02-20', amount: 700 }).expect(201);
    await request(app).post(`/api/v1/accounts/staff/${id}/payments`).set(as(Role.Cashier)).send({ amount: 0 }).expect(400);

    const report = await request(app).get('/api/v1/accounts/report?from=2026-02-01&to=2026-02-28').set(as(Role.Cashier)).expect(200);
    const row = report.body.staff.find((s: any) => s.id === id);
    expect(row).toMatchObject({ opening: 17000, earned: 15000, paid: 1200, closing: 30800 });
    expect(report.body.daily.find((d: any) => d.date === '2026-02-05').salaryPaid).toBe(500);

    const detail = await request(app).get(`/api/v1/accounts/staff/${id}`).set(as(Role.Cashier)).expect(200);
    const feb = detail.body.months.find((m: any) => m.month === '2026-02');
    expect(feb).toEqual({ month: '2026-02', earned: 15000, paid: 1200, balance: 30800 });
    const expectedEarned = salaryEarned({ startDate: '2026-01-01', rates: [{ from: '2026-01-01', monthly: 15000 }] }, '2026-01-01', todayIST());
    expect(detail.body.summary.balance).toBe(roundTo(2000 + expectedEarned - 1200));
  });

  test('cashiers delete only their own entries from today; managers any', async () => {
    const v = await request(app).post('/api/v1/accounts/vendors').set(as(Role.Manager)).send({ name: 'Veg market' }).expect(201);
    const mine = await request(app).post(`/api/v1/accounts/vendors/${v.body.vendor._id}/entries`).set(as(Role.Cashier)).send({ billAmount: 900 }).expect(201);
    const managers = await request(app).post(`/api/v1/accounts/vendors/${v.body.vendor._id}/entries`).set(as(Role.Manager)).send({ billAmount: 400 }).expect(201);
    await request(app).delete(`/api/v1/accounts/vendor-entries/${managers.body.entry._id}`).set(as(Role.Cashier)).expect(403);
    await request(app).delete(`/api/v1/accounts/vendor-entries/${mine.body.entry._id}`).set(as(Role.Cashier)).expect(200);
    await request(app).delete(`/api/v1/accounts/vendor-entries/${managers.body.entry._id}`).set(as(Role.Manager)).expect(200);
  });

  test('a salary raise keeps earlier days at the old rate; leaving stops salary', async () => {
    const s = await request(app).post('/api/v1/accounts/staff').set(as(Role.Manager)).send({ name: 'Salim', monthlySalary: 12000, startDate: '2026-01-01' }).expect(201);
    const id = s.body.staff._id;
    await request(app).patch(`/api/v1/accounts/staff/${id}`).set(as(Role.Manager)).send({ monthlySalary: 14000, salaryFrom: '2026-03-01' }).expect(200);
    const report = await request(app).get('/api/v1/accounts/report?from=2026-02-01&to=2026-03-31').set(as(Role.Manager)).expect(200);
    expect(report.body.staff.find((r: any) => r.id === id).earned).toBe(26000);

    const left = await request(app).patch(`/api/v1/accounts/staff/${id}`).set(as(Role.Manager)).send({ active: false }).expect(200);
    expect(left.body.staff.endDate).toBe(todayIST());
  });
});
