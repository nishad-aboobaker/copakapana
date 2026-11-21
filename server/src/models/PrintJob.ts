import mongoose, { Document, Schema } from 'mongoose';
import { PrintStatus } from '../types';

export interface IPrintJob extends Document {
  targetIp: string;
  station?: string;
  type: 'bill' | 'test';
  payload: Record<string, unknown>;
  status: PrintStatus;
  attempts: number;
  lastError?: string;
  dispatchedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const printJobSchema = new Schema<IPrintJob>(
  {
    targetIp: {
      type: String,
      required: true,
      index: true,
    },
    station: {
      type: String,
      index: true,
    },
    type: {
      type: String,
      enum: ['bill', 'test'],
      required: true,
    },
    payload: {
      type: Schema.Types.Mixed,
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(PrintStatus),
      default: PrintStatus.Pending,
      index: true,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    lastError: {
      type: String,
    },
    dispatchedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  },
);

printJobSchema.index({ status: 1, createdAt: 1 });

export const PrintJob = mongoose.model<IPrintJob>('PrintJob', printJobSchema);
