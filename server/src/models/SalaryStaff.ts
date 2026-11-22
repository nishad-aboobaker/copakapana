import mongoose, { Document, Schema } from 'mongoose';

export interface ISalaryRate {
  /** Rate applies from this business date ('YYYY-MM-DD'). */
  from: string;
  monthly: number;
}

/**
 * A person on the payroll (Accounts → Staff salary). Separate from app logins:
 * cooks, cleaners and anyone else can be added by name. Salary is earned day by day
 * (monthly salary ÷ days in that month).
 */
export interface ISalaryStaff extends Document {
  name: string;
  phone?: string;
  job?: string;
  /** Salary still owed to them when they were added. */
  openingBalance: number;
  /** First day salary is earned. */
  startDate: string;
  /** Last day salary is earned (set when they leave). */
  endDate?: string;
  rates: ISalaryRate[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const salaryStaffSchema = new Schema<ISalaryStaff>(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    job: { type: String, trim: true },
    openingBalance: { type: Number, default: 0 },
    startDate: { type: String, required: true },
    endDate: { type: String },
    rates: {
      type: [new Schema<ISalaryRate>({ from: { type: String, required: true }, monthly: { type: Number, required: true, min: 0 } }, { _id: false })],
      default: [],
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const SalaryStaff = mongoose.model<ISalaryStaff>('SalaryStaff', salaryStaffSchema);

/** Money paid to a staff member (daily payments, advances). */
export interface ISalaryPayment extends Document {
  staffId: mongoose.Types.ObjectId;
  date: string;
  amount: number;
  mode?: 'cash' | 'upi' | 'bank';
  note?: string;
  createdBy?: mongoose.Types.ObjectId;
  createdByName?: string;
  createdAt: Date;
}

const salaryPaymentSchema = new Schema<ISalaryPayment>(
  {
    staffId: { type: Schema.Types.ObjectId, ref: 'SalaryStaff', required: true, index: true },
    date: { type: String, required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    mode: { type: String, enum: ['cash', 'upi', 'bank'] },
    note: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String },
  },
  { timestamps: true },
);

export const SalaryPayment = mongoose.model<ISalaryPayment>('SalaryPayment', salaryPaymentSchema);
