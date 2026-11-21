import mongoose from 'mongoose';
import { env } from './env';

let retries = 0;
const MAX_RETRIES = 5;

export const connectDB = async (): Promise<void> => {
  try {
    const conn = await mongoose.connect(env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log(`✅ MongoDB connected: ${conn.connection.host}`);
    retries = 0;
  } catch (err) {
    retries++;
    console.error(`❌ MongoDB connection failed (attempt ${retries}/${MAX_RETRIES}):`, err);
    if (retries < MAX_RETRIES) {
      console.log(`⏳ Retrying in 5 seconds...`);
      await new Promise((res) => setTimeout(res, 5000));
      return connectDB();
    }
    console.error('💥 Max retries reached. Exiting.');
    process.exit(1);
  }
};
