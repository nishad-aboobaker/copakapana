import mongoose, { Document, Model, Schema } from 'mongoose';
import bcrypt from 'bcryptjs';
import { Role, Station } from '../types';

const PIN_ROLES: Role[] = [Role.Waiter, Role.Kitchen, Role.Delivery];
export const usesPin = (role: Role): boolean => PIN_ROLES.includes(role);

export interface IUser extends Document {
  name: string;
  role: Role;
  station?: Station; // only for kitchen (station screen) accounts
  pinHash?: string;
  passwordHash?: string;
  active: boolean;
  failedLoginAttempts: number;
  lockedUntil?: Date;
  refreshToken?: string;
  createdAt: Date;
  updatedAt: Date;
  comparePin(pin: string): Promise<boolean>;
  comparePassword(password: string): Promise<boolean>;
}

export interface IUserModel extends Model<IUser> {
  hashPin(pin: string): Promise<string>;
  hashPassword(password: string): Promise<string>;
}

const userSchema = new Schema<IUser>(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      unique: true,
      trim: true,
    },
    role: {
      type: String,
      enum: Object.values(Role),
      required: [true, 'Role is required'],
    },
    station: {
      type: String,
      enum: Object.values(Station),
    },
    // Never returned by default (also not via populate) — opt in with .select('+pinHash +passwordHash')
    pinHash: {
      type: String,
      select: false,
    },
    passwordHash: {
      type: String,
      select: false,
    },
    active: {
      type: Boolean,
      default: true,
    },
    failedLoginAttempts: {
      type: Number,
      default: 0,
    },
    lockedUntil: {
      type: Date,
    },
    refreshToken: {
      type: String,
    },
  },
  {
    timestamps: true,
  },
);

userSchema.pre('save', function (next) {
  // Credential checks only when the account is created or its role changes
  // (hashes are not loaded on ordinary saves because they are select: false).
  if (!this.isNew && !this.isModified('role')) return next();
  if (usesPin(this.role) && !this.pinHash) {
    return next(new Error('Waiters and station screens must have a PIN'));
  }
  if (!usesPin(this.role) && !this.passwordHash) {
    return next(new Error('Cashier, manager, and owner must have a password'));
  }
  if (this.role === Role.Kitchen && !this.station) {
    return next(new Error('Station screen accounts must be assigned a station'));
  }
  if (this.role !== Role.Kitchen) {
    this.station = undefined;
  }
  next();
});

userSchema.methods.comparePin = async function (pin: string): Promise<boolean> {
  if (!this.pinHash) return false;
  return bcrypt.compare(pin, this.pinHash);
};

userSchema.methods.comparePassword = async function (password: string): Promise<boolean> {
  if (!this.passwordHash) return false;
  return bcrypt.compare(password, this.passwordHash);
};

userSchema.statics.hashPin = async function (pin: string): Promise<string> {
  return bcrypt.hash(pin, 10);
};

userSchema.statics.hashPassword = async function (password: string): Promise<string> {
  return bcrypt.hash(password, 12);
};

export const User = mongoose.model<IUser, IUserModel>('User', userSchema);
