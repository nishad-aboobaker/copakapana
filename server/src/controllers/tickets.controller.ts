import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Ticket } from '../models/Ticket';
import { Order } from '../models/Order';
import { Settings } from '../models/Settings';
import { TicketService } from '../services/ticket.service';
import { getStationStatus } from '../socket';
import { TicketStatus, Role, Station } from '../types';

// ─── Staff endpoints ─────────────────────────────────────────────────────────

/** GET /orders/:id/tickets */
export const listOrderTickets = async (req: Request, res: Response): Promise<void> => {
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
  const tickets = await Ticket.find({ orderId: id }).sort({ createdAt: 1 });
  res.json({ tickets });
};

/** GET /tickets?status=&station= — open tickets across stations (waiters: own orders only). */
export const listTickets = async (req: Request, res: Response): Promise<void> => {
  const { status, station } = req.query;
  const filter: Record<string, unknown> = {};

  if (status === 'open' || !status) filter.status = { $ne: TicketStatus.Served };
  else if (Object.values(TicketStatus).includes(status as TicketStatus)) filter.status = status;

  if (station && Object.values(Station).includes(station as Station)) filter.station = station;
  if (req.user?.role === Role.Waiter) filter['context.waiterId'] = req.user.id;

  const tickets = await Ticket.find(filter).sort({ createdAt: 1 }).limit(200);
  res.json({ tickets });
};

/** POST /tickets/:id/served — waiter picked up the food. */
export const markTicketServed = async (req: Request, res: Response): Promise<void> => {
  const ticket = await Ticket.findById(req.params.id).catch(() => null);
  if (!ticket) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Ticket not found' });
    return;
  }
  if (req.user?.role === Role.Waiter && ticket.context?.waiterId !== req.user.id) {
    res.status(403).json({ code: 'FORBIDDEN', message: 'You can only update your own orders' });
    return;
  }
  const updated = await TicketService.changeStatus(req.params.id, TicketStatus.Served, req.user!);
  res.json({ ticket: updated });
};

/** POST /tickets/:id/resend — cashier pushes a ticket to its station screen again. */
export const resendTicket = async (req: Request, res: Response): Promise<void> => {
  const ticket = await TicketService.resend(req.params.id, req.user!.id);
  res.json({ ticket, message: `Ticket #${ticket.number} resent to ${ticket.station} screen` });
};

/** GET /kds/status — which station screens are connected. */
export const getKdsStatus = async (_req: Request, res: Response): Promise<void> => {
  res.json({ stations: getStationStatus(), undelivered: await TicketService.findUndelivered() });
};

// ─── Station screen (kitchen account) endpoints ──────────────────────────────

/** GET /kds/tickets — open tickets for this screen's station + KDS settings. */
export const listStationTickets = async (req: Request, res: Response): Promise<void> => {
  const station = req.user!.station!;
  const [{ open, recentlyServed }, settings] = await Promise.all([
    TicketService.listForStation(station),
    Settings.findOne().select('restaurantName kdsWarnMinutes kdsLateMinutes kdsSoundEnabled').lean(),
  ]);

  // Loading the list proves these tickets are on screen
  await Promise.all(open.filter((k) => !k.deliveredAt).map((k) => TicketService.markDelivered(k._id.toString(), station)));

  res.json({
    station,
    tickets: open,
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

/** POST /kds/tickets/:id/status { status } */
export const updateStationTicketStatus = async (req: Request, res: Response): Promise<void> => {
  const { status } = req.body;
  if (!Object.values(TicketStatus).includes(status)) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid status' });
    return;
  }
  const ticket = await TicketService.changeStatus(req.params.id, status, req.user!);
  res.json({ ticket });
};

/** POST /kds/tickets/:id/recall */
export const recallStationTicket = async (req: Request, res: Response): Promise<void> => {
  const ticket = await TicketService.recall(req.params.id, req.user!);
  res.json({ ticket });
};
