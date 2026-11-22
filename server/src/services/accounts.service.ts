import { ISalaryStaff } from '../models/SalaryStaff';
import { addDays, daysInMonth, maxYmd, minYmd } from '../utils/ymd';

export const roundMoney = (n: number): number => Math.round(n * 100) / 100;

/** Monthly salary in force on a given day (the latest rate whose start is on or before it). */
export const rateOn = (staff: Pick<ISalaryStaff, 'rates'>, ymd: string): number => {
  const rates = [...(staff.rates ?? [])].sort((a, b) => a.from.localeCompare(b.from));
  if (rates.length === 0) return 0;
  let rate = rates[0].monthly;
  for (const r of rates) if (r.from <= ymd) rate = r.monthly;
  return rate;
};

/**
 * Salary earned between two business dates (inclusive), day by day:
 * each day earns that month's salary ÷ the number of days in that month.
 * Days before the start date or after the end date earn nothing. Rounded to whole rupees.
 */
export const salaryEarned = (
  staff: Pick<ISalaryStaff, 'rates' | 'startDate' | 'endDate'>,
  from: string,
  to: string,
): number => {
  const start = maxYmd(from, staff.startDate);
  const end = staff.endDate ? minYmd(to, staff.endDate) : to;
  if (start > end) return 0;
  let total = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    total += rateOn(staff, d) / daysInMonth(d);
  }
  return Math.round(total);
};
