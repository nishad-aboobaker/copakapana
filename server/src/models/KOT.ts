import mongoose, { Document, Schema } from 'mongoose';
import { KotStatus, OrderType, Station } from '../types';

export interface IKOTItem {
  name: string;
  qty: number;
  portion?: string;
  note?: string;
}

/**
 * Snapshot of the order context at the time the KOT was created, so a station
 * screen can render the card without joining Order / Table / User.
 */
export interface IKOTContext {
  orderNumber: number;
  orderType: OrderType;
  tableLabel?: string;
  floor?: string;
  waiterId?: string;
  waiterName?: string;
  customerName?: string;
  customerPhone?: string;
}

export interface IKOT extends Document {
  number: number;
  orderId: mongoose.Types.ObjectId;
  station: Station;
  context: IKOTContext;
  items: IKOTItem[];
  isEdited: boolean;
  againstKotNumber?: number;
  addedItems: IKOTItem[];
  cancelledItems: IKOTItem[];
  // Kitchen workflow — the only mutable part of a KOT
  status: KotStatus;
  deliveredAt?: Date; // first time a station screen confirmed display
  startedAt?: Date;
  readyAt?: Date;
  servedAt?: Date;
  lastStatusBy?: mongoose.Types.ObjectId;
  resendCount: number;
  lastResentAt?: Date;
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const kotItemSchema = new Schema<IKOTItem>(
  {
    name: { type: String, required: true },
    qty: { type: Number, required: true },
    portion: String,
    note: String,
  },
  { _id: false },
);

const kotContextSchema = new Schema<IKOTContext>(
  {
    orderNumber: { type: Number, required: true },
    orderType: { type: String, enum: Object.values(OrderType), required: true },
    tableLabel: String,
    floor: String,
    waiterId: String,
    waiterName: String,
    customerName: String,
    customerPhone: String,
  },
  { _id: false },
);

const kotSchema = new Schema<IKOT>(
  {
    number: { type: Number, required: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    station: { type: String, enum: Object.values(Station), required: true, index: true },
    context: { type: kotContextSchema, required: true },
    items: [kotItemSchema],
    isEdited: { type: Boolean, default: false },
    againstKotNumber: Number,
    addedItems: [kotItemSchema],
    cancelledItems: [kotItemSchema],
    status: { type: String, enum: Object.values(KotStatus), default: KotStatus.New, index: true },
    deliveredAt: Date,
    startedAt: Date,
    readyAt: Date,
    servedAt: Date,
    lastStatusBy: { type: Schema.Types.ObjectId, ref: 'User' },
    resendCount: { type: Number, default: 0 },
    lastResentAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

kotSchema.index({ orderId: 1, createdAt: 1 });
kotSchema.index({ station: 1, status: 1, createdAt: 1 });

export const KOT = mongoose.model<IKOT>('KOT', kotSchema);
