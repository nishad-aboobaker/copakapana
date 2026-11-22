// All shared enums and interfaces for the ticket & Billing system

// ─── Roles ───────────────────────────────────────────────────────────────────
export enum Role {
  Waiter = 'waiter',
  Cashier = 'cashier',
  Manager = 'manager',
  Owner = 'owner',
  // Station screen (KDS) device account — bound to one kitchen station.
  // Sits below every staff role and is rejected by all staff endpoints.
  Kitchen = 'kitchen',
}

// Role hierarchy — higher number = more permissions
export const RoleLevel: Record<Role, number> = {
  [Role.Kitchen]: -1,
  [Role.Waiter]: 0,
  [Role.Cashier]: 1,
  [Role.Manager]: 2,
  [Role.Owner]: 3,
};

// ─── Tables ───────────────────────────────────────────────────────────────────
export enum TableFloor {
  Ground = 'ground',
  First = 'first',
}

export enum TableStatus {
  Free = 'free',
  Occupied = 'occupied',
  Billing = 'billing',
}

// ─── Menu ────────────────────────────────────────────────────────────────────
export enum Station {
  FriedChicken = 'fried_chicken',
  Juice = 'juice',
  Main = 'main',
}

// ─── Orders ──────────────────────────────────────────────────────────────────
export enum OrderType {
  DineIn = 'dine_in',
  Takeaway = 'takeaway',
  Delivery = 'delivery',
}

export enum OrderStatus {
  Open = 'open',
  Billed = 'billed',
  Paid = 'paid',
  Cancelled = 'cancelled',
}

export enum ItemStatus {
  Active = 'active',
  Cancelled = 'cancelled',
}

// ─── ticket (station screens) ───────────────────────────────────────────────────
export enum TicketStatus {
  New = 'new',
  Preparing = 'preparing',
  Ready = 'ready',
  Served = 'served',
}

// ─── Print jobs (bill printer only) ──────────────────────────────────────────
export enum PrintStatus {
  Pending = 'pending',
  Printed = 'printed',
  Failed = 'failed',
}

// ─── Billing ─────────────────────────────────────────────────────────────────
export enum BillStatus {
  Open = 'open',
  Paid = 'paid',
  Void = 'void',
}

export enum DiscountType {
  Flat = 'flat',
  Percent = 'percent',
}

export enum PaymentMode {
  Cash = 'cash',
  UPI = 'upi',
}

// ─── Shared Interfaces ───────────────────────────────────────────────────────
export interface OrderItemShape {
  menuItemId: string;
  name: string;
  price: number;
  qty: number;
  portion?: string;
  note?: string;
  station: Station;
  status: ItemStatus;
}

export interface CustomerSnapshot {
  name: string;
  phone: string;
  address?: string;
}

export interface PaymentShape {
  mode: PaymentMode;
  amount: number;
  tendered?: number;
  change?: number;
}

export interface DiscountShape {
  type: DiscountType;
  value: number;
  reason: string;
  appliedBy: string;
  appliedAt: Date;
}

// ─── Socket Event Payloads ───────────────────────────────────────────────────
export interface PrintJobPayload {
  jobId: string;
  printerIp: string;
  type: 'bill' | 'test';
  isReprint?: boolean;
  [key: string]: unknown;
}

export interface PrintResultPayload {
  jobId: string;
  status: 'printed' | 'failed';
  error?: string;
}

// ─── Express augmentation ────────────────────────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        name: string;
        role: Role;
        station?: Station;
      };
    }
  }
}
