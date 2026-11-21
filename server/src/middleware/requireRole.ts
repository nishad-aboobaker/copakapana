import { NextFunction, Request, Response } from 'express';
import { Role, RoleLevel } from '../types';

export const requireRole = (minRole: Role) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication required' });
      return;
    }

    const userLevel = RoleLevel[req.user.role];
    const requiredLevel = RoleLevel[minRole];

    if (userLevel === undefined || userLevel < requiredLevel) {
      res.status(403).json({
        code: 'FORBIDDEN',
        message: `Requires ${minRole} role or higher`,
      });
      return;
    }

    next();
  };
};
