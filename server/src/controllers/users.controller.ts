import { Request, Response } from 'express';
import { AuditLog } from '../models/AuditLog';
import { User, usesPin } from '../models/User';
import { Role, Station } from '../types';

export const listUsers = async (req: Request, res: Response): Promise<void> => {
  const { role } = req.query;
  const filter: Record<string, unknown> = {};
  if (role) filter.role = role;

  // Unauthenticated requests may only list active waiters, delivery staff or station screens (login pickers)
  if (!req.user || req.user.role === Role.Kitchen || req.user.role === Role.Delivery) {
    if (role === Role.Waiter || role === Role.Kitchen || role === Role.Delivery) {
      const accounts = await User.find({ role, active: true })
        .select('_id name station')
        .sort({ name: 1 });
      res.json({ users: accounts });
      return;
    }
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication required' });
    return;
  }

  const users = await User.find(filter)
    .select('-pinHash -passwordHash -refreshToken')
    .sort({ createdAt: -1 });

  res.json({ users });
};

export const listWaiters = async (_req: Request, res: Response): Promise<void> => {
  const waiters = await User.find({ role: Role.Waiter, active: true })
    .select('_id name')
    .sort({ name: 1 });
  res.json({ users: waiters });
};

export const createUser = async (req: Request, res: Response): Promise<void> => {
  const { name, role, pin, password, station } = req.body;

  if (!name || !role || !Object.values(Role).includes(role)) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Name and a valid role are required' });
    return;
  }

  if (role === Role.Kitchen && !Object.values(Station).includes(station)) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'A station is required for station screen accounts' });
    return;
  }

  const existing = await User.findOne({ name });
  if (existing) {
    res.status(409).json({ code: 'DUPLICATE_NAME', message: 'User name already exists' });
    return;
  }

  let pinHash: string | undefined;
  let passwordHash: string | undefined;

  if (usesPin(role)) {
    if (!pin) {
      res.status(400).json({ code: 'VALIDATION_ERROR', message: 'PIN is required for waiters and station screens' });
      return;
    }
    pinHash = await User.hashPin(String(pin));
  } else {
    if (!password) {
      res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Password is required' });
      return;
    }
    passwordHash = await User.hashPassword(password);
  }

  const user = await User.create({
    name,
    role,
    station: role === Role.Kitchen ? station : undefined,
    pinHash,
    passwordHash,
    active: true,
  });

  await AuditLog.create({
    action: 'user_created',
    userId: req.user?.id,
    entity: 'User',
    entityId: user._id,
    after: { name: user.name, role: user.role, station: user.station },
  });

  res.status(201).json({
    user: {
      id: user._id,
      name: user.name,
      role: user.role,
      station: user.station,
      active: user.active,
    },
  });
};

export const updateUser = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { name, role, active, pin, password, station } = req.body;

  const user = await User.findById(id).select('+pinHash +passwordHash');
  if (!user) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'User not found' });
    return;
  }

  const before = { name: user.name, role: user.role, active: user.active };

  if (name !== undefined) user.name = name;
  if (role !== undefined) user.role = role;
  if (active !== undefined) user.active = active;
  if (station !== undefined && user.role === Role.Kitchen) {
    if (!Object.values(Station).includes(station)) {
      res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid station' });
      return;
    }
    user.station = station;
  }
  if (pin && usesPin(user.role)) {
    user.pinHash = await User.hashPin(String(pin));
  }
  if (password && !usesPin(user.role)) {
    user.passwordHash = await User.hashPassword(password);
  }

  await user.save();

  await AuditLog.create({
    action: 'user_updated',
    userId: req.user?.id,
    entity: 'User',
    entityId: user._id,
    before,
    after: { name: user.name, role: user.role, active: user.active },
  });

  res.json({
    user: {
      id: user._id,
      name: user.name,
      role: user.role,
      station: user.station,
      active: user.active,
    },
  });
};

export const resetPin = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { pin } = req.body;

  if (!pin) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'New PIN is required' });
    return;
  }

  const user = await User.findById(id).select('+pinHash +passwordHash');
  if (!user) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'User not found' });
    return;
  }

  if (!usesPin(user.role)) {
    res.status(400).json({ code: 'INVALID_ROLE', message: 'Only waiters and station screens have a PIN' });
    return;
  }

  user.pinHash = await User.hashPin(String(pin));
  user.failedLoginAttempts = 0;
  user.lockedUntil = undefined;
  await user.save();

  await AuditLog.create({
    action: 'user_pin_reset',
    userId: req.user?.id,
    entity: 'User',
    entityId: user._id,
  });

  res.json({ message: `PIN reset successfully for ${user.name}` });
};
