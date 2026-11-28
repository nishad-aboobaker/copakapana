import mongoose, { Document, Schema } from 'mongoose';

/**
 * One trading day of the counter (e.g. 11 am → 1 am next morning). Every bill settled while
 * the day is open is filed under its `date`, even after midnight. "Close counter" ends it.
 */
export interface IBusinessDay extends Document {
  /** The business date, 'YYYY-MM-DD' — the day the counter opened. */
  date: string;
  openedAt: Date;
  closedAt?: Date;
  closedBy?: mongoose.Types.ObjectId;
  /** Name of who closed it, or "Automatic" when it was closed at the cut-off. */
  closedByName?: string;
  /** Sales snapshot taken at close. */
  summary?: {
    bills: number;
    total: number;
    cash: number;
    upi: number;
    discount: number;
    openOrders: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

const businessDaySchema = new Schema<IBusinessDay>(
  {
    date: { type: String, required: true, unique: true },
    openedAt: { type: Date, required: true },
    closedAt: { type: Date, index: true },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    closedByName: { type: String },
    summary: {
      bills: Number,
      total: Number,
      cash: Number,
      upi: Number,
      discount: Number,
      openOrders: Number,
    },
  },
  { timestamps: true },
);

export const BusinessDay = mongoose.model<IBusinessDay>('BusinessDay', businessDaySchema);
