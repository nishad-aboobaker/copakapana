import mongoose, { Document, Schema } from 'mongoose';

export interface ISettings extends Document {
  restaurantName: string;
  address: string;
  phone: string; // one or more numbers, separated by commas or new lines
  billFooter: string;
  billFooterNote: string;
  printLogo: boolean;
  gstEnabled: boolean;
  gstRate: number;
  serviceChargeEnabled: boolean;
  serviceChargePercent: number;
  billPrinterIp: string;
  kdsWarnMinutes: number;
  kdsLateMinutes: number;
  kdsSoundEnabled: boolean;
  includeCustomerPiiInExports: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const settingsSchema = new Schema<ISettings>(
  {
    restaurantName: { type: String, default: 'CopaKapana Restaurant' },
    address: { type: String, default: 'Chamravattam' },
    phone: { type: String, default: '9072211810, 9072211820, 9072211830' },
    // Bill footer lines and the printer's stored logo (ESC/POS NV image #1)
    billFooter: { type: String, default: '***Thanks for visiting***' },
    billFooterNote: { type: String, default: '' },
    printLogo: { type: Boolean, default: false },
    gstEnabled: { type: Boolean, default: false },
    gstRate: { type: Number, default: 0 },
    serviceChargeEnabled: { type: Boolean, default: false },
    serviceChargePercent: { type: Number, default: 0 },
    billPrinterIp: { type: String, default: '192.168.1.100' },
    // Station screen (KDS) timer thresholds and alert sound
    kdsWarnMinutes: { type: Number, default: 10, min: 1 },
    kdsLateMinutes: { type: Number, default: 15, min: 1 },
    kdsSoundEnabled: { type: Boolean, default: true },
    includeCustomerPiiInExports: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  },
);

export const Settings = mongoose.model<ISettings>('Settings', settingsSchema);
