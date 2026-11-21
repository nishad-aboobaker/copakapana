import mongoose, { Document, Schema } from 'mongoose';
import { BillStatus, DiscountShape, PaymentShape } from '../types';

export interface IBillItemSnapshot {
  menuItemId: string;
  name: string;
  price: number;
  qty: number;
  portion?: string;
  note?: string;
  station: string;
}

export interface IBill extends Document {
  number: number;
  orderId: mongoose.Types.ObjectId;
  itemsSnapshot: IBillItemSnapshot[];
  subtotal: number;
  discount?: DiscountShape;
  discountAmount: number;
  gst: number;
  serviceCharge: number;
  total: number;
  payments: PaymentShape[];
  status: BillStatus;
  closedBy?: mongoose.Types.ObjectId;
  closedByName?: string; // cashier printed on the bill
  voidedBy?: mongoose.Types.ObjectId;
  voidReason?: string;
  createdAt: Date;
  paidAt?: Date;
  updatedAt: Date;
}

const billItemSnapshotSchema = new Schema<IBillItemSnapshot>(
  {
    menuItemId: { type: String, required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    qty: { type: Number, required: true },
    portion: String,
    note: String,
    station: String,
  },
  { _id: false },
);

const paymentSchema = new Schema<PaymentShape>(
  {
    mode: { type: String, enum: ['cash', 'upi'], required: true },
    amount: { type: Number, required: true, min: 0 },
    tendered: Number,
    change: Number,
  },
  { _id: false },
);

const discountSchema = new Schema<DiscountShape>(
  {
    type: { type: String, enum: ['flat', 'percent'], required: true },
    value: { type: Number, required: true, min: 0 },
    reason: { type: String, required: true, trim: true },
    appliedBy: { type: String, required: true },
    appliedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const billSchema = new Schema<IBill>(
  {
    number: {
      type: Number,
      required: true,
      unique: true,
    },
    orderId: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      index: true,
    },
    itemsSnapshot: [billItemSnapshotSchema],
    subtotal: {
      type: Number,
      required: true,
      min: 0,
    },
    discount: discountSchema,
    discountAmount: {
      type: Number,
      default: 0,
    },
    gst: {
      type: Number,
      default: 0,
    },
    serviceCharge: {
      type: Number,
      default: 0,
    },
    total: {
      type: Number,
      required: true,
      min: 0,
    },
    payments: [paymentSchema],
    status: {
      type: String,
      enum: Object.values(BillStatus),
      default: BillStatus.Open,
      index: true,
    },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    closedByName: { type: String },
    voidedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    voidReason: String,
    paidAt: {
      type: Date,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

billSchema.index({ createdAt: -1 });

export const Bill = mongoose.model<IBill>('Bill', billSchema);
