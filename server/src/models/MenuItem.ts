import mongoose, { Document, Schema } from 'mongoose';
import { Station } from '../types';

export interface IPortion {
  label: string;
  price: number;
}

export interface IMenuItem extends Document {
  name: string;
  printName?: string;
  categoryId: mongoose.Types.ObjectId;
  price: number;
  station: Station;
  isVeg: boolean;
  description?: string;
  portions: IPortion[];
  available: boolean;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const portionSchema = new Schema<IPortion>(
  {
    label: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const menuItemSchema = new Schema<IMenuItem>(
  {
    name: {
      type: String,
      required: [true, 'Item name is required'],
      trim: true,
    },
    printName: {
      type: String,
      trim: true,
    },
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: 'MenuCategory',
      required: [true, 'Category is required'],
      index: true,
    },
    price: {
      type: Number,
      required: [true, 'Base price is required'],
      min: [0, 'Price must be positive'],
    },
    station: {
      type: String,
      enum: Object.values(Station),
      required: [true, 'Kitchen station is required'],
      index: true,
    },
    isVeg: {
      type: Boolean,
      required: [true, 'isVeg flag is required'],
      default: false,
    },
    description: {
      type: String,
      trim: true,
    },
    portions: [portionSchema],
    available: {
      type: Boolean,
      default: true,
      index: true,
    },
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

menuItemSchema.index({ categoryId: 1, available: 1, active: 1 });

export const MenuItem = mongoose.model<IMenuItem>('MenuItem', menuItemSchema);
