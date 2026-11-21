import mongoose, { Document, Schema } from 'mongoose';

export interface IMenuCategory extends Document {
  name: string;
  order: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const menuCategorySchema = new Schema<IMenuCategory>(
  {
    name: {
      type: String,
      required: [true, 'Category name is required'],
      trim: true,
    },
    order: {
      type: Number,
      required: [true, 'Display order is required'],
      default: 0,
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

menuCategorySchema.index({ order: 1 });

export const MenuCategory = mongoose.model<IMenuCategory>('MenuCategory', menuCategorySchema);
