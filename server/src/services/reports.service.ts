import mongoose from 'mongoose';
import { Bill } from '../models/Bill';
import { KOT } from '../models/KOT';
import { BillStatus } from '../types';

/** Today's date (YYYY-MM-DD) in the restaurant's timezone. */
export function todayIST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  );
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Day boundaries in Asia/Kolkata (PRD), independent of the server's own timezone.
 * `from`/`to` are YYYY-MM-DD; both default to today (IST).
 */
export function parseDateRange(fromStr?: string, toStr?: string): { startDate: Date; endDate: Date } {
  const from = fromStr && DATE_RE.test(fromStr) ? fromStr : todayIST();
  const to = toStr && DATE_RE.test(toStr) ? toStr : from;
  const startDate = new Date(`${from}T00:00:00.000+05:30`);
  const endDate = new Date(`${to}T23:59:59.999+05:30`);
  return { startDate, endDate };
}

export function toCsv(columns: { header: string; key: string }[], data: any[]): string {
  const headerRow = columns.map((c) => `"${c.header.replace(/"/g, '""')}"`).join(',');
  const dataRows = data.map((row) =>
    columns
      .map((c) => {
        const val = row[c.key] !== undefined && row[c.key] !== null ? String(row[c.key]) : '';
        return `"${val.replace(/"/g, '""')}"`;
      })
      .join(','),
  );
  return [headerRow, ...dataRows].join('\r\n');
}

export class ReportsService {
  /**
   * Daily sales aggregation grouped by day
   */
  public static async getDailySales(from?: string, to?: string) {
    const { startDate, endDate } = parseDateRange(from, to);

    const matchStage = {
      status: BillStatus.Paid,
      paidAt: { $gte: startDate, $lte: endDate },
    };

    const results = await Bill.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$paidAt', timezone: 'Asia/Kolkata' },
          },
          totalRevenue: { $sum: '$total' },
          orderCount: { $sum: 1 },
          totalSubtotal: { $sum: '$subtotal' },
          totalDiscount: { $sum: '$discountAmount' },
          totalGst: { $sum: '$gst' },
        },
      },
      {
        $project: {
          _id: 0,
          date: '$_id',
          totalRevenue: 1,
          orderCount: 1,
          avgBill: {
            $cond: [{ $eq: ['$orderCount', 0] }, 0, { $round: [{ $divide: ['$totalRevenue', '$orderCount'] }, 0] }],
          },
          totalDiscount: 1,
          totalGst: 1,
        },
      },
      { $sort: { date: 1 } },
    ]);

    return results;
  }

  /**
   * Item-wise sales breakdown with optional station filter
   */
  public static async getItemSales(from?: string, to?: string, station?: string) {
    const { startDate, endDate } = parseDateRange(from, to);

    const matchStage: any = {
      status: BillStatus.Paid,
      paidAt: { $gte: startDate, $lte: endDate },
    };

    const pipeline: any[] = [
      { $match: matchStage },
      { $unwind: '$itemsSnapshot' },
    ];

    if (station && station !== 'all') {
      pipeline.push({ $match: { 'itemsSnapshot.station': station } });
    }

    pipeline.push(
      {
        $group: {
          _id: {
            menuItemId: '$itemsSnapshot.menuItemId',
            name: '$itemsSnapshot.name',
            station: '$itemsSnapshot.station',
          },
          totalQty: { $sum: '$itemsSnapshot.qty' },
          totalRevenue: { $sum: { $multiply: ['$itemsSnapshot.price', '$itemsSnapshot.qty'] } },
        },
      },
      {
        $project: {
          _id: 0,
          menuItemId: '$_id.menuItemId',
          name: '$_id.name',
          station: '$_id.station',
          totalQty: 1,
          totalRevenue: 1,
        },
      },
      { $sort: { totalRevenue: -1 } },
    );

    return Bill.aggregate(pipeline);
  }

  /**
   * Payment split (Cash vs UPI)
   */
  public static async getPaymentSplit(from?: string, to?: string) {
    const { startDate, endDate } = parseDateRange(from, to);

    const matchStage = {
      status: BillStatus.Paid,
      paidAt: { $gte: startDate, $lte: endDate },
    };

    const results = await Bill.aggregate([
      { $match: matchStage },
      { $unwind: '$payments' },
      {
        $group: {
          _id: '$payments.mode',
          totalAmount: { $sum: '$payments.amount' },
          count: { $sum: 1 },
        },
      },
    ]);

    let cash = 0;
    let upi = 0;
    for (const r of results) {
      if (r._id === 'cash') cash = r.totalAmount;
      if (r._id === 'upi') upi = r.totalAmount;
    }

    return {
      cash,
      upi,
      total: cash + upi,
      details: results,
    };
  }

  /**
   * Order type breakdown (Dine-in vs Takeaway vs Delivery)
   */
  public static async getOrderTypeSplit(from?: string, to?: string) {
    const { startDate, endDate } = parseDateRange(from, to);

    const results = await Bill.aggregate([
      {
        $match: {
          status: BillStatus.Paid,
          paidAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $lookup: {
          from: 'orders',
          localField: 'orderId',
          foreignField: '_id',
          as: 'order',
        },
      },
      { $unwind: '$order' },
      {
        $group: {
          _id: '$order.type',
          orderCount: { $sum: 1 },
          totalRevenue: { $sum: '$total' },
        },
      },
      {
        $project: {
          _id: 0,
          type: '$_id',
          orderCount: 1,
          totalRevenue: 1,
        },
      },
    ]);

    return results;
  }

  /**
   * Waiter-wise performance sales
   */
  public static async getWaiterSales(from?: string, to?: string) {
    const { startDate, endDate } = parseDateRange(from, to);

    const results = await Bill.aggregate([
      {
        $match: {
          status: BillStatus.Paid,
          paidAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $lookup: {
          from: 'orders',
          localField: 'orderId',
          foreignField: '_id',
          as: 'order',
        },
      },
      { $unwind: '$order' },
      {
        $lookup: {
          from: 'users',
          localField: 'order.waiterId',
          foreignField: '_id',
          as: 'waiter',
        },
      },
      { $unwind: { path: '$waiter', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: '$order.waiterId',
          waiterName: { $first: '$waiter.name' },
          orderCount: { $sum: 1 },
          totalRevenue: { $sum: '$total' },
        },
      },
      {
        $project: {
          _id: 0,
          waiterId: '$_id',
          name: { $ifNull: ['$waiterName', 'Counter / Unknown'] },
          orderCount: 1,
          totalRevenue: 1,
        },
      },
      { $sort: { totalRevenue: -1 } },
    ]);

    return results;
  }

  /**
   * Kitchen performance per station: KOT count, average and longest sent→ready (minutes).
   */
  public static async getKitchenPerformance(from?: string, to?: string) {
    const { startDate, endDate } = parseDateRange(from, to);

    return KOT.aggregate([
      { $match: { createdAt: { $gte: startDate, $lte: endDate }, readyAt: { $exists: true } } },
      { $project: { station: 1, isEdited: 1, prepMs: { $subtract: ['$readyAt', '$createdAt'] } } },
      {
        $group: {
          _id: '$station',
          kotCount: { $sum: 1 },
          editedCount: { $sum: { $cond: ['$isEdited', 1, 0] } },
          avgPrepMs: { $avg: '$prepMs' },
          maxPrepMs: { $max: '$prepMs' },
        },
      },
      {
        $project: {
          _id: 0,
          station: '$_id',
          kotCount: 1,
          editedCount: 1,
          avgPrepMinutes: { $round: [{ $divide: ['$avgPrepMs', 60000] }, 1] },
          maxPrepMinutes: { $round: [{ $divide: ['$maxPrepMs', 60000] }, 1] },
        },
      },
      { $sort: { station: 1 } },
    ]);
  }

  /**
   * End of Day (EOD) Summary for a single date
   */
  public static async getEODSummary(dateStr?: string) {
    const date = dateStr && DATE_RE.test(dateStr) ? dateStr : todayIST();
    const [daily, items, payments, orderTypes, waiters] = await Promise.all([
      this.getDailySales(date, date),
      this.getItemSales(date, date),
      this.getPaymentSplit(date, date),
      this.getOrderTypeSplit(date, date),
      this.getWaiterSales(date, date),
    ]);

    const daySummary = daily.length > 0 ? daily[0] : { totalRevenue: 0, orderCount: 0, avgBill: 0 };

    return {
      date,
      summary: daySummary,
      payments,
      orderTypes,
      topItems: items.slice(0, 10),
      waiters,
    };
  }
}
