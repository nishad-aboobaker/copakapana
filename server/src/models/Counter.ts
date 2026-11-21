import mongoose, { Document, Model, Schema } from 'mongoose';

export interface ICounter extends Document {
  key: string;
  seq: number;
}

export interface ICounterModel extends Model<ICounter> {
  nextSeq(type: string, dateStr?: string): Promise<number>;
}

const counterSchema = new Schema<ICounter>({
  key: {
    type: String,
    required: true,
    unique: true,
  },
  seq: {
    type: Number,
    default: 0,
  },
});

counterSchema.statics.nextSeq = async function (type: string, dateStr?: string): Promise<number> {
  // If dateStr is not provided, use current date in Asia/Kolkata
  const date =
    dateStr ||
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

  const key = `${type}_${date}`;

  const counter = await this.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return counter.seq;
};

export const Counter = mongoose.model<ICounter, ICounterModel>('Counter', counterSchema);
