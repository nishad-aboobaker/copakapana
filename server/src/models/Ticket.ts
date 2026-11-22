import mongoose, { Document, Schema } from 'mongoose';
import { TicketStatus, OrderType, Station } from '../types';

export interface ITicketItem {
  name: string;
  qty: number;
  portion?: string;
  note?: string;
}

/**
 * Snapshot of the order context at the time the ticket was created, so a station
 * screen can render the card without joining Order / Table / User.
 */
export interface ITicketContext {
  orderNumber: number;
  orderType: OrderType;
  tableLabel?: string;
  floor?: string;
  waiterId?: string;
  waiterName?: string;
  customerName?: string;
  customerPhone?: string;
}

export interface ITicket extends Document {
  number: number;
  orderId: mongoose.Types.ObjectId;
  station: Station;
  context: ITicketContext;
  items: ITicketItem[];
  isEdited: boolean;
  againstTicketNumber?: number;
  addedItems: ITicketItem[];
  cancelledItems: ITicketItem[];
  // Kitchen workflow — the only mutable part of a ticket
  status: TicketStatus;
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

const ticketItemSchema = new Schema<ITicketItem>(
  {
    name: { type: String, required: true },
    qty: { type: Number, required: true },
    portion: String,
    note: String,
  },
  { _id: false },
);

const ticketContextSchema = new Schema<ITicketContext>(
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

const ticketSchema = new Schema<ITicket>(
  {
    number: { type: Number, required: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    station: { type: String, enum: Object.values(Station), required: true, index: true },
    context: { type: ticketContextSchema, required: true },
    items: [ticketItemSchema],
    isEdited: { type: Boolean, default: false },
    againstTicketNumber: Number,
    addedItems: [ticketItemSchema],
    cancelledItems: [ticketItemSchema],
    status: { type: String, enum: Object.values(TicketStatus), default: TicketStatus.New, index: true },
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

ticketSchema.index({ orderId: 1, createdAt: 1 });
ticketSchema.index({ station: 1, status: 1, createdAt: 1 });

export const Ticket = mongoose.model<ITicket>('Ticket', ticketSchema);
