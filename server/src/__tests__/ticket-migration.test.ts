import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { migrateLegacyTickets } from '../services/bootstrap.service';
import { Ticket } from '../models/Ticket';
import { Counter } from '../models/Counter';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('Legacy "kot" data migration', () => {
  test('moves old tickets, counters and audit names to the ticket names, and is safe to re-run', async () => {
    const db = mongoose.connection.db!;
    const orderId = new mongoose.Types.ObjectId();
    await db.collection('kots').insertMany([
      { number: 1, orderId, station: 'main', status: 'new', context: { orderNumber: 7, orderType: 'dine_in' }, items: [], resendCount: 0 },
      { number: 2, orderId, station: 'main', status: 'ready', isEdited: true, againstKotNumber: 1, context: { orderNumber: 7, orderType: 'dine_in' }, items: [], resendCount: 0 },
    ]);
    await db.collection('counters').insertOne({ key: 'kot_main_2026-11-22', seq: 2 });
    await db.collection('auditlogs').insertOne({ action: 'kot_resent', entity: 'kot' });

    await migrateLegacyTickets();
    await migrateLegacyTickets(); // second run must change nothing

    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    expect(names).not.toContain('kots');
    expect(await Ticket.countDocuments()).toBe(2);
    const edited = await Ticket.findOne({ number: 2 }).lean();
    expect(edited?.againstTicketNumber).toBe(1);
    expect((edited as any).againstKotNumber).toBeUndefined();

    // Numbering continues where it left off
    expect(await Counter.nextSeq('ticket_main', '2026-11-22')).toBe(3);
    expect(await db.collection('counters').countDocuments({ key: /^kot_/ })).toBe(0);

    expect(await db.collection('auditlogs').countDocuments({ action: 'ticket_resent' })).toBe(1);
  });
});
