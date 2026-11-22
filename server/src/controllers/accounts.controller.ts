import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { AuditLog } from '../models/AuditLog';
import { ISalaryStaff, SalaryPayment, SalaryStaff } from '../models/SalaryStaff';
import { Vendor, VendorEntry } from '../models/Vendor';
import { rateOn, roundMoney, salaryEarned } from '../services/accounts.service';
import { Role, RoleLevel } from '../types';
import { addDays, firstOfMonth, isValidYmd, lastOfMonth, minYmd, todayIST } from '../utils/ymd';

const MODES = ['cash', 'upi', 'bank'] as const;
type Mode = (typeof MODES)[number];

const bad = (res: Response, message: string, code = 'VALIDATION_ERROR'): void => {
  res.status(400).json({ code, message });
};

const notFound = (res: Response, what: string): void => {
  res.status(404).json({ code: 'NOT_FOUND', message: `${what} not found` });
};

const isId = (id: string): boolean => mongoose.Types.ObjectId.isValid(id);

/** Parses a money field: undefined → fallback; otherwise a non-negative number rounded to paise. */
const money = (v: unknown, fallback = 0): number | null => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return roundMoney(n);
};

/** Opening balances may be negative (an advance already paid / vendor owes us). */
const signedMoney = (v: unknown, fallback = 0): number | null => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return roundMoney(n);
};

const text = (v: unknown, max = 200): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim().slice(0, max);
  return t || undefined;
};

const parseMode = (v: unknown): Mode | undefined => (MODES.includes(v as Mode) ? (v as Mode) : undefined);

/** Entry date: defaults to today, must be a real date and not in the future. */
const entryDate = (v: unknown): string | null => {
  if (v === undefined || v === null || v === '') return todayIST();
  if (!isValidYmd(v) || v > todayIST()) return null;
  return v;
};

const audit = (req: Request, action: string, entity: string, entityId: unknown, after?: unknown, before?: unknown) =>
  AuditLog.create({ action, userId: req.user?.id, entity, entityId, after, before });

/** Managers and owners can delete any entry; cashiers only the ones they made today. */
const canDelete = (req: Request, entry: { createdBy?: mongoose.Types.ObjectId; createdAt: Date }): boolean => {
  if (RoleLevel[req.user!.role] >= RoleLevel[Role.Manager]) return true;
  const madeToday =
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(entry.createdAt) === todayIST();
  return !!entry.createdBy && entry.createdBy.toString() === req.user!.id && madeToday;
};

// ─── Vendors ───────────────────────────────────────────────────────────────

type VendorTotals = { billed: number; paid: number; lastDate?: string };

const vendorTotals = async (match: Record<string, unknown> = {}): Promise<Map<string, VendorTotals>> => {
  const rows = await VendorEntry.aggregate<{ _id: mongoose.Types.ObjectId; billed: number; paid: number; lastDate: string }>([
    { $match: match },
    { $group: { _id: '$vendorId', billed: { $sum: '$billAmount' }, paid: { $sum: '$paidAmount' }, lastDate: { $max: '$date' } } },
  ]);
  return new Map(rows.map((r) => [r._id.toString(), { billed: r.billed, paid: r.paid, lastDate: r.lastDate }]));
};

/** GET /accounts/vendors — every vendor with what we owe them. */
export const listVendors = async (_req: Request, res: Response): Promise<void> => {
  const [vendors, totals] = await Promise.all([Vendor.find().sort({ active: -1, name: 1 }).lean(), vendorTotals()]);
  const list = vendors.map((v) => {
    const t = totals.get(v._id.toString()) ?? { billed: 0, paid: 0 };
    return {
      ...v,
      billed: roundMoney(t.billed),
      paid: roundMoney(t.paid),
      balance: roundMoney(v.openingBalance + t.billed - t.paid),
      lastDate: t.lastDate ?? null,
    };
  });
  const totalDue = roundMoney(list.filter((v) => v.active).reduce((s, v) => s + v.balance, 0));
  res.json({ vendors: list, totalDue });
};

/** POST /accounts/vendors — { name, phone?, note?, openingBalance? } */
export const createVendor = async (req: Request, res: Response): Promise<void> => {
  const name = text(req.body?.name, 80);
  if (!name) return bad(res, 'Vendor name is required');
  const openingBalance = signedMoney(req.body?.openingBalance);
  if (openingBalance === null) return bad(res, 'Opening balance must be a number');
  const vendor = await Vendor.create({ name, phone: text(req.body?.phone, 30), note: text(req.body?.note), openingBalance });
  await audit(req, 'vendor_created', 'Vendor', vendor._id, { name, openingBalance });
  res.status(201).json({ vendor });
};

/** PATCH /accounts/vendors/:id — { name?, phone?, note?, openingBalance?, active? } */
export const updateVendor = async (req: Request, res: Response): Promise<void> => {
  if (!isId(req.params.id)) return notFound(res, 'Vendor');
  const vendor = await Vendor.findById(req.params.id);
  if (!vendor) return notFound(res, 'Vendor');
  const before = { name: vendor.name, phone: vendor.phone, note: vendor.note, openingBalance: vendor.openingBalance, active: vendor.active };
  const b = req.body ?? {};
  if (b.name !== undefined) {
    const name = text(b.name, 80);
    if (!name) return bad(res, 'Vendor name is required');
    vendor.name = name;
  }
  if (b.phone !== undefined) vendor.phone = text(b.phone, 30);
  if (b.note !== undefined) vendor.note = text(b.note);
  if (b.openingBalance !== undefined) {
    const ob = signedMoney(b.openingBalance);
    if (ob === null) return bad(res, 'Opening balance must be a number');
    vendor.openingBalance = ob;
  }
  if (b.active !== undefined) vendor.active = !!b.active;
  await vendor.save();
  await audit(req, 'vendor_updated', 'Vendor', vendor._id, b, before);
  res.json({ vendor });
};

/** GET /accounts/vendors/:id — vendor, ledger (newest first, with running balance) and totals. */
export const getVendor = async (req: Request, res: Response): Promise<void> => {
  if (!isId(req.params.id)) return notFound(res, 'Vendor');
  const vendor = await Vendor.findById(req.params.id).lean();
  if (!vendor) return notFound(res, 'Vendor');
  const entries = await VendorEntry.find({ vendorId: vendor._id }).sort({ date: 1, createdAt: 1 }).lean();
  let balance = vendor.openingBalance;
  let billed = 0;
  let paid = 0;
  const ledger = entries.map((e) => {
    balance = roundMoney(balance + e.billAmount - e.paidAmount);
    billed += e.billAmount;
    paid += e.paidAmount;
    return { ...e, balance };
  });
  res.json({
    vendor,
    entries: ledger.reverse(),
    summary: { openingBalance: vendor.openingBalance, billed: roundMoney(billed), paid: roundMoney(paid), balance: roundMoney(balance) },
  });
};

/** POST /accounts/vendors/:id/entries — { date?, billAmount?, paidAmount?, mode?, note? } */
export const addVendorEntry = async (req: Request, res: Response): Promise<void> => {
  if (!isId(req.params.id)) return notFound(res, 'Vendor');
  const vendor = await Vendor.findById(req.params.id).lean();
  if (!vendor) return notFound(res, 'Vendor');
  const date = entryDate(req.body?.date);
  if (!date) return bad(res, 'Pick a valid date (not in the future)');
  const billAmount = money(req.body?.billAmount);
  const paidAmount = money(req.body?.paidAmount);
  if (billAmount === null || paidAmount === null) return bad(res, 'Amounts must be zero or more');
  if (billAmount === 0 && paidAmount === 0) return bad(res, 'Enter the bill amount, the amount paid, or both');
  const entry = await VendorEntry.create({
    vendorId: vendor._id,
    date,
    billAmount,
    paidAmount,
    mode: paidAmount > 0 ? parseMode(req.body?.mode) ?? 'cash' : undefined,
    note: text(req.body?.note),
    createdBy: req.user?.id,
    createdByName: req.user?.name,
  });
  await audit(req, 'vendor_entry_added', 'VendorEntry', entry._id, { vendor: vendor.name, date, billAmount, paidAmount });
  res.status(201).json({ entry });
};

/** DELETE /accounts/vendor-entries/:id */
export const deleteVendorEntry = async (req: Request, res: Response): Promise<void> => {
  if (!isId(req.params.id)) return notFound(res, 'Entry');
  const entry = await VendorEntry.findById(req.params.id);
  if (!entry) return notFound(res, 'Entry');
  if (!canDelete(req, entry)) {
    res.status(403).json({ code: 'FORBIDDEN', message: 'Only a manager or owner can delete this entry' });
    return;
  }
  await entry.deleteOne();
  await audit(req, 'vendor_entry_deleted', 'VendorEntry', entry._id, undefined, entry.toObject());
  res.json({ ok: true });
};

// ─── Staff salary ──────────────────────────────────────────────────────────

const paymentTotals = async (match: Record<string, unknown> = {}): Promise<Map<string, number>> => {
  const rows = await SalaryPayment.aggregate<{ _id: mongoose.Types.ObjectId; paid: number }>([
    { $match: match },
    { $group: { _id: '$staffId', paid: { $sum: '$amount' } } },
  ]);
  return new Map(rows.map((r) => [r._id.toString(), r.paid]));
};

/** Earned so far, paid so far and the balance (positive = we owe them; negative = advance). */
type StaffLike = Pick<ISalaryStaff, 'rates' | 'startDate' | 'endDate' | 'openingBalance'>;
const staffPosition = (s: StaffLike, paid: number, asOf = todayIST()) => {
  const earned = salaryEarned(s, s.startDate, asOf);
  return { earned, paid: roundMoney(paid), balance: roundMoney(s.openingBalance + earned - paid) };
};

/** GET /accounts/staff — everyone on the payroll with this month's figures and the balance. */
export const listSalaryStaff = async (_req: Request, res: Response): Promise<void> => {
  const today = todayIST();
  const monthStart = firstOfMonth(today);
  const [staff, paidAll, paidMonth] = await Promise.all([
    SalaryStaff.find().sort({ active: -1, name: 1 }).lean(),
    paymentTotals(),
    paymentTotals({ date: { $gte: monthStart, $lte: today } }),
  ]);
  const list = staff.map((s) => {
    const pos = staffPosition(s, paidAll.get(s._id.toString()) ?? 0, today);
    return {
      ...s,
      monthlySalary: rateOn(s, today),
      ...pos,
      earnedThisMonth: salaryEarned(s, monthStart, today),
      paidThisMonth: roundMoney(paidMonth.get(s._id.toString()) ?? 0),
    };
  });
  const totalDue = roundMoney(list.filter((s) => s.active).reduce((sum, s) => sum + s.balance, 0));
  res.json({ staff: list, totalDue });
};

/** POST /accounts/staff — { name, monthlySalary, openingBalance?, startDate?, phone?, job? } */
export const createSalaryStaff = async (req: Request, res: Response): Promise<void> => {
  const b = req.body ?? {};
  const name = text(b.name, 80);
  if (!name) return bad(res, 'Name is required');
  const monthly = money(b.monthlySalary, -1);
  if (monthly === null || monthly < 0) return bad(res, 'Monthly salary is required');
  const openingBalance = signedMoney(b.openingBalance);
  if (openingBalance === null) return bad(res, 'Outstanding salary must be a number');
  const startDate = entryDate(b.startDate);
  if (!startDate) return bad(res, 'Pick a valid start date (not in the future)');
  const staff = await SalaryStaff.create({
    name,
    phone: text(b.phone, 30),
    job: text(b.job, 40),
    openingBalance,
    startDate,
    rates: [{ from: startDate, monthly }],
  });
  await audit(req, 'salary_staff_created', 'SalaryStaff', staff._id, { name, monthly, openingBalance, startDate });
  res.status(201).json({ staff });
};

/**
 * PATCH /accounts/staff/:id — { name?, phone?, job?, openingBalance?, monthlySalary?, salaryFrom?, active? }
 * A new monthly salary applies from `salaryFrom` (default today); earlier days keep the old rate.
 * Marking someone inactive stops their salary after today.
 */
export const updateSalaryStaff = async (req: Request, res: Response): Promise<void> => {
  if (!isId(req.params.id)) return notFound(res, 'Staff member');
  const staff = await SalaryStaff.findById(req.params.id);
  if (!staff) return notFound(res, 'Staff member');
  const before = staff.toObject();
  const b = req.body ?? {};
  const today = todayIST();

  if (b.name !== undefined) {
    const name = text(b.name, 80);
    if (!name) return bad(res, 'Name is required');
    staff.name = name;
  }
  if (b.phone !== undefined) staff.phone = text(b.phone, 30);
  if (b.job !== undefined) staff.job = text(b.job, 40);
  if (b.openingBalance !== undefined) {
    const ob = signedMoney(b.openingBalance);
    if (ob === null) return bad(res, 'Outstanding salary must be a number');
    staff.openingBalance = ob;
  }
  if (b.monthlySalary !== undefined) {
    const monthly = money(b.monthlySalary, -1);
    if (monthly === null || monthly < 0) return bad(res, 'Monthly salary must be zero or more');
    let from = b.salaryFrom ? String(b.salaryFrom) : today;
    if (!isValidYmd(from)) return bad(res, 'Pick a valid date for the new salary');
    if (from < staff.startDate) from = staff.startDate;
    if (rateOn(staff, from) !== monthly) {
      const rates = staff.rates.filter((r) => r.from !== from);
      rates.push({ from, monthly });
      rates.sort((x, y) => x.from.localeCompare(y.from));
      staff.rates = rates;
    }
  }
  if (b.active !== undefined) {
    const active = !!b.active;
    if (active !== staff.active) {
      staff.active = active;
      staff.endDate = active ? undefined : today;
    }
  }
  await staff.save();
  await audit(req, 'salary_staff_updated', 'SalaryStaff', staff._id, b, { name: before.name, rates: before.rates, openingBalance: before.openingBalance, active: before.active });
  res.json({ staff });
};

/** GET /accounts/staff/:id — staff member, payments (newest first) and a month-by-month summary. */
export const getSalaryStaff = async (req: Request, res: Response): Promise<void> => {
  if (!isId(req.params.id)) return notFound(res, 'Staff member');
  const staff = await SalaryStaff.findById(req.params.id).lean();
  if (!staff) return notFound(res, 'Staff member');
  const today = todayIST();
  const payments = await SalaryPayment.find({ staffId: staff._id }).sort({ date: -1, createdAt: -1 }).lean();

  // Month by month from the start month (or the first payment) to this month
  const firstPayment = payments.length ? payments[payments.length - 1].date : today;
  const firstMonth = firstOfMonth(minYmd(staff.startDate, firstPayment));
  const months: { month: string; earned: number; paid: number; balance: number }[] = [];
  let balance = staff.openingBalance;
  for (let m = firstMonth; m <= today; m = addDays(lastOfMonth(m), 1)) {
    const end = minYmd(lastOfMonth(m), today);
    const earned = salaryEarned(staff, m, end);
    const paid = roundMoney(payments.filter((p) => p.date >= m && p.date <= end).reduce((s, p) => s + p.amount, 0));
    balance = roundMoney(balance + earned - paid);
    months.push({ month: m.slice(0, 7), earned, paid, balance });
  }

  const paidTotal = payments.reduce((s, p) => s + p.amount, 0);
  res.json({
    staff: { ...staff, monthlySalary: rateOn(staff, today) },
    payments,
    months: months.reverse(),
    summary: { openingBalance: staff.openingBalance, ...staffPosition(staff, paidTotal, today) },
  });
};

/** POST /accounts/staff/:id/payments — { amount, date?, mode?, note? } */
export const addSalaryPayment = async (req: Request, res: Response): Promise<void> => {
  if (!isId(req.params.id)) return notFound(res, 'Staff member');
  const staff = await SalaryStaff.findById(req.params.id).lean();
  if (!staff) return notFound(res, 'Staff member');
  const date = entryDate(req.body?.date);
  if (!date) return bad(res, 'Pick a valid date (not in the future)');
  const amount = money(req.body?.amount);
  if (!amount) return bad(res, 'Enter the amount paid');
  const payment = await SalaryPayment.create({
    staffId: staff._id,
    date,
    amount,
    mode: parseMode(req.body?.mode) ?? 'cash',
    note: text(req.body?.note),
    createdBy: req.user?.id,
    createdByName: req.user?.name,
  });
  await audit(req, 'salary_paid', 'SalaryPayment', payment._id, { staff: staff.name, date, amount });
  res.status(201).json({ payment });
};

/** DELETE /accounts/salary-payments/:id */
export const deleteSalaryPayment = async (req: Request, res: Response): Promise<void> => {
  if (!isId(req.params.id)) return notFound(res, 'Payment');
  const payment = await SalaryPayment.findById(req.params.id);
  if (!payment) return notFound(res, 'Payment');
  if (!canDelete(req, payment)) {
    res.status(403).json({ code: 'FORBIDDEN', message: 'Only a manager or owner can delete this payment' });
    return;
  }
  await payment.deleteOne();
  await audit(req, 'salary_payment_deleted', 'SalaryPayment', payment._id, undefined, payment.toObject());
  res.json({ ok: true });
};

// ─── Report ────────────────────────────────────────────────────────────────

/**
 * GET /accounts/report?from=YYYY-MM-DD&to=YYYY-MM-DD (default: this month so far)
 * Per vendor and per staff member: balance at the start, what was added (bills / salary earned),
 * what was paid, and the balance at the end. Plus day-by-day totals.
 */
export const accountsReport = async (req: Request, res: Response): Promise<void> => {
  const today = todayIST();
  const from = isValidYmd(req.query.from) ? req.query.from : firstOfMonth(today);
  let to = isValidYmd(req.query.to) ? req.query.to : today;
  if (to > today) to = today;
  if (from > to) return bad(res, '"From" must be on or before "To"');
  const beforeFrom = addDays(from, -1);
  const inRange = { date: { $gte: from, $lte: to } };
  const before = { date: { $lt: from } };

  const [vendors, vBefore, vRange, staff, sBefore, sRange, vDaily, sDaily] = await Promise.all([
    Vendor.find().sort({ name: 1 }).lean(),
    vendorTotals(before),
    vendorTotals(inRange),
    SalaryStaff.find().sort({ name: 1 }).lean(),
    paymentTotals(before),
    paymentTotals(inRange),
    VendorEntry.aggregate<{ _id: string; billed: number; paid: number }>([
      { $match: inRange },
      { $group: { _id: '$date', billed: { $sum: '$billAmount' }, paid: { $sum: '$paidAmount' } } },
    ]),
    SalaryPayment.aggregate<{ _id: string; paid: number }>([
      { $match: inRange },
      { $group: { _id: '$date', paid: { $sum: '$amount' } } },
    ]),
  ]);

  const vendorRows = vendors
    .map((v) => {
      const b = vBefore.get(v._id.toString()) ?? { billed: 0, paid: 0 };
      const r = vRange.get(v._id.toString()) ?? { billed: 0, paid: 0 };
      const opening = roundMoney(v.openingBalance + b.billed - b.paid);
      return {
        id: v._id,
        name: v.name,
        active: v.active,
        opening,
        billed: roundMoney(r.billed),
        paid: roundMoney(r.paid),
        closing: roundMoney(opening + r.billed - r.paid),
      };
    })
    .filter((v) => v.active || v.opening !== 0 || v.billed || v.paid);

  const staffRows = staff
    .map((s) => {
      const opening = roundMoney(s.openingBalance + salaryEarned(s, s.startDate, beforeFrom) - (sBefore.get(s._id.toString()) ?? 0));
      const earned = salaryEarned(s, from, to);
      const paid = roundMoney(sRange.get(s._id.toString()) ?? 0);
      return {
        id: s._id,
        name: s.name,
        job: s.job,
        active: s.active,
        monthlySalary: rateOn(s, to),
        opening,
        earned,
        paid,
        closing: roundMoney(opening + earned - paid),
      };
    })
    .filter((s) => s.active || s.opening !== 0 || s.earned || s.paid);

  const days = new Map<string, { date: string; vendorBilled: number; vendorPaid: number; salaryPaid: number }>();
  const day = (d: string) => {
    if (!days.has(d)) days.set(d, { date: d, vendorBilled: 0, vendorPaid: 0, salaryPaid: 0 });
    return days.get(d)!;
  };
  for (const r of vDaily) Object.assign(day(r._id), { vendorBilled: roundMoney(r.billed), vendorPaid: roundMoney(r.paid) });
  for (const r of sDaily) day(r._id).salaryPaid = roundMoney(r.paid);
  const daily = [...days.values()].sort((a, b) => b.date.localeCompare(a.date));

  const sum = <T>(rows: T[], key: keyof T) => roundMoney(rows.reduce((s, r) => s + (Number(r[key]) || 0), 0));
  res.json({
    from,
    to,
    vendors: vendorRows,
    staff: staffRows,
    daily,
    totals: {
      vendors: { opening: sum(vendorRows, 'opening'), billed: sum(vendorRows, 'billed'), paid: sum(vendorRows, 'paid'), closing: sum(vendorRows, 'closing') },
      staff: { opening: sum(staffRows, 'opening'), earned: sum(staffRows, 'earned'), paid: sum(staffRows, 'paid'), closing: sum(staffRows, 'closing') },
      paidOut: roundMoney(sum(vendorRows, 'paid') + sum(staffRows, 'paid')),
    },
  });
};
