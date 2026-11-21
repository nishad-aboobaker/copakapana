import { Request, Response } from 'express';
import { AuditLog } from '../models/AuditLog';
import { parseDateRange } from '../services/reports.service';

export const listAuditLogs = async (req: Request, res: Response): Promise<void> => {
  const { from, to, action, userId, entity, page = '1', limit = '50' } = req.query;

  const query: any = {};

  if (from || to) {
    const { startDate, endDate } = parseDateRange(from as string, to as string);
    query.createdAt = { $gte: startDate, $lte: endDate };
  }

  if (action) {
    query.action = action;
  }

  if (userId) {
    query.userId = userId;
  }

  if (entity) {
    query.entity = entity;
  }

  const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 50));
  const skip = (pageNum - 1) * limitNum;

  const [total, data] = await Promise.all([
    AuditLog.countDocuments(query),
    AuditLog.find(query)
      .populate('userId', 'name role')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum),
  ]);

  const pages = Math.ceil(total / limitNum) || 1;

  res.json({
    data,
    total,
    page: pageNum,
    pages,
  });
};
