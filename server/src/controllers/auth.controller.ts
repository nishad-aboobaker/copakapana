import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AuditLog } from '../models/AuditLog';
import { User, usesPin } from '../models/User';
import { Role } from '../types';

export const login = async (req: Request, res: Response): Promise<void> => {
  const { name, pin, password } = req.body;

  if (!name) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Name is required' });
    return;
  }

  const user = await User.findOne({ name }).select('+pinHash +passwordHash');
  if (!user) {
    res.status(401).json({ code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' });
    return;
  }

  if (!user.active) {
    res.status(403).json({ code: 'DEACTIVATED', message: 'Account is deactivated' });
    return;
  }

  // Check failed attempt lockout (5 attempts for 5 minutes)
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const remainingSeconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
    res.status(423).json({
      code: 'ACCOUNT_LOCKED',
      message: `Account is temporarily locked. Try again in ${remainingSeconds} seconds.`,
      retryAfter: remainingSeconds,
    });
    return;
  }

  // Password / PIN verification
  let isMatch = false;
  if (usesPin(user.role)) {
    if (!pin) {
      res.status(400).json({ code: 'VALIDATION_ERROR', message: 'PIN is required' });
      return;
    }
    isMatch = await user.comparePin(String(pin));
  } else {
    if (!password) {
      res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Password is required' });
      return;
    }
    isMatch = await user.comparePassword(password);
  }

  if (!isMatch) {
    user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
    if (user.failedLoginAttempts >= 5) {
      user.lockedUntil = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
    }
    await user.save();

    res.status(401).json({
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid credentials',
      attemptsLeft: Math.max(0, 5 - user.failedLoginAttempts),
    });
    return;
  }

  // Successful login — reset failure counters
  user.failedLoginAttempts = 0;
  user.lockedUntil = undefined;

  // Sign JWT Access & Refresh Tokens
  const tokenPayload = { userId: user._id.toString(), role: user.role, station: user.station };
  const accessToken = jwt.sign(tokenPayload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });

  const refreshToken = jwt.sign(tokenPayload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });

  user.refreshToken = refreshToken;
  await user.save();

  // Audit log
  await AuditLog.create({
    action: 'login',
    userId: user._id,
    entity: 'User',
    entityId: user._id,
  });

  res.json({
    accessToken,
    refreshToken,
    user: {
      id: user._id,
      name: user.name,
      role: user.role,
      station: user.station,
    },
  });
};

export const refreshToken = async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    res.status(400).json({ code: 'TOKEN_REQUIRED', message: 'Refresh token required' });
    return;
  }

  try {
    const decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as { userId: string; role: Role };
    const user = await User.findById(decoded.userId);

    if (!user || !user.active || user.refreshToken !== refreshToken) {
      res.status(401).json({ code: 'INVALID_REFRESH_TOKEN', message: 'Invalid refresh token' });
      return;
    }

    const tokenPayload = { userId: user._id.toString(), role: user.role, station: user.station };
    const newAccessToken = jwt.sign(tokenPayload, env.JWT_SECRET, {
      expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    });

    res.json({ accessToken: newAccessToken });
  } catch {
    res.status(401).json({ code: 'INVALID_REFRESH_TOKEN', message: 'Expired or invalid refresh token' });
  }
};

export const logout = async (req: Request, res: Response): Promise<void> => {
  if (req.user) {
    await User.findByIdAndUpdate(req.user.id, { $unset: { refreshToken: 1 } });
  }
  res.status(204).send();
};

export const getMe = async (req: Request, res: Response): Promise<void> => {
  const user = await User.findById(req.user?.id).select('-pinHash -passwordHash -refreshToken');
  if (!user) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'User not found' });
    return;
  }
  res.json({ user });
};
