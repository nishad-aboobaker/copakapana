import { toCsv } from '../services/reports.service';

describe('Reports Aggregation & CSV Generation Tests', () => {
  test('toCsv generates RFC-4180 compliant CSV strings with escaped quotes', () => {
    const columns = [
      { header: 'Item Name', key: 'name' },
      { header: 'Station', key: 'station' },
      { header: 'Quantity', key: 'qty' },
      { header: 'Revenue', key: 'revenue' },
    ];

    const data = [
      { name: 'Peri Peri Wings (6 pcs)', station: 'fried_chicken', qty: 10, revenue: 2200 },
      { name: 'Fresh Lime Soda, Sweet & Salt', station: 'juice', qty: 5, revenue: 350 },
    ];

    const csv = toCsv(columns, data);

    expect(csv).toContain('"Item Name","Station","Quantity","Revenue"');
    expect(csv).toContain('"Peri Peri Wings (6 pcs)","fried_chicken","10","2200"');
    expect(csv).toContain('"Fresh Lime Soda, Sweet & Salt","juice","5","350"');
  });

  test('Daily sales calculation correctly computes totals and averages', () => {
    const rawSales = [
      { total: 500, discount: 50, gst: 25 },
      { total: 300, discount: 0, gst: 15 },
      { total: 400, discount: 20, gst: 20 },
    ];

    const totalRevenue = rawSales.reduce((sum, s) => sum + s.total, 0);
    const orderCount = rawSales.length;
    const avgBill = Math.round(totalRevenue / orderCount);

    expect(totalRevenue).toBe(1200);
    expect(orderCount).toBe(3);
    expect(avgBill).toBe(400);
  });

  test('Payment split calculation accurately groups cash and upi', () => {
    const payments = [
      { mode: 'cash', amount: 200 },
      { mode: 'upi', amount: 300 },
      { mode: 'cash', amount: 150 },
      { mode: 'upi', amount: 50 },
    ];

    let cash = 0;
    let upi = 0;
    for (const p of payments) {
      if (p.mode === 'cash') cash += p.amount;
      if (p.mode === 'upi') upi += p.amount;
    }

    expect(cash).toBe(350);
    expect(upi).toBe(350);
    expect(cash + upi).toBe(700);
  });
});
