import mongoose, { Document, Schema } from 'mongoose';

export interface ICustomerAddress {
  label?: string;
  text: string;
  isDefault: boolean;
}

export interface ICustomer extends Document {
  phone: string;
  name: string;
  addresses: ICustomerAddress[];
  orderCount: number;
  lastOrderAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const customerAddressSchema = new Schema<ICustomerAddress>(
  {
    label: { type: String, default: 'Home' },
    text: { type: String, required: true },
    isDefault: { type: Boolean, default: false },
  },
  { _id: false },
);

const customerSchema = new Schema<ICustomer>(
  {
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    addresses: {
      type: [customerAddressSchema],
      default: [],
    },
    orderCount: {
      type: Number,
      default: 0,
    },
    lastOrderAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  },
);

export const Customer = mongoose.model<ICustomer>('Customer', customerSchema);
