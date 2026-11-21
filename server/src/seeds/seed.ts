import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

// ─── Minimal User model for owner seeding ────────────────────────────────────
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    role: { type: String, enum: ['waiter', 'cashier', 'manager', 'owner', 'kitchen'], required: true },
    pinHash: String,
    passwordHash: String,
    active: { type: Boolean, default: true },
    failedLoginAttempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const User = mongoose.model('User', userSchema);

/**
 * Seed script — Only ensures the default owner account exists.
 * No demo waiters, cashiers, tables, menu items, or settings are seeded.
 */
const seed = async (): Promise<void> => {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('❌ MONGO_URI not set in .env');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('✅ Connected to MongoDB');

  const ownerName = process.env.SEED_OWNER_NAME || 'owner';
  const ownerPassword = process.env.SEED_OWNER_PASSWORD || 'changeme123';

  const existingOwner = await User.findOne({ role: 'owner' });
  if (existingOwner) {
    console.log(`ℹ️ Owner already exists: [username: "${existingOwner.name}"]. No seeding required.`);
  } else {
    const passwordHash = await bcrypt.hash(ownerPassword, 12);
    await User.create({
      name: ownerName,
      role: 'owner',
      passwordHash,
      active: true,
    });
    console.log(`👑 Default owner created: [username: "${ownerName}"]`);
  }

  console.log('\n✨ Done. Only default owner is configured. No demo seed data created.');
  await mongoose.disconnect();
  process.exit(0);
};

seed().catch((err) => {
  console.error('💥 Seed failed:', err);
  process.exit(1);
});
