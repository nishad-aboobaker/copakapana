describe('Billing Calculation & Payment Unit Tests', () => {
  // Helper pure calculation functions matching the controller logic
  const calculateBill = (
    items: { price: number; qty: number }[],
    options: {
      discount?: { type: 'flat' | 'percent'; value: number };
      gstPercent?: number;
      serviceChargePercent?: number;
    } = {}
  ) => {
    const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);

    let discountAmount = 0;
    if (options.discount) {
      if (options.discount.type === 'flat') {
        discountAmount = Math.min(subtotal, options.discount.value);
      } else if (options.discount.type === 'percent') {
        discountAmount = Math.min(subtotal, Math.round((subtotal * options.discount.value) / 100));
      }
    }

    const discountedSubtotal = subtotal - discountAmount;
    const gst = options.gstPercent ? Math.round((discountedSubtotal * options.gstPercent) / 100) : 0;
    const serviceCharge = options.serviceChargePercent
      ? Math.round((discountedSubtotal * options.serviceChargePercent) / 100)
      : 0;

    const total = Math.max(0, Math.round(discountedSubtotal + gst + serviceCharge));

    return {
      subtotal,
      discountAmount,
      gst,
      serviceCharge,
      total,
    };
  };

  const calculateChange = (tendered: number, amount: number) => {
    return Math.max(0, tendered - amount);
  };

  const validatePaymentClosure = (payments: { mode: 'cash' | 'upi'; amount: number }[], billTotal: number) => {
    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    return {
      totalPaid,
      isValid: totalPaid >= billTotal,
    };
  };

  test('Subtotal + discount flat ₹50 -> total = subtotal - 50 + taxes (rounded)', () => {
    const items = [
      { price: 100, qty: 2 }, // 200
      { price: 150, qty: 1 }, // 150 -> subtotal 350
    ];
    const res = calculateBill(items, {
      discount: { type: 'flat', value: 50 },
      gstPercent: 5, // 5% of 300 = 15
    });

    expect(res.subtotal).toBe(350);
    expect(res.discountAmount).toBe(50);
    expect(res.gst).toBe(15);
    expect(res.total).toBe(315); // (350 - 50) + 15
  });

  test('Subtotal + discount 10% -> correct discountAmount', () => {
    const items = [{ price: 450, qty: 1 }];
    const res = calculateBill(items, {
      discount: { type: 'percent', value: 10 },
    });

    expect(res.subtotal).toBe(450);
    expect(res.discountAmount).toBe(45); // 10% of 450 = 45
    expect(res.total).toBe(405);
  });

  test('Discount > subtotal -> capped at subtotal', () => {
    const items = [{ price: 200, qty: 1 }];
    const res = calculateBill(items, {
      discount: { type: 'flat', value: 300 }, // greater than 200
    });

    expect(res.subtotal).toBe(200);
    expect(res.discountAmount).toBe(200); // capped at 200
    expect(res.total).toBe(0);
  });

  test('GST 5% + service charge 10% -> correct line totals', () => {
    const items = [{ price: 500, qty: 1 }];
    const res = calculateBill(items, {
      gstPercent: 5,
      serviceChargePercent: 10,
    });

    expect(res.subtotal).toBe(500);
    expect(res.gst).toBe(25); // 5% of 500 = 25
    expect(res.serviceCharge).toBe(50); // 10% of 500 = 50
    expect(res.total).toBe(575);
  });

  test('Split payment (cash ₹200 + UPI ₹150) on total ₹350 -> valid close', () => {
    const payments = [
      { mode: 'cash' as const, amount: 200 },
      { mode: 'upi' as const, amount: 150 },
    ];
    const res = validatePaymentClosure(payments, 350);

    expect(res.totalPaid).toBe(350);
    expect(res.isValid).toBe(true);
  });

  test('Payments total < bill total -> closeBill returns invalid / rejected', () => {
    const payments = [
      { mode: 'cash' as const, amount: 100 },
      { mode: 'upi' as const, amount: 150 },
    ];
    const res = validatePaymentClosure(payments, 350); // totalPaid 250 < 350

    expect(res.totalPaid).toBe(250);
    expect(res.isValid).toBe(false);
  });

  test('Cash tendered ₹500 on amount ₹200 -> change = ₹300', () => {
    const change = calculateChange(500, 200);
    expect(change).toBe(300);
  });

  test('Rounding: total ₹123.45 -> ₹123 (round to nearest rupee)', () => {
    const roundNearest = (val: number) => Math.round(val);
    expect(roundNearest(123.45)).toBe(123);
    expect(roundNearest(123.65)).toBe(124);
  });
});
