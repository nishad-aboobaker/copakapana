import { User, IUser } from '../models/User';
import { Role } from '../types';
import { env } from '../config/env';
import { Order } from '../models/Order';
import { KOT } from '../models/KOT';

/**
 * One-off migrations for the switch from KOT printers to station screens:
 *  - legacy non-unique `clientRequestId_1` index → replaced by a unique partial index
 *  - legacy `printStatus` KOTs → treated as served so they don't flood station screens
 */
export const migrateForStationScreens = async (): Promise<void> => {
  try {
    const indexes = await Order.collection.indexes();
    const legacy = indexes.find((i) => i.name === 'clientRequestId_1' && !i.unique);
    if (legacy) {
      await Order.collection.dropIndex('clientRequestId_1');
      console.log('🔧 [Bootstrap] Dropped legacy clientRequestId index');
    }
    await Order.syncIndexes();
  } catch (error) {
    console.error('⚠️ [Bootstrap] Order index migration skipped:', (error as Error).message);
  }

  try {
    const res = await KOT.updateMany(
      { status: { $exists: false } },
      { $set: { status: 'served', servedAt: new Date() }, $unset: { printStatus: 1, reprintCount: 1 } },
    );
    if (res.modifiedCount) console.log(`🔧 [Bootstrap] Archived ${res.modifiedCount} legacy printed KOTs`);
  } catch (error) {
    console.error('⚠️ [Bootstrap] KOT migration skipped:', (error as Error).message);
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

/**
 * Master bootstrap runner called during server startup.
 * Only ensures the default owner account if no owner exists in the database.
 */
export const bootstrapDefaultData = async (): Promise<void> => {
  await ensureDefaultOwner();
  await migrateForStationScreens();
};
