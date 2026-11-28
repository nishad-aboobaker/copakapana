import mongoose from 'mongoose';
import { AuditLog } from '../models/AuditLog';
import { Counter } from '../models/Counter';
import { ITicket, ITicketContext, ITicketItem, Ticket } from '../models/Ticket';
import { IOrder, Order, OrderItemLike } from '../models/Order';
import { Table } from '../models/Table';
import { User } from '../models/User';
import { emitToRoom, emitToStaff, registerSocketHandlers, stationRoom } from '../socket';
import { TicketStatus, Role, Station } from '../types';

/** How long a station screen has to confirm a ticket before the cashier is alerted. */
export const TICKET_ACK_TIMEOUT_MS = 10_000;
/** How long a cleared (served) ticket can be recalled back onto the screen. */
export const TICKET_RECALL_WINDOW_MS = 5 * 60_000;

/** Allowed status moves from the station screen. */
const KDS_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  [TicketStatus.New]: [TicketStatus.Preparing, TicketStatus.Ready],
  [TicketStatus.Preparing]: [TicketStatus.Ready, TicketStatus.New],
  [TicketStatus.Ready]: [TicketStatus.Served, TicketStatus.Preparing],
  [TicketStatus.Served]: [],
};

export class TicketError extends Error {
  // `statusCode` + `code` are picked up by the global errorHandler
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const toTicketItem = (i: OrderItemLike): ITicketItem => {
  const id = (i as { _id?: unknown })._id;
  return { name: i.name, qty: i.qty, portion: i.portion, note: i.note, ...(id ? { orderItemId: String(id) } : {}) };
};

/** Finds the ticket line for an order line: by its id, or by name/portion/note on older tickets. */
const sameLine = (t: ITicketItem, i: ITicketItem): boolean =>
  t.change !== 'cancelled' &&
  (t.orderItemId && i.orderItemId
    ? t.orderItemId === i.orderItemId
    : t.name === i.name && (t.portion ?? '') === (i.portion ?? '') && (t.note ?? '') === (i.note ?? '') && t.qty === i.qty);

/** Every line on the ticket is cancelled — the kitchen just needs to remove the card. */
export const isFullyCancelled = (t: Pick<ITicket, 'items'>): boolean =>
  t.items.length > 0 && t.items.every((i) => i.change === 'cancelled');

/** Counter items (e.g. soft drinks) are billed but never shown on a kitchen screen. */
const forKitchen = <T extends OrderItemLike>(items: T[]): T[] => items.filter((i) => !i.skipKitchen);

const FLOOR_LABEL: Record<string, string> = { ground: 'Ground Floor', first: 'First Floor' };

export class TicketService {
  /** Groups items by kitchen station */
  public static splitByStation<T extends { station: Station }>(items: T[]): Map<Station, T[]> {
    const map = new Map<Station, T[]>();
    for (const item of items) {
      const list = map.get(item.station) || [];
      list.push(item);
      map.set(item.station, list);
    }
    return map;
  }

  /** Builds the order context snapshot shown on station screen cards. */
  public static async buildContext(order: IOrder): Promise<ITicketContext> {
    const ctx: ITicketContext = { orderNumber: order.number, orderType: order.type };

    if (order.tableId) {
      const tableId = (order.tableId as any)?._id ?? order.tableId;
      const table = await Table.findById(tableId).lean();
      if (table) {
        ctx.tableLabel = String((table as any).name ?? (table as any).number);
        ctx.floor = FLOOR_LABEL[(table as any).floor] ?? (table as any).floor;
      }
    }

    const waiterId = (order.waiterId as any)?._id ?? order.waiterId;
    if (waiterId) {
      ctx.waiterId = waiterId.toString();
      const waiter = await User.findById(waiterId).select('name').lean();
      if (waiter) ctx.waiterName = waiter.name;
    }

    if (order.customerSnapshot?.name) ctx.customerName = order.customerSnapshot.name;
    // Phone is shown on station screens only for delivery (privacy: PRD)
    if (order.type === 'delivery' && order.customerSnapshot?.phone) ctx.customerPhone = order.customerSnapshot.phone;

    return ctx;
  }

  /** Pushes a ticket to its station screen and tells staff panels about it. */
  public static dispatch(ticket: ITicket, opts: { resent?: boolean } = {}): void {
    const payload = { ...ticket.toObject(), resent: !!opts.resent };
    emitToRoom(stationRoom(ticket.station), 'ticket:new', payload);
    this.broadcastUpdate(ticket);
  }

  /** Status/visibility change → station screen, staff panels and the owning waiter. */
  public static broadcastUpdate(ticket: ITicket): void {
    const payload = ticket.toObject();
    emitToRoom(stationRoom(ticket.station), 'ticket:updated', payload);
    emitToStaff('ticket:updated', payload);
    if (ticket.context?.waiterId) emitToRoom(`user:${ticket.context.waiterId}`, 'ticket:updated', payload);
  }

  /** Initial tickets for a new order (1 ticket per station that has items). */
  public static async generateInitialTickets(
    order: IOrder,
    items: OrderItemLike[],
    userId?: mongoose.Types.ObjectId,
  ): Promise<ITicket[]> {
    const context = await this.buildContext(order);
    const created: ITicket[] = [];

    for (const [station, stationItems] of this.splitByStation(forKitchen(items)).entries()) {
      const ticket = await Ticket.create({
        number: await Counter.nextSeq(`ticket_${station}`),
        orderId: order._id,
        station,
        context,
        items: stationItems.map(toTicketItem),
        isEdited: false,
        addedItems: [],
        cancelledItems: [],
        status: TicketStatus.New,
        createdBy: userId,
      });
      created.push(ticket);
      this.dispatch(ticket);
    }

    return created;
  }

  /**
   * An open order was edited. The change goes onto the card already on the station screen:
   * cancelled lines are struck out, added lines are marked new (green). No new token —
   * except when the station's card is already Ready or cleared: then added items come as a
   * separate "extra" ticket, so the cook doesn't miss them on a finished card.
   */
  public static async generateEditedTickets(
    order: IOrder,
    addedItems: OrderItemLike[],
    cancelledItems: OrderItemLike[],
    userId?: mongoose.Types.ObjectId,
  ): Promise<ITicket[]> {
    addedItems = forKitchen(addedItems);
    cancelledItems = forKitchen(cancelledItems);
    const affected = new Set<Station>();
    addedItems.forEach((i) => affected.add(i.station));
    cancelledItems.forEach((i) => affected.add(i.station));
    if (affected.size === 0) return [];

    const context = await this.buildContext(order);
    const created: ITicket[] = [];

    const now = new Date();
    for (const station of affected) {
      const stationAdded = addedItems.filter((i) => i.station === station).map(toTicketItem);
      const stationCancelled = cancelledItems.filter((i) => i.station === station).map(toTicketItem);

      // Cards still on the screen for this order, newest first
      const live = await Ticket.find({ orderId: order._id, station, status: { $ne: TicketStatus.Served } }).sort({ createdAt: -1 });
      const touched = new Set<ITicket>();

      // Strike out cancelled lines wherever they are on screen (already-served food needs nothing)
      for (const c of stationCancelled) {
        for (const t of live) {
          const line = t.items.find((x) => sameLine(x, c));
          if (line) {
            line.change = 'cancelled';
            line.changedAt = now;
            touched.add(t);
            break;
          }
        }
      }

      // Add new lines to the card the kitchen hasn't finished yet
      if (stationAdded.length) {
        const target = live.find((t) => t.status === TicketStatus.New || t.status === TicketStatus.Preparing);
        if (target) {
          target.items.push(...stationAdded.map((i) => ({ ...i, change: 'added' as const, changedAt: now })));
          touched.add(target);
        } else {
          const original = await Ticket.findOne({ orderId: order._id, station, isEdited: false }).sort({ createdAt: 1 });
          const extra = await Ticket.create({
            number: await Counter.nextSeq(`ticket_${station}`),
            orderId: order._id,
            station,
            context,
            items: stationAdded.map((i) => ({ ...i, change: 'added' as const, changedAt: now })),
            isEdited: true,
            againstTicketNumber: original?.number,
            addedItems: stationAdded,
            cancelledItems: [],
            status: TicketStatus.New,
            createdBy: userId,
          });
          created.push(extra);
          this.dispatch(extra);
        }
      }

      for (const t of touched) {
        t.markModified('items');
        t.editedAt = now;
        t.deliveredAt = undefined; // the screen must confirm it saw the change
        await t.save();
        created.push(t);
        this.dispatch(t);
      }
    }

    return created;
  }

  /** Open (not served) tickets for a station screen, oldest first, plus recently served for recall. */
  public static async listForStation(station: Station): Promise<{ open: ITicket[]; recentlyServed: ITicket[] }> {
    const [open, recentlyServed] = await Promise.all([
      Ticket.find({ station, status: { $ne: TicketStatus.Served } }).sort({ createdAt: 1 }),
      Ticket.find({ station, status: TicketStatus.Served, servedAt: { $gte: new Date(Date.now() - TICKET_RECALL_WINDOW_MS) } })
        .sort({ servedAt: -1 })
        .limit(10),
    ]);
    return { open, recentlyServed };
  }

  /** Station screen or waiter moves a ticket through the kitchen workflow. */
  public static async changeStatus(
    ticketId: string,
    next: TicketStatus,
    actor: { id: string; role: Role; station?: Station },
  ): Promise<ITicket> {
    if (!mongoose.isValidObjectId(ticketId)) throw new TicketError(404, 'NOT_FOUND', 'Ticket not found');
    const ticket = await Ticket.findById(ticketId);
    if (!ticket) throw new TicketError(404, 'NOT_FOUND', 'Ticket not found');

    if (actor.role === Role.Kitchen) {
      if (ticket.station !== actor.station) throw new TicketError(403, 'FORBIDDEN', 'Ticket belongs to another station');
      const removingCancelled = next === TicketStatus.Served && isFullyCancelled(ticket);
      if (!removingCancelled && !KDS_TRANSITIONS[ticket.status].includes(next)) {
        throw new TicketError(409, 'INVALID_TRANSITION', `Cannot move ticket from ${ticket.status} to ${next}`);
      }
    } else if (next !== TicketStatus.Served) {
      // Staff (waiter/cashier) may only mark a ticket served
      throw new TicketError(403, 'FORBIDDEN', 'Only the station screen can change kitchen status');
    } else if (ticket.status === TicketStatus.Served) {
      return ticket;
    }

    const before = ticket.status;
    const now = new Date();
    ticket.status = next;
    ticket.lastStatusBy = new mongoose.Types.ObjectId(actor.id);
    if (!ticket.deliveredAt) ticket.deliveredAt = now; // a tap proves it was displayed
    if (next === TicketStatus.Preparing && !ticket.startedAt) ticket.startedAt = now;
    if (next === TicketStatus.Ready) ticket.readyAt = now;
    if (next === TicketStatus.Served) {
      ticket.servedAt = now;
      if (!ticket.readyAt) ticket.readyAt = now;
    }
    if (next === TicketStatus.New) ticket.startedAt = undefined;
    await ticket.save();

    await AuditLog.create({
      action: 'ticket_status_changed',
      userId: actor.id,
      entity: 'Ticket',
      entityId: ticket._id,
      before: { status: before },
      after: { status: next },
    });

    this.broadcastUpdate(ticket);
    return ticket;
  }

  /** Brings a recently served ticket back to Ready (mis-tap undo). */
  public static async recall(ticketId: string, actor: { id: string; station?: Station }): Promise<ITicket> {
    if (!mongoose.isValidObjectId(ticketId)) throw new TicketError(404, 'NOT_FOUND', 'Ticket not found');
    const ticket = await Ticket.findById(ticketId);
    if (!ticket) throw new TicketError(404, 'NOT_FOUND', 'Ticket not found');
    if (ticket.station !== actor.station) throw new TicketError(403, 'FORBIDDEN', 'Ticket belongs to another station');
    if (ticket.status !== TicketStatus.Served || !ticket.servedAt || Date.now() - ticket.servedAt.getTime() > TICKET_RECALL_WINDOW_MS) {
      throw new TicketError(409, 'RECALL_EXPIRED', 'Only tickets cleared in the last 5 minutes can be recalled');
    }

    ticket.status = TicketStatus.Ready;
    ticket.servedAt = undefined;
    ticket.lastStatusBy = new mongoose.Types.ObjectId(actor.id);
    await ticket.save();

    await AuditLog.create({
      action: 'ticket_recalled',
      userId: actor.id,
      entity: 'Ticket',
      entityId: ticket._id,
      before: { status: TicketStatus.Served },
      after: { status: TicketStatus.Ready },
    });

    this.broadcastUpdate(ticket);
    return ticket;
  }

  /** Cashier re-sends a ticket to its station screen (e.g. after an undelivered alert). */
  public static async resend(ticketId: string, userId: string): Promise<ITicket> {
    if (!mongoose.isValidObjectId(ticketId)) throw new TicketError(404, 'NOT_FOUND', 'Ticket not found');
    const ticket = await Ticket.findById(ticketId);
    if (!ticket) throw new TicketError(404, 'NOT_FOUND', 'Ticket not found');

    ticket.resendCount = (ticket.resendCount || 0) + 1;
    ticket.lastResentAt = new Date();
    ticket.deliveredAt = undefined; // require a fresh confirmation from the screen
    if (ticket.status === TicketStatus.Served) {
      ticket.status = TicketStatus.New;
      ticket.servedAt = undefined;
      ticket.readyAt = undefined;
      ticket.startedAt = undefined;
    }
    await ticket.save();

    await AuditLog.create({
      action: 'ticket_resent',
      userId,
      entity: 'Ticket',
      entityId: ticket._id,
      after: { resendCount: ticket.resendCount },
    });

    this.dispatch(ticket, { resent: true });
    return ticket;
  }

  /** A station screen confirmed it is displaying the ticket. */
  public static async markDelivered(ticketId: string, station?: Station): Promise<void> {
    if (!mongoose.isValidObjectId(ticketId)) return;
    await Ticket.updateOne(
      { _id: ticketId, station, deliveredAt: { $exists: false } },
      { $set: { deliveredAt: new Date() } },
    );
  }

  /** tickets a screen has not confirmed within the timeout — surfaced to the cashier. */
  public static async findUndelivered(): Promise<ITicket[]> {
    const candidates = await Ticket.find({
      status: { $ne: TicketStatus.Served },
      deliveredAt: { $exists: false },
      updatedAt: { $lte: new Date(Date.now() - TICKET_ACK_TIMEOUT_MS) },
      createdAt: { $gte: new Date(Date.now() - 12 * 60 * 60_000) },
    }).sort({ createdAt: 1 });
    if (!candidates.length) return candidates;
    // Only tickets for orders still in progress matter to the kitchen
    const live = await Order.find({
      _id: { $in: [...new Set(candidates.map((k) => String(k.orderId)))] },
      status: { $in: ['open', 'billed'] },
    }).distinct('_id');
    const liveIds = new Set(live.map(String));
    return candidates.filter((k) => liveIds.has(String(k.orderId)));
  }
}

/** Wire socket hooks and start the undelivered-ticket watchdog. Called once on startup. */
export const initTicketWatchers = (): NodeJS.Timeout => {
  registerSocketHandlers({
    ticketReceived: (ticketId, user) => TicketService.markDelivered(ticketId, user.station),
  });

  return setInterval(async () => {
    try {
      // Always emit (even empty) so panels can clear resolved alerts
      const pending = await TicketService.findUndelivered();
      {
        emitToStaff(
          'ticket:undelivered',
          pending.map((k) => ({
            _id: k._id,
            number: k.number,
            station: k.station,
            context: k.context,
            createdAt: k.createdAt,
          })),
        );
      }
    } catch (err) {
      console.error('Ticket watchdog failed', err);
    }
  }, 5_000);
};
