import { Request, Response } from 'express';
import { ReportsService, toCsv } from '../services/reports.service';

export const getDailyReport = async (req: Request, res: Response): Promise<void> => {
  const { from, to, format } = req.query;
  const data = await ReportsService.getDailySales(from as string, to as string);

  if (format === 'csv') {
    const csv = toCsv(
      [
        { header: 'Date', key: 'date' },
        { header: 'Orders Count', key: 'orderCount' },
        { header: 'Total Revenue (INR)', key: 'totalRevenue' },
        { header: 'Average Bill (INR)', key: 'avgBill' },
        { header: 'Discounts (INR)', key: 'totalDiscount' },
        { header: 'GST Collected (INR)', key: 'totalGst' },
      ],
      data,
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="daily_sales.csv"');
    res.send(csv);
    return;
  }

  res.json({ report: data });
};

export const getItemsReport = async (req: Request, res: Response): Promise<void> => {
  const { from, to, station, format } = req.query;
  const data = await ReportsService.getItemSales(from as string, to as string, station as string);

  if (format === 'csv') {
    const csv = toCsv(
      [
        { header: 'Item Name', key: 'name' },
        { header: 'Station', key: 'station' },
        { header: 'Quantity Sold', key: 'totalQty' },
        { header: 'Total Revenue (INR)', key: 'totalRevenue' },
      ],
      data,
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="item_sales.csv"');
    res.send(csv);
    return;
  }

  res.json({ report: data });
};

export const getPaymentsReport = async (req: Request, res: Response): Promise<void> => {
  const { from, to, format } = req.query;
  const data = await ReportsService.getPaymentSplit(from as string, to as string);

  if (format === 'csv') {
    const csv = toCsv(
      [
        { header: 'Payment Mode', key: '_id' },
        { header: 'Amount (INR)', key: 'totalAmount' },
        { header: 'Transactions Count', key: 'count' },
      ],
      data.details,
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="payment_split.csv"');
    res.send(csv);
    return;
  }

  res.json({ report: data });
};

export const getOrderTypesReport = async (req: Request, res: Response): Promise<void> => {
  const { from, to, format } = req.query;
  const data = await ReportsService.getOrderTypeSplit(from as string, to as string);

  if (format === 'csv') {
    const csv = toCsv(
      [
        { header: 'Order Type', key: 'type' },
        { header: 'Orders Count', key: 'orderCount' },
        { header: 'Revenue (INR)', key: 'totalRevenue' },
      ],
      data,
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="order_types.csv"');
    res.send(csv);
    return;
  }

  res.json({ report: data });
};

export const getWaitersReport = async (req: Request, res: Response): Promise<void> => {
  const { from, to, format } = req.query;
  const data = await ReportsService.getWaiterSales(from as string, to as string);

  if (format === 'csv') {
    const csv = toCsv(
      [
        { header: 'Waiter Name', key: 'name' },
        { header: 'Orders Handled', key: 'orderCount' },
        { header: 'Total Revenue (INR)', key: 'totalRevenue' },
      ],
      data,
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="waiter_sales.csv"');
    res.send(csv);
    return;
  }

  res.json({ report: data });
};

export const getKitchenReport = async (req: Request, res: Response): Promise<void> => {
  const { from, to, format } = req.query;
  const data = await ReportsService.getKitchenPerformance(from as string, to as string);

  if (format === 'csv') {
    const csv = toCsv(
      [
        { header: 'Station', key: 'station' },
        { header: 'Tickets', key: 'ticketCount' },
        { header: 'Edited tickets', key: 'editedCount' },
        { header: 'Avg Sent-to-Ready (min)', key: 'avgPrepMinutes' },
        { header: 'Longest Sent-to-Ready (min)', key: 'maxPrepMinutes' },
      ],
      data,
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="kitchen_performance.csv"');
    res.send(csv);
    return;
  }

  res.json({ report: data });
};

export const getEodReport = async (req: Request, res: Response): Promise<void> => {
  const { date } = req.query;
  const data = await ReportsService.getEODSummary(date as string);
  res.json({ eod: data });
};
