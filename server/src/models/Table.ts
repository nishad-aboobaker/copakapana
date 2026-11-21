import mongoose, { Document, Schema } from 'mongoose';
import { TableFloor, TableStatus } from '../types';

export interface ITable extends Document {
  name: string;
  number: string | number;
  floor: TableFloor;
  capacity: number;
  status: TableStatus;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const tableSchema = new Schema<ITable>(
  {
    name: {
      type: String,
      required: [true, 'Table name/identifier is required'],
      unique: true,
      trim: true,
    },
    number: {
      type: Schema.Types.Mixed,
      trim: true,
    },
    floor: {
      type: String,
      enum: Object.values(TableFloor),
      required: [true, 'Floor is required'],
    },
    capacity: {
      type: Number,
      required: [true, 'Capacity is required'],
      min: [1, 'Capacity must be at least 1'],
    },
    status: {
      type: String,
      enum: Object.values(TableStatus),
      default: TableStatus.Free,
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

tableSchema.pre('validate', function (next) {
  if (!this.name && this.number !== undefined && this.number !== null) {
    this.name = String(this.number).trim();
  }
  if ((this.number === undefined || this.number === null) && this.name) {
    this.number = this.name;
  }
  next();
});

tableSchema.index({ floor: 1 });
tableSchema.index({ status: 1 });

export const Table = mongoose.model<ITable>('Table', tableSchema);
