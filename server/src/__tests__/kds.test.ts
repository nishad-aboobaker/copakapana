import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { KOT } from '../models/KOT';
import { Order } from '../models/Order';
import { Table } from '../models/Table';
import { User } from '../models/User';
import { KotError, KotService } from '../services/kot.service';
import { cancelOrder } from '../controllers/orders.controller';
import { getMenu, setStationItemAvailability } from '../controllers/menu.controller';
import { MenuItem } from '../models/MenuItem';
import { MenuCategory } from '../models/MenuCategory';
import { AuditLog } from '../models/AuditLog';
import { ItemStatus, KotStatus, OrderStatus, OrderType, Role, Station, TableFloor } from '../types';

// Socket emits are fire-and-forget; record them instead of needing a server
const emitted: { room: string; event: string; data: any }[] = [];
jest.mock('../socket', () => ({
  emitToRoom: (room: string, event: string, data: unknown) => emitted.push({ room, event, data }),
  emitToStaff: (event: string, data: unknown) => emitted.push({ room: 'staff', event, data }),
  emitTableUpdated: (data: unknown) => emitted.push({ room: 'all', event: 'table:updated', data }),
  emitMenuUpdated: (data: unknown) => emitted.push({ room: 'all', event: 'menu:updated', data }),
  emitOrderUpdated: (_w: string, data: unknown) => emitted.push({ room: 'staff', event: 'order:updated', data }),
  registerSocketHandlers: () => undefined,
  stationRoom: (s: string) => `station:${s}`,
}));

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Order.syncIndexes();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  emitted.length = 0;
  await Promise.all([KOT.deleteMany({}), Order.deleteMany({}), Table.deleteMany({}), User.deleteMany({})]);
});

const item = (name: string, station: Station, qty = 1) => ({
  menuItemId: new mongoose.Types.ObjectId().toString(),
  name,
  price: 100,
  qty,
  station,
  status: ItemStatus.Active,
});

const makeOrder = async (items = [item('Fried Chicken', Station.FriedChicken), item('Lime Juice', Station.Juice)]) => {
  const waiter = await User.create({ name: 'anu', role: Role.Waiter, pinHash: 'x' });
  const table = await Table.create({ name: '7', number: '7', floor: TableFloor.First, capacity: 4 });
  const order = await Order.create({
    number: 231,
    type: OrderType.DineIn,
    tableId: table._id,
    waiterId: waiter._id,
    status: OrderStatus.Open,
    items,
  });
  return { order, waiter };
};

const kitchen = (station: Station) => ({ id: new mongoose.Types.ObjectId().toString(), role: Role.Kitchen, station });

describe('KOT generation for station screens', () => {
  test('one KOT per station, with context snapshot, pushed to that station room only', async () => {
    const { order, waiter } = await makeOrder();
    const kots = await KotService.generateInitialKOTs(order, order.items, waiter._id as any);

    expect(kots.map((k) => k.station).sort()).toEqual([Station.FriedChicken, Station.Juice]);
    const fc = kots.find((k) => k.station === Station.FriedChicken)!;
    expect(fc.status).toBe(KotStatus.New);
    expect(fc.context).toMatchObject({ orderNumber: 231, tableLabel: '7', floor: 'First Floor', waiterName: 'anu' });

    const pushes = emitted.filter((e) => e.event === 'kot:new');
    expect(pushes.map((p) => p.room).sort()).toEqual(['station:fried_chicken', 'station:juice']);
    // owning waiter is told too (for the ready signal)
    expect(emitted.some((e) => e.room === `user:${waiter._id}` && e.event === 'kot:updated')).toBe(true);
  });

  test('edit creates EDITED KOT only on affected stations, referencing the original', async () => {
    const { order, waiter } = await makeOrder();
    const [first] = (await KotService.generateInitialKOTs(order, order.items, waiter._id as any)).filter(
      (k) => k.station === Station.FriedChicken,
    );

    const edited = await KotService.generateEditedKOTs(
      order,
      [item('Chicken Wings', Station.FriedChicken)],
      [order.items[0]],
      waiter._id as any,
    );

    expect(edited).toHaveLength(1);
    expect(edited[0]).toMatchObject({ station: Station.FriedChicken, isEdited: true, againstKotNumber: first.number });
    expect(edited[0].addedItems.map((i) => i.name)).toEqual(['Chicken Wings']);
    expect(edited[0].cancelledItems.map((i) => i.name)).toEqual(['Fried Chicken']);
  });
});

describe('Station screen workflow', () => {
  test('new → preparing → ready → served records timestamps', async () => {
    const { order } = await makeOrder([item('Fried Chicken', Station.FriedChicken)]);
    const [kot] = await KotService.generateInitialKOTs(order, order.items);
    const screen = kitchen(Station.FriedChicken);

    const prep = await KotService.changeStatus(kot.id, KotStatus.Preparing, screen);
    expect(prep.startedAt).toBeDefined();
    expect(prep.deliveredAt).toBeDefined();
    const ready = await KotService.changeStatus(kot.id, KotStatus.Ready, screen);
    expect(ready.readyAt).toBeDefined();
    const served = await KotService.changeStatus(kot.id, KotStatus.Served, screen);
    expect(served.servedAt).toBeDefined();
  });

  test('a screen cannot touch another station’s KOT', async () => {
    const { order } = await makeOrder([item('Fried Chicken', Station.FriedChicken)]);
    const [kot] = await KotService.generateInitialKOTs(order, order.items);
    await expect(KotService.changeStatus(kot.id, KotStatus.Preparing, kitchen(Station.Juice))).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  test('invalid jumps are rejected; staff may only mark served', async () => {
    const { order, waiter } = await makeOrder([item('Fried Chicken', Station.FriedChicken)]);
    const [kot] = await KotService.generateInitialKOTs(order, order.items);

    await expect(
      KotService.changeStatus(kot.id, KotStatus.Served, kitchen(Station.FriedChicken)),
    ).rejects.toBeInstanceOf(KotError);
    await expect(
      KotService.changeStatus(kot.id, KotStatus.Preparing, { id: waiter.id, role: Role.Waiter }),
    ).rejects.toMatchObject({ statusCode: 403 });

    const served = await KotService.changeStatus(kot.id, KotStatus.Served, { id: waiter.id, role: Role.Waiter });
    expect(served.status).toBe(KotStatus.Served);
  });

  test('recall brings a cleared KOT back to ready within the window', async () => {
    const { order } = await makeOrder([item('Fried Chicken', Station.FriedChicken)]);
    const [kot] = await KotService.generateInitialKOTs(order, order.items);
    const screen = kitchen(Station.FriedChicken);
    await KotService.changeStatus(kot.id, KotStatus.Ready, screen);
    await KotService.changeStatus(kot.id, KotStatus.Served, screen);

    const recalled = await KotService.recall(kot.id, screen);
    expect(recalled.status).toBe(KotStatus.Ready);
    expect(recalled.servedAt).toBeUndefined();
  });

  test('undelivered KOTs are reported until a screen confirms them; resend re-pushes', async () => {
    const { order } = await makeOrder([item('Fried Chicken', Station.FriedChicken)]);
    const [kot] = await KotService.generateInitialKOTs(order, order.items);
    // age the KOT past the ack timeout
    await KOT.collection.updateOne({ _id: kot._id }, { $set: { updatedAt: new Date(Date.now() - 60_000) } });

    expect((await KotService.findUndelivered()).map((k) => k.id)).toEqual([kot.id]);

    emitted.length = 0;
    await KotService.resend(kot.id, new mongoose.Types.ObjectId().toString());
    expect(emitted.find((e) => e.event === 'kot:new')?.data.resent).toBe(true);

    await KotService.markDelivered(kot.id, Station.FriedChicken);
    await KOT.collection.updateOne({ _id: kot._id }, { $set: { updatedAt: new Date(Date.now() - 60_000) } });
    expect(await KotService.findUndelivered()).toHaveLength(0);
  });
});

describe('Order idempotency', () => {
  test('the same clientRequestId cannot create two orders', async () => {
    const { waiter } = await makeOrder();
    const base = { number: 1, type: OrderType.Takeaway, waiterId: waiter._id, items: [item('Lime Juice', Station.Juice)] };
    await Order.create({ ...base, clientRequestId: 'req_1' });
    await expect(Order.create({ ...base, number: 2, clientRequestId: 'req_1' })).rejects.toMatchObject({ code: 11000 });
    // orders without a clientRequestId are unaffected
    await Order.create({ ...base, number: 3 });
    await Order.create({ ...base, number: 4 });
  });
});

describe('Credential privacy', () => {
  test('populating a waiter on an order never returns PIN or password hashes', async () => {
    const { order } = await makeOrder();
    const listed = await Order.findById(order._id).populate('waiterId', 'name role').lean();
    const waiter = listed!.waiterId as any;
    expect(waiter.name).toBe('anu');
    expect(waiter.pinHash).toBeUndefined();
    expect(waiter.passwordHash).toBeUndefined();
    // …but sign-in can still opt in
    const withHash = await User.findById(waiter._id).select('+pinHash');
    expect(withHash!.pinHash).toBe('x');
  });
});

describe('Cancelling an order', () => {
  const call = async (orderId: string, user: { id: string; role: Role; name?: string }, body: any = {}) => {
    let status = 200;
    let json: any;
    const res: any = { status: (c: number) => ((status = c), res), json: (j: any) => ((json = j), res) };
    await cancelOrder({ params: { id: orderId }, body, user: { name: 'x', ...user } } as any, res);
    return { status, json };
  };

  test('waiter closes their own order once every item is cancelled — table becomes free', async () => {
    const { order, waiter } = await makeOrder([item('Chikku Juice', Station.Juice)]);
    await Table.updateOne({ _id: order.tableId }, { status: 'occupied' });
    order.items[0].status = ItemStatus.Cancelled;
    await order.save();

    const r = await call(order.id, { id: waiter.id, role: Role.Waiter });
    expect(r.status).toBe(200);
    expect((await Order.findById(order.id))!.status).toBe(OrderStatus.Cancelled);
    expect((await Table.findById(order.tableId))!.status).toBe('free');
  });

  test('waiter cannot cancel an order that still has items', async () => {
    const { order, waiter } = await makeOrder([item('Chikku Juice', Station.Juice)]);
    const r = await call(order.id, { id: waiter.id, role: Role.Waiter });
    expect(r.status).toBe(403);
    expect((await Order.findById(order.id))!.status).toBe(OrderStatus.Open);
  });

  test('cashier needs a reason; with one, remaining items are cancelled and the kitchen is told', async () => {
    const { order } = await makeOrder([item('Chikku Juice', Station.Juice), item('Wings', Station.FriedChicken)]);
    const cashier = { id: new mongoose.Types.ObjectId().toString(), role: Role.Cashier };

    expect((await call(order.id, cashier)).status).toBe(400);

    const r = await call(order.id, cashier, { reason: 'Customer left' });
    expect(r.status).toBe(200);
    const saved = (await Order.findById(order.id))!;
    expect(saved.status).toBe(OrderStatus.Cancelled);
    expect(saved.items.every((i) => i.status === ItemStatus.Cancelled)).toBe(true);
    const edits = await KOT.find({ orderId: order._id, isEdited: true });
    expect(edits.map((k) => k.station).sort()).toEqual([Station.FriedChicken, Station.Juice]);
  });

  test('a billed order cannot be cancelled here', async () => {
    const { order } = await makeOrder([item('Chikku Juice', Station.Juice)]);
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.Billed });
    const r = await call(order.id, { id: new mongoose.Types.ObjectId().toString(), role: Role.Owner }, { reason: 'x' });
    expect(r.status).toBe(409);
  });
});

describe('Station screens manage stock', () => {
  const run = async (handler: any, req: any) => {
    let status = 200;
    let json: any;
    const res: any = { status: (c: number) => ((status = c), res), json: (j: any) => ((json = j), res), setHeader: () => res };
    await handler(req, res);
    return { status, json };
  };

  const setup = async () => {
    await Promise.all([MenuItem.deleteMany({}), MenuCategory.deleteMany({})]);
    const cat = await MenuCategory.create({ name: 'Juices', order: 1 });
    const chikku = await MenuItem.create({ name: 'Chikku Juice', categoryId: cat._id, price: 90, station: Station.Juice, isVeg: true });
    const wings = await MenuItem.create({ name: 'Wings', categoryId: cat._id, price: 220, station: Station.FriedChicken, isVeg: false });
    return { chikku, wings };
  };

  test('juice screen marks its own dish out of stock; waiters still see it, flagged', async () => {
    const { chikku } = await setup();
    const screen = { id: new mongoose.Types.ObjectId().toString(), role: Role.Kitchen, station: Station.Juice, name: 'juice-screen' };

    const r = await run(setStationItemAvailability, { params: { id: chikku.id }, body: { available: false }, user: screen });
    expect(r.status).toBe(200);
    expect((await MenuItem.findById(chikku.id))!.available).toBe(false);
    expect(emitted.some((e) => e.event === 'menu:updated')).toBe(true);
    expect(await AuditLog.countDocuments({ action: 'item_availability_toggled', entityId: chikku._id })).toBe(1);

    const menu = await run(getMenu, {});
    const listed = menu.json.menu.flatMap((m: any) => m.items).find((i: any) => i.name === 'Chikku Juice');
    expect(listed).toBeDefined();
    expect(listed.available).toBe(false);
  });

  test("a screen cannot change another station's dish", async () => {
    const { wings } = await setup();
    const screen = { id: new mongoose.Types.ObjectId().toString(), role: Role.Kitchen, station: Station.Juice };
    const r = await run(setStationItemAvailability, { params: { id: wings.id }, body: { available: false }, user: screen });
    expect(r.status).toBe(403);
    expect((await MenuItem.findById(wings.id))!.available).toBe(true);
  });
});
