import { Request, Response } from 'express';
import { AuditLog } from '../models/AuditLog';
import { MenuCategory } from '../models/MenuCategory';
import { MenuItem } from '../models/MenuItem';
import { emitMenuUpdated } from '../socket';

// ─── Public Menu Retrieval ───────────────────────────────────────────────────
export const getMenu = async (_req: Request, res: Response): Promise<void> => {
  const categories = await MenuCategory.find({ active: true }).sort({ order: 1 });
  // Out-of-stock dishes are included (flagged available: false) so waiters see them greyed out
  const items = await MenuItem.find({ active: true }).sort({ name: 1 });

  const menu = categories.map((cat) => ({
    category: cat,
    items: items.filter((item) => item.categoryId.toString() === cat._id.toString()),
  }));

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json({ menu });
};

// ─── Category Endpoints (Owner only) ──────────────────────────────────────────
export const listCategories = async (_req: Request, res: Response): Promise<void> => {
  const categories = await MenuCategory.find().sort({ order: 1 });
  res.json({ categories });
};

export const createCategory = async (req: Request, res: Response): Promise<void> => {
  const { name, order } = req.body;

  if (!name) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Category name is required' });
    return;
  }

  const count = await MenuCategory.countDocuments();
  const category = await MenuCategory.create({
    name,
    order: order !== undefined ? Number(order) : count + 1,
  });

  await AuditLog.create({
    action: 'category_created',
    userId: req.user?.id,
    entity: 'MenuCategory',
    entityId: category._id,
    after: { name: category.name, order: category.order },
  });

  res.status(201).json({ category });
};

export const updateCategory = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { name, order, active } = req.body;

  const category = await MenuCategory.findById(id);
  if (!category) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Category not found' });
    return;
  }

  if (name !== undefined) category.name = name;
  if (order !== undefined) category.order = Number(order);
  if (active !== undefined) category.active = Boolean(active);

  await category.save();

  await AuditLog.create({
    action: 'category_updated',
    userId: req.user?.id,
    entity: 'MenuCategory',
    entityId: category._id,
    after: { name: category.name, order: category.order, active: category.active },
  });

  res.json({ category });
};

export const deleteCategory = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const activeItemsCount = await MenuItem.countDocuments({ categoryId: id, active: true });
  if (activeItemsCount > 0) {
    res.status(400).json({
      code: 'CATEGORY_IN_USE',
      message: `Cannot delete category with ${activeItemsCount} active items. Reassign or delete items first.`,
    });
    return;
  }

  await MenuCategory.findByIdAndUpdate(id, { active: false });

  await AuditLog.create({
    action: 'category_deleted',
    userId: req.user?.id,
    entity: 'MenuCategory',
    entityId: id,
  });

  res.json({ message: 'Category deactivated successfully' });
};

// ─── Item Endpoints (Owner only) ──────────────────────────────────────────────
export const listAllItems = async (req: Request, res: Response): Promise<void> => {
  const { categoryId, station } = req.query;
  const filter: Record<string, unknown> = { active: true };
  if (categoryId) filter.categoryId = categoryId;
  if (station) filter.station = station;

  const rawItems = await MenuItem.find(filter).populate('categoryId', 'name').sort({ name: 1 });
  const items = rawItems.map((item) => {
    const obj = item.toObject();
    const cat = obj.categoryId as any;
    return {
      ...obj,
      category: cat && typeof cat === 'object' ? cat : undefined,
      categoryId: cat && typeof cat === 'object' && cat._id ? cat._id.toString() : obj.categoryId?.toString(),
    };
  });
  res.json({ items });
};

export const createItem = async (req: Request, res: Response): Promise<void> => {
  const { name, printName, categoryId, price, station, isVeg, description, portions, skipKitchen } = req.body;

  if (!name || !categoryId || price === undefined || !station) {
    res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Name, categoryId, price, and station are required',
    });
    return;
  }

  const category = await MenuCategory.findById(categoryId);
  if (!category || !category.active) {
    res.status(400).json({ code: 'INVALID_CATEGORY', message: 'Category not found or inactive' });
    return;
  }

  const item = await MenuItem.create({
    name,
    printName,
    categoryId,
    price: Number(price),
    station,
    skipKitchen: Boolean(skipKitchen),
    isVeg: Boolean(isVeg),
    description,
    portions: portions || [],
    available: true,
    active: true,
  });

  await AuditLog.create({
    action: 'item_created',
    userId: req.user?.id,
    entity: 'MenuItem',
    entityId: item._id,
    after: { name: item.name, price: item.price, station: item.station },
  });

  emitMenuUpdated(item);

  res.status(201).json({ item });
};

export const updateItem = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { name, printName, categoryId, price, station, isVeg, description, portions, available, active, skipKitchen } = req.body;

  const item = await MenuItem.findById(id);
  if (!item) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Item not found' });
    return;
  }

  const before = { name: item.name, price: item.price, station: item.station, available: item.available };

  if (name !== undefined) item.name = name;
  if (printName !== undefined) item.printName = printName;
  if (categoryId !== undefined) item.categoryId = categoryId;
  if (price !== undefined) item.price = Number(price);
  if (station !== undefined) item.station = station;
  if (isVeg !== undefined) item.isVeg = Boolean(isVeg);
  if (skipKitchen !== undefined) item.skipKitchen = Boolean(skipKitchen);
  if (description !== undefined) item.description = description;
  if (portions !== undefined) item.portions = portions;
  if (available !== undefined) item.available = Boolean(available);
  if (active !== undefined) item.active = Boolean(active);

  await item.save();

  await AuditLog.create({
    action: 'item_updated',
    userId: req.user?.id,
    entity: 'MenuItem',
    entityId: item._id,
    before,
    after: { name: item.name, price: item.price, station: item.station, available: item.available },
  });

  emitMenuUpdated(item);

  res.json({ item });
};

export const deleteItem = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const item = await MenuItem.findByIdAndUpdate(id, { active: false }, { new: true });
  if (!item) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Item not found' });
    return;
  }

  await AuditLog.create({
    action: 'item_deleted',
    userId: req.user?.id,
    entity: 'MenuItem',
    entityId: item._id,
  });

  emitMenuUpdated(item);

  res.json({ message: 'Item deactivated successfully' });
};

// ─── Instant Availability Toggle (Manager or higher) ─────────────────────────
/** Shared by the manager toggle and the station screens. */
const setAvailability = async (item: InstanceType<typeof MenuItem>, available: boolean, req: Request): Promise<void> => {
  const before = item.available;
  item.available = available;
  await item.save();
  if (before !== available) {
    await AuditLog.create({
      action: 'item_availability_toggled',
      userId: req.user?.id,
      entity: 'MenuItem',
      entityId: item._id,
      before: { available: before },
      after: { name: item.name, available, by: req.user?.role === 'kitchen' ? `station screen (${req.user?.station})` : req.user?.role },
    });
  }
  emitMenuUpdated(item);
};

export const toggleAvailability = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { available } = req.body;

  const item = await MenuItem.findById(id).catch(() => null);
  if (!item) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Item not found' });
    return;
  }

  await setAvailability(item, available !== undefined ? Boolean(available) : !item.available, req);
  res.json({ item });
};

// ─── Station screens (kitchen accounts) ──────────────────────────────────────

/** GET /kds/menu — dishes made at this screen's station, for the stock panel. */
export const listStationMenu = async (req: Request, res: Response): Promise<void> => {
  const items = await MenuItem.find({ active: true, station: req.user!.station })
    .select('name available categoryId isVeg portions')
    .populate('categoryId', 'name order')
    .sort({ name: 1 })
    .lean();
  res.json({ station: req.user!.station, items });
};

/** PATCH /kds/items/:id/availability { available } — only for this station's dishes. */
export const setStationItemAvailability = async (req: Request, res: Response): Promise<void> => {
  const item = await MenuItem.findById(req.params.id).catch(() => null);
  if (!item || !item.active) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Dish not found' });
    return;
  }
  if (item.station !== req.user!.station) {
    res.status(403).json({ code: 'FORBIDDEN', message: 'This dish is made at another station' });
    return;
  }
  if (typeof req.body?.available !== 'boolean') {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'available must be true or false' });
    return;
  }
  await setAvailability(item, req.body.available, req);
  res.json({ item });
};

