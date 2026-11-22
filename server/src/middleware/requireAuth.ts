import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { User } from '../models/User';
import { Role, Station } from '../types';

export interface TokenPayload {
  userId: string;
  role: Role;
  station?: Station;
}

type AuthMode = 'staff' | 'kitchen' | 'delivery' | 'any';

/**
 * Verifies the bearer token and loads the user.
 *  - 'staff'    : waiter / cashier / manager / owner. Station screens and delivery staff are rejected.
 *  - 'kitchen'  : station screen (KDS) accounts only.
 *  - 'delivery' : delivery staff only.
 *  - 'any'      : any account (auth/me, logout, settings read).
 */
const authenticate = (mode: AuthMode) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication token required' });
      return;
    }

    const token = authHeader.split(' ')[1];

    let decoded: TokenPayload;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET) as TokenPayload;
    } catch {
      res.status(401).json({ code: 'INVALID_TOKEN', message: 'Token is invalid or expired' });
      return;
    }

    const user = await User.findById(decoded.userId);
    if (!user || !user.active) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'User is deactivated or not found' });
      return;
    }

    const isKitchen = user.role === Role.Kitchen;
    const isDelivery = user.role === Role.Delivery;
    if (mode === 'staff' && (isKitchen || isDelivery)) {
      res.status(403).json({
        code: 'FORBIDDEN',
        message: isKitchen ? 'Station screens cannot access this resource' : 'Delivery accounts can only use the delivery app',
      });
      return;
    }
    if (mode === 'delivery' && !isDelivery) {
      res.status(403).json({ code: 'FORBIDDEN', message: 'Only delivery staff accounts can access this resource' });
      return;
    }
    if (mode === 'kitchen' && !isKitchen) {
      res.status(403).json({ code: 'FORBIDDEN', message: 'Only station screen accounts can access this resource' });
      return;
    }

    req.user = {
      id: user._id.toString(),
      name: user.name,
      role: user.role,
      station: user.station,
    };

    next();
  };
};

/** Staff only (waiter and above). Station screens get 403. */
export const requireAuth = authenticate('staff');

/** Station screen (kitchen) accounts only. */
export const requireKitchen = authenticate('kitchen');

/** Delivery staff accounts only. */
export const requireDelivery = authenticate('delivery');

/** Any authenticated account, including station screens and delivery staff. */
export const requireAnyAuth = authenticate('any');

export const optionalAuth = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as TokenPayload;
    const user = await User.findById(decoded.userId);

    if (user && user.active) {
      req.user = {
        id: user._id.toString(),
        name: user.name,
        role: user.role,
        station: user.station,
      };
    }
  } catch {
    // Proceed as unauthenticated
  }

  next();
};
