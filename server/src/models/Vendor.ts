import mongoose, { Document, Schema } from 'mongoose';

/** A supplier the restaurant buys from on credit (Accounts → Vendors). */
export interface IVendor extends Document {
  name: string;
  phone?: string;
  note?: string;
  /** Outstanding balance owed to the vendor when they were added (OB). */
  openingBalance: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const vendorSchema = new Schema<IVendor>(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    note: { type: String, trim: true },
    openingBalance: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Vendor = mongoose.model<IVendor>('Vendor', vendorSchema);

/** One line in a vendor's ledger: the day's bill and/or what was paid to them. */
export interface IVendorEntry extends Document {
  vendorId: mongoose.Types.ObjectId;
  /** Business date, 'YYYY-MM-DD' (India time). */
  date: string;
  billAmount: number;
  paidAmount: number;
  mode?: 'cash' | 'upi' | 'bank';
  note?: string;
  createdBy?: mongoose.Types.ObjectId;
  createdByName?: string;
  createdAt: Date;
}

const vendorEntrySchema = new Schema<IVendorEntry>(
  {
    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    date: { type: String, required: true, index: true },
    billAmount: { type: Number, default: 0, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 },
    mode: { type: String, enum: ['cash', 'upi', 'bank'] },
    note: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String },
  },
  { timestamps: true },
);

export const VendorEntry = mongoose.model<IVendorEntry>('VendorEntry', vendorEntrySchema);
