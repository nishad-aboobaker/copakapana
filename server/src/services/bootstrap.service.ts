import mongoose from 'mongoose';
import { User, IUser } from '../models/User';
import { Role } from '../types';
import { env } from '../config/env';
import { Order } from '../models/Order';
import { Ticket } from '../models/Ticket';

/**
 * Moves data saved under the old "kot" names to the kitchen-ticket names, keeping
 * existing tickets, today's ticket numbering and audit history. Does nothing once done,
 * so it is safe to run on every start.
 */
export const migrateLegacyTickets = async (): Promise<void> => {
  const db = mongoose.connection.db;
  if (!db) return;
  try {
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    if (names.includes('kots')) {
      const ticketsInUse = names.includes('tickets') && (await db.collection('tickets').estimatedDocumentCount()) > 0;
      if (!ticketsInUse) {
        // dropTarget: the model may already have created an empty `tickets` collection for its indexes
        await db.collection('kots').rename('tickets', { dropTarget: true });
        console.log('🔧 [Bootstrap] Moved kitchen tickets to the tickets collection');
      }
    }

    await db
      .collection('tickets')
      .updateMany({ againstKotNumber: { $exists: true } }, { $rename: { againstKotNumber: 'againstTicketNumber' } });

    const counters = await db.collection('counters').find({ key: /^kot_/ }).toArray();
    for (const c of counters) {
      const key = String(c.key).replace(/^kot_/, 'ticket_');
      await db.collection('counters').updateOne({ key }, { $max: { seq: c.seq } }, { upsert: true });
      await db.collection('counters').deleteOne({ _id: c._id });
    }

    const renamedActions: Array<[string, string]> = [
      ['kot_status_changed', 'ticket_status_changed'],
      ['kot_recalled', 'ticket_recalled'],
      ['kot_resent', 'ticket_resent'],
    ];
    for (const [from, to] of renamedActions) {
      await db.collection('auditlogs').updateMany({ action: from }, { $set: { action: to } });
    }

    await Promise.all([Ticket.syncIndexes(), Order.syncIndexes()]);
  } catch (error) {
    console.error('⚠️ [Bootstrap] Ticket migration skipped:', (error as Error).message);
  }
};

/**
 * Ensures at least one Owner account exists in the database.
 * No other accounts, tables, menus, or seed data are created.
 */
export const ensureDefaultOwner = async (): Promise<IUser | null> => {
  try {
    const existingOwner = await User.findOne({ role: Role.Owner });
    if (existingOwner) {
      return null;
    }

    const ownerName = env.SEED_OWNER_NAME || 'owner';
    const ownerPassword = env.SEED_OWNER_PASSWORD || 'changeme123';
    const passwordHash = await User.hashPassword(ownerPassword);

    const newOwner = await User.create({
      name: ownerName,
      role: Role.Owner,
      passwordHash,
      active: true,
    });

    console.log(`👑 [Bootstrap] Seeded default owner: [username: "${ownerName}"]`);
    return newOwner;
  } catch (error) {
    console.error('❌ [Bootstrap] Failed to verify/seed default owner:', error);
    return null;
  }
};

/** Startup tasks: make sure an owner exists, then bring old data up to date. */
export const bootstrapDefaultData = async (): Promise<void> => {
  await ensureDefaultOwner();
  await migrateLegacyTickets();
};
