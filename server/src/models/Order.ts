import mongoose, { Document, Schema } from 'mongoose';
import { CustomerSnapshot, ItemStatus, OrderItemShape, OrderStatus, OrderType, Station } from '../types';

export interface IOrderItemDocument extends OrderItemShape {
  _id: mongoose.Types.ObjectId;
}

/** Minimal item shape needed to build a ticket line. */
export type OrderItemLike = Pick<OrderItemShape, 'name' | 'qty' | 'portion' | 'note' | 'station'>;

export interface IOrder extends Document {
  number: number;
  type: OrderType;
  tableId?: mongoose.Types.ObjectId;
  waiterId: mongoose.Types.ObjectId;
  customerId?: mongoose.Types.ObjectId;
  customerSnapshot?: CustomerSnapshot;
  status: OrderStatus;
  items: IOrderItemDocument[];
  clientRequestId?: string;
  appliedRequestIds: string[]; // add-items requests already applied (idempotency)
  createdAt: Date;
  updatedAt: Date;
}

const orderItemSchema = new Schema<IOrderItemDocument>(
  {
    menuItemId: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    qty: {
      type: Number,
      required: true,
      min: 1,
    },
    portion: {
      type: String,
    },
    note: {
      type: String,
      trim: true,
    },
    station: {
      type: String,
      enum: Object.values(Station),
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(ItemStatus),
      default: ItemStatus.Active,
    },
  },
  { _id: true },
);

const orderSchema = new Schema<IOrder>(
  {
    number: {
      type: Number,
      required: true,
    },
    type: {
      type: String,
      enum: Object.values(OrderType),
      required: true,
    },
    tableId: {
      type: Schema.Types.ObjectId,
      ref: 'Table',
    },
    waiterId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'Customer',
    },
    customerSnapshot: {
      name: String,
      phone: String,
      address: String,
    },
    status: {
      type: String,
      enum: Object.values(OrderStatus),
      default: OrderStatus.Open,
      index: true,
    },
    items: [orderItemSchema],
    clientRequestId: {
      type: String,
    },
    appliedRequestIds: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

// Unique partial index: only one open order per table.
// ($ne is not allowed in partial indexes — the old definition silently never got built.)
orderSchema.index(
  { tableId: 1 },
  {
    name: 'one_open_order_per_table',
    unique: true,
    partialFilterExpression: { status: OrderStatus.Open, tableId: { $type: 'objectId' } },
  },
);

// Unique so two concurrent retries of the same offline order can't both insert
orderSchema.index(
  { clientRequestId: 1 },
  { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } },
);

orderSchema.index({ createdAt: -1 });
orderSchema.index({ waiterId: 1, createdAt: -1 });

export const Order = mongoose.model<IOrder>('Order', orderSchema);
