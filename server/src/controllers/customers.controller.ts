import { Request, Response } from 'express';
import { Customer } from '../models/Customer';

export const lookupCustomer = async (req: Request, res: Response): Promise<void> => {
  const phone = (req.query.phone as string)?.trim();
  if (!phone || phone.length < 10) {
    res.status(400).json({ code: 'INVALID_PHONE', message: 'Valid 10-digit phone number is required' });
    return;
  }

  const customer = await Customer.findOne({ phone });
  if (!customer) {
    res.status(404).json({ found: false, message: 'Customer not found' });
    return;
  }

  res.json({
    found: true,
    customer: {
      _id: customer._id,
      phone: customer.phone,
      name: customer.name,
      orderCount: customer.orderCount,
      lastOrderAt: customer.lastOrderAt,
      addresses: customer.addresses.map((a) => ({
        label: a.label,
        text: a.text,
        isDefault: a.isDefault,
      })),
    },
  });
};
