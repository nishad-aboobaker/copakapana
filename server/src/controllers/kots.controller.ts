import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { KOT } from '../models/KOT';
import { Order } from '../models/Order';
import { Settings } from '../models/Settings';
import { KotService } from '../services/kot.service';
import { getStationStatus } from '../socket';
import { KotStatus, Role, Station } from '../types';

// ─── Staff endpoints ─────────────────────────────────────────────────────────

/** GET /orders/:id/kots */
export const listOrderKots = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
    return;
  }
  const order = await Order.findById(id).select('waiterId');
  if (!order) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
    return;
  }
  if (req.user?.role === Role.Waiter && order.waiterId.toString() !== req.user.id) {
    res.status(403).json({ code: 'FORBIDDEN', message: 'You can only view your own orders' });
    return;
  }
  const kots = await KOT.find({ orderId: id }).sort({ createdAt: 1 });
  res.json({ kots });
};

/** GET /kots?status=&station= — open KOTs across stations (waiters: own orders only). */
export const listKots = async (req: Request, res: Response): Promise<void> => {
  const { status, station } = req.query;
  const filter: Record<string, unknown> = {};

  if (status === 'open' || !status) filter.status = { $ne: KotStatus.Served };
  else if (Object.values(KotStatus).includes(status as KotStatus)) filter.status = status;

  if (station && Object.values(Station).includes(station as Station)) filter.station = station;
  if (req.user?.role === Role.Waiter) filter['context.waiterId'] = req.user.id;

  const kots = await KOT.find(filter).sort({ createdAt: 1 }).limit(200);
  res.json({ kots });
};

/** POST /kots/:id/served — waiter picked up the food. */
export const markKotServed = async (req: Request, res: Response): Promise<void> => {
  const kot = await KOT.findById(req.params.id).catch(() => null);
  if (!kot) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'KOT not found' });
    return;
  }
  if (req.user?.role === Role.Waiter && kot.context?.waiterId !== req.user.id) {
    res.status(403).json({ code: 'FORBIDDEN', message: 'You can only update your own orders' });
    return;
  }
  const updated = await KotService.changeStatus(req.params.id, KotStatus.Served, req.user!);
  res.json({ kot: updated });
};

/** POST /kots/:id/resend — cashier pushes a KOT to its station screen again. */
export const resendKot = async (req: Request, res: Response): Promise<void> => {
  const kot = await KotService.resend(req.params.id, req.user!.id);
  res.json({ kot, message: `KOT #${kot.number} resent to ${kot.station} screen` });
};

/** GET /kds/status — which station screens are connected. */
export const getKdsStatus = async (_req: Request, res: Response): Promise<void> => {
  res.json({ stations: getStationStatus(), undelivered: await KotService.findUndelivered() });
};

// ─── Station screen (kitchen account) endpoints ──────────────────────────────

/** GET /kds/kots — open KOTs for this screen's station + KDS settings. */
export const listStationKots = async (req: Request, res: Response): Promise<void> => {
  const station = req.user!.station!;
  const [{ open, recentlyServed }, settings] = await Promise.all([
    KotService.listForStation(station),
    Settings.findOne().select('restaurantName kdsWarnMinutes kdsLateMinutes kdsSoundEnabled').lean(),
  ]);

  // Loading the list proves these KOTs are on screen
  await Promise.all(open.filter((k) => !k.deliveredAt).map((k) => KotService.markDelivered(k._id.toString(), station)));

  res.json({
    station,
    kots: open,
    recentlyServed,
    settings: {
      restaurantName: settings?.restaurantName,
      kdsWarnMinutes: settings?.kdsWarnMinutes ?? 10,
      kdsLateMinutes: settings?.kdsLateMinutes ?? 15,
      kdsSoundEnabled: settings?.kdsSoundEnabled ?? true,
    },
    serverTime: new Date().toISOString(),
  });
};

/** POST /kds/kots/:id/status { status } */
export const updateStationKotStatus = async (req: Request, res: Response): Promise<void> => {
  const { status } = req.body;
  if (!Object.values(KotStatus).includes(status)) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid status' });
    return;
  }
  const kot = await KotService.changeStatus(req.params.id, status, req.user!);
  res.json({ kot });
};

/** POST /kds/kots/:id/recall */
export const recallStationKot = async (req: Request, res: Response): Promise<void> => {
  const kot = await KotService.recall(req.params.id, req.user!);
  res.json({ kot });
};
