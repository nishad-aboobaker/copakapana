import mongoose from 'mongoose';
import { AuditLog } from '../models/AuditLog';
import { Counter } from '../models/Counter';
import { IKOT, IKOTContext, IKOTItem, KOT } from '../models/KOT';
import { IOrder, Order, OrderItemLike } from '../models/Order';
import { Table } from '../models/Table';
import { User } from '../models/User';
import { emitToRoom, emitToStaff, registerSocketHandlers, stationRoom } from '../socket';
import { KotStatus, Role, Station } from '../types';

/** How long a station screen has to confirm a KOT before the cashier is alerted. */
export const KOT_ACK_TIMEOUT_MS = 10_000;
/** How long a cleared (served) KOT can be recalled back onto the screen. */
export const KOT_RECALL_WINDOW_MS = 5 * 60_000;

/** Allowed status moves from the station screen. */
const KDS_TRANSITIONS: Record<KotStatus, KotStatus[]> = {
  [KotStatus.New]: [KotStatus.Preparing, KotStatus.Ready],
  [KotStatus.Preparing]: [KotStatus.Ready, KotStatus.New],
  [KotStatus.Ready]: [KotStatus.Served, KotStatus.Preparing],
  [KotStatus.Served]: [],
};

export class KotError extends Error {
  // `statusCode` + `code` are picked up by the global errorHandler
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const toKotItem = (i: OrderItemLike): IKOTItem => ({ name: i.name, qty: i.qty, portion: i.portion, note: i.note });

const FLOOR_LABEL: Record<string, string> = { ground: 'Ground Floor', first: 'First Floor' };

export class KotService {
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
  public static async buildContext(order: IOrder): Promise<IKOTContext> {
    const ctx: IKOTContext = { orderNumber: order.number, orderType: order.type };

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

  /** Pushes a KOT to its station screen and tells staff panels about it. */
  public static dispatch(kot: IKOT, opts: { resent?: boolean } = {}): void {
    const payload = { ...kot.toObject(), resent: !!opts.resent };
    emitToRoom(stationRoom(kot.station), 'kot:new', payload);
    this.broadcastUpdate(kot);
  }

  /** Status/visibility change → station screen, staff panels and the owning waiter. */
  public static broadcastUpdate(kot: IKOT): void {
    const payload = kot.toObject();
    emitToRoom(stationRoom(kot.station), 'kot:updated', payload);
    emitToStaff('kot:updated', payload);
    if (kot.context?.waiterId) emitToRoom(`user:${kot.context.waiterId}`, 'kot:updated', payload);
  }

  /** Initial KOTs for a new order (1 KOT per station that has items). */
  public static async generateInitialKOTs(
    order: IOrder,
    items: OrderItemLike[],
    userId?: mongoose.Types.ObjectId,
  ): Promise<IKOT[]> {
    const context = await this.buildContext(order);
    const created: IKOT[] = [];

    for (const [station, stationItems] of this.splitByStation(items).entries()) {
      const kot = await KOT.create({
        number: await Counter.nextSeq(`kot_${station}`),
        orderId: order._id,
        station,
        context,
        items: stationItems.map(toKotItem),
        isEdited: false,
        addedItems: [],
        cancelledItems: [],
        status: KotStatus.New,
        createdBy: userId,
      });
      created.push(kot);
      this.dispatch(kot);
    }

    return created;
  }

  /** EDITED KOTs when items are added or cancelled on an open order — one per affected station. */
  public static async generateEditedKOTs(
    order: IOrder,
    addedItems: OrderItemLike[],
    cancelledItems: OrderItemLike[],
    userId?: mongoose.Types.ObjectId,
  ): Promise<IKOT[]> {
    const affected = new Set<Station>();
    addedItems.forEach((i) => affected.add(i.station));
    cancelledItems.forEach((i) => affected.add(i.station));
    if (affected.size === 0) return [];

    const context = await this.buildContext(order);
    const created: IKOT[] = [];

    for (const station of affected) {
      const stationAdded = addedItems.filter((i) => i.station === station).map(toKotItem);
      const stationCancelled = cancelledItems.filter((i) => i.station === station).map(toKotItem);

      // Reference the station's first KOT for this order ("vs #014")
      const original = await KOT.findOne({ orderId: order._id, station, isEdited: false }).sort({ createdAt: 1 });

      const kot = await KOT.create({
        number: await Counter.nextSeq(`kot_${station}`),
        orderId: order._id,
        station,
        context,
        items: stationAdded,
        isEdited: true,
        againstKotNumber: original?.number,
        addedItems: stationAdded,
        cancelledItems: stationCancelled,
        status: KotStatus.New,
        createdBy: userId,
      });
      created.push(kot);
      this.dispatch(kot);
    }

    return created;
  }

  /** Open (not served) KOTs for a station screen, oldest first, plus recently served for recall. */
  public static async listForStation(station: Station): Promise<{ open: IKOT[]; recentlyServed: IKOT[] }> {
    const [open, recentlyServed] = await Promise.all([
      KOT.find({ station, status: { $ne: KotStatus.Served } }).sort({ createdAt: 1 }),
      KOT.find({ station, status: KotStatus.Served, servedAt: { $gte: new Date(Date.now() - KOT_RECALL_WINDOW_MS) } })
        .sort({ servedAt: -1 })
        .limit(10),
    ]);
    return { open, recentlyServed };
  }

  /** Station screen or waiter moves a KOT through the kitchen workflow. */
  public static async changeStatus(
    kotId: string,
    next: KotStatus,
    actor: { id: string; role: Role; station?: Station },
  ): Promise<IKOT> {
    if (!mongoose.isValidObjectId(kotId)) throw new KotError(404, 'NOT_FOUND', 'KOT not found');
    const kot = await KOT.findById(kotId);
    if (!kot) throw new KotError(404, 'NOT_FOUND', 'KOT not found');

    if (actor.role === Role.Kitchen) {
      if (kot.station !== actor.station) throw new KotError(403, 'FORBIDDEN', 'KOT belongs to another station');
      if (!KDS_TRANSITIONS[kot.status].includes(next)) {
        throw new KotError(409, 'INVALID_TRANSITION', `Cannot move KOT from ${kot.status} to ${next}`);
      }
    } else if (next !== KotStatus.Served) {
      // Staff (waiter/cashier) may only mark a KOT served
      throw new KotError(403, 'FORBIDDEN', 'Only the station screen can change kitchen status');
    } else if (kot.status === KotStatus.Served) {
      return kot;
    }

    const before = kot.status;
    const now = new Date();
    kot.status = next;
    kot.lastStatusBy = new mongoose.Types.ObjectId(actor.id);
    if (!kot.deliveredAt) kot.deliveredAt = now; // a tap proves it was displayed
    if (next === KotStatus.Preparing && !kot.startedAt) kot.startedAt = now;
    if (next === KotStatus.Ready) kot.readyAt = now;
    if (next === KotStatus.Served) {
      kot.servedAt = now;
      if (!kot.readyAt) kot.readyAt = now;
    }
    if (next === KotStatus.New) kot.startedAt = undefined;
    await kot.save();

    await AuditLog.create({
      action: 'kot_status_changed',
      userId: actor.id,
      entity: 'KOT',
      entityId: kot._id,
      before: { status: before },
      after: { status: next },
    });

    this.broadcastUpdate(kot);
    return kot;
  }

  /** Brings a recently served KOT back to Ready (mis-tap undo). */
  public static async recall(kotId: string, actor: { id: string; station?: Station }): Promise<IKOT> {
    if (!mongoose.isValidObjectId(kotId)) throw new KotError(404, 'NOT_FOUND', 'KOT not found');
    const kot = await KOT.findById(kotId);
    if (!kot) throw new KotError(404, 'NOT_FOUND', 'KOT not found');
    if (kot.station !== actor.station) throw new KotError(403, 'FORBIDDEN', 'KOT belongs to another station');
    if (kot.status !== KotStatus.Served || !kot.servedAt || Date.now() - kot.servedAt.getTime() > KOT_RECALL_WINDOW_MS) {
      throw new KotError(409, 'RECALL_EXPIRED', 'Only KOTs cleared in the last 5 minutes can be recalled');
    }

    kot.status = KotStatus.Ready;
    kot.servedAt = undefined;
    kot.lastStatusBy = new mongoose.Types.ObjectId(actor.id);
    await kot.save();

    await AuditLog.create({
      action: 'kot_recalled',
      userId: actor.id,
      entity: 'KOT',
      entityId: kot._id,
      before: { status: KotStatus.Served },
      after: { status: KotStatus.Ready },
    });

    this.broadcastUpdate(kot);
    return kot;
  }

  /** Cashier re-sends a KOT to its station screen (e.g. after an undelivered alert). */
  public static async resend(kotId: string, userId: string): Promise<IKOT> {
    if (!mongoose.isValidObjectId(kotId)) throw new KotError(404, 'NOT_FOUND', 'KOT not found');
    const kot = await KOT.findById(kotId);
    if (!kot) throw new KotError(404, 'NOT_FOUND', 'KOT not found');

    kot.resendCount = (kot.resendCount || 0) + 1;
    kot.lastResentAt = new Date();
    kot.deliveredAt = undefined; // require a fresh confirmation from the screen
    if (kot.status === KotStatus.Served) {
      kot.status = KotStatus.New;
      kot.servedAt = undefined;
      kot.readyAt = undefined;
      kot.startedAt = undefined;
    }
    await kot.save();

    await AuditLog.create({
      action: 'kot_resent',
      userId,
      entity: 'KOT',
      entityId: kot._id,
      after: { resendCount: kot.resendCount },
    });

    this.dispatch(kot, { resent: true });
    return kot;
  }

  /** A station screen confirmed it is displaying the KOT. */
  public static async markDelivered(kotId: string, station?: Station): Promise<void> {
    if (!mongoose.isValidObjectId(kotId)) return;
    await KOT.updateOne(
      { _id: kotId, station, deliveredAt: { $exists: false } },
      { $set: { deliveredAt: new Date() } },
    );
  }

  /** KOTs a screen has not confirmed within the timeout — surfaced to the cashier. */
  public static async findUndelivered(): Promise<IKOT[]> {
    const candidates = await KOT.find({
      status: { $ne: KotStatus.Served },
      deliveredAt: { $exists: false },
      updatedAt: { $lte: new Date(Date.now() - KOT_ACK_TIMEOUT_MS) },
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

/** Wire socket hooks and start the undelivered-KOT watchdog. Called once on startup. */
export const initKotWatchers = (): NodeJS.Timeout => {
  registerSocketHandlers({
    kotReceived: (kotId, user) => KotService.markDelivered(kotId, user.station),
  });

  return setInterval(async () => {
    try {
      // Always emit (even empty) so panels can clear resolved alerts
      const pending = await KotService.findUndelivered();
      {
        emitToStaff(
          'kot:undelivered',
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
      console.error('KOT watchdog failed', err);
    }
  }, 5_000);
};
