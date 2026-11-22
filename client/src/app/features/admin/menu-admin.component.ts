import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/auth/auth.service';
import { SocketService } from '../../core/socket/socket.service';
import { IconComponent } from '../../shared/icon.component';
import { UiService } from '../../shared/ui.service';

interface Category {
  _id: string;
  name: string;
  order: number;
  active: boolean;
}

interface Portion {
  label: string;
  price: number;
}

type Station = 'fried_chicken' | 'juice' | 'main';

interface MenuItemData {
  _id: string;
  name: string;
  printName?: string;
  categoryId: string | { _id: string; name?: string };
  price: number;
  station: Station;
  skipKitchen?: boolean;
  isVeg: boolean;
  description?: string;
  portions: Portion[];
  available: boolean;
  active: boolean;
}

const STATIONS: { key: Station; label: string }[] = [
  { key: 'fried_chicken', label: 'Fried Chicken' },
  { key: 'juice', label: 'Juice' },
  { key: 'main', label: 'Main Kitchen' },
];

/**
 * Menu: categories on the left, dishes on the right.
 * Owners edit everything; managers can only switch dishes in/out of stock.
 */
@Component({
  selector: 'app-menu-admin',
  // Angular 22 defaults to OnPush; this page keeps plain-field state updated by HTTP/socket callbacks
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: true,
  imports: [FormsModule, IconComponent],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1 class="page-title">Menu</h1>
          <p class="page-subtitle">
            {{ items().length }} dishes in {{ categories().length }} categories
            @if (outOfStock()) { · <span class="text-danger">{{ outOfStock() }} out of stock</span> }
          </p>
        </div>
        @if (isOwner) {
          <div class="page-actions">
            <button class="btn" (click)="openCategory()"><app-icon name="plus" /> Category</button>
            <button class="btn btn-primary" [disabled]="!categories().length" (click)="openAddItem()"><app-icon name="plus" /> Add dish</button>
          </div>
        }
      </header>

      @if (!isOwner) {
        <div class="alert alert-info mb">
          <app-icon name="info" />
          <div class="alert-body">You can mark dishes in or out of stock. Only the owner can change dishes, prices and categories.</div>
        </div>
      }

      <div class="layout">
        <!-- Categories -->
        <aside class="card cats">
          <div class="cats-head section-title">Categories</div>
          <button class="cat" [class.sel]="selectedId() === 'all'" (click)="selectedId.set('all')">
            <span class="cat-name">All dishes</span>
            <span class="cat-count">{{ items().length }}</span>
          </button>
          @for (c of categories(); track c._id; let i = $index; let last = $last) {
            <div class="cat" [class.sel]="selectedId() === c._id" (click)="selectedId.set(c._id)" role="button" tabindex="0" (keydown.enter)="selectedId.set(c._id)">
              <span class="cat-name truncate">{{ c.name }}</span>
              <span class="cat-count">{{ countIn(c._id) }}</span>
              @if (isOwner) {
                <span class="cat-actions" (click)="$event.stopPropagation()">
                  <button class="btn btn-ghost btn-icon btn-sm" [disabled]="i === 0" (click)="moveCategory(c, -1)" aria-label="Move up"><app-icon name="chevron-down" [size]="14" class="flip" /></button>
                  <button class="btn btn-ghost btn-icon btn-sm" [disabled]="last" (click)="moveCategory(c, 1)" aria-label="Move down"><app-icon name="chevron-down" [size]="14" /></button>
                  <button class="btn btn-ghost btn-icon btn-sm" (click)="openCategory(c)" aria-label="Rename"><app-icon name="pencil" [size]="14" /></button>
                </span>
              }
            </div>
          } @empty {
            <div class="empty-state small">
              <p>No categories yet.</p>
              @if (isOwner) { <button class="btn btn-sm btn-primary" (click)="openCategory()"><app-icon name="plus" /> Add category</button> }
            </div>
          }
        </aside>

        <!-- Dishes -->
        <section class="dishes">
          <div class="toolbar">
            <div class="input-group search">
              <app-icon name="search" />
              <input class="input" type="search" placeholder="Search dishes" [value]="query()" (input)="query.set($any($event.target).value)" />
            </div>
            <div class="chips">
              <button class="chip" [class.active]="stationFilter() === 'all'" (click)="stationFilter.set('all')">All stations</button>
              @for (s of stations; track s.key) {
                <button class="chip" [class.active]="stationFilter() === s.key" (click)="stationFilter.set(s.key)">{{ s.label }}</button>
              }
              <button class="chip" [class.active]="onlyOut()" (click)="onlyOut.set(!onlyOut())"><app-icon name="ban" [size]="14" /> Out of stock</button>
            </div>
          </div>

          @if (loading()) {
            <div class="skeleton" style="height: 260px; border-radius: 12px"></div>
          } @else if (filtered().length === 0) {
            <div class="card">
              <div class="empty-state">
                <div class="empty-icon"><app-icon name="utensils" /></div>
                <h3>{{ query() || onlyOut() || stationFilter() !== 'all' ? 'No dishes match' : 'No dishes here yet' }}</h3>
                @if (isOwner && categories().length && !query()) {
                  <button class="btn btn-primary" (click)="openAddItem()"><app-icon name="plus" /> Add dish</button>
                }
              </div>
            </div>
          } @else {
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>Dish</th>
                    <th>Station</th>
                    <th class="text-right">Price</th>
                    <th>In stock</th>
                    @if (isOwner) { <th class="text-right">Actions</th> }
                  </tr>
                </thead>
                <tbody>
                  @for (item of filtered(); track item._id) {
                    <tr [class.out]="!item.available">
                      <td>
                        <div class="dish">
                          <span class="diet" [class.veg]="item.isVeg" [attr.title]="item.isVeg ? 'Veg' : 'Non-veg'"><i></i></span>
                          <div class="dish-text">
                            <span class="text-strong">{{ item.name }}</span>
                            @if (item.description || item.portions?.length) {
                              <small>
                                {{ item.portions?.length ? item.portions.map(p => p.label).join(' / ') : '' }}{{ item.portions?.length && item.description ? ' · ' : '' }}{{ item.description }}
                              </small>
                            }
                          </div>
                        </div>
                      </td>
                      <td>
                        @if (item.skipKitchen) {
                          <span class="badge badge-info" title="Billed without a kitchen ticket">Counter</span>
                        } @else {
                          <span class="badge">{{ stationLabel(item.station) }}</span>
                        }
                      </td>
                      <td class="text-right num text-strong">
                        @if (item.portions?.length) { ₹{{ minPrice(item) }}–{{ maxPrice(item) }} } @else { ₹{{ item.price }} }
                      </td>
                      <td>
                        <label class="switch">
                          <input type="checkbox" [checked]="item.available" (change)="toggleItemAvailability(item)" [attr.aria-label]="(item.available ? 'Mark out of stock: ' : 'Mark in stock: ') + item.name" />
                          <span class="track"></span>
                          <span class="text-sm" [class.text-danger]="!item.available">{{ item.available ? 'Available' : 'Out' }}</span>
                        </label>
                      </td>
                      @if (isOwner) {
                        <td class="text-right">
                          <div class="actions">
                            <button class="btn btn-ghost btn-icon btn-sm" (click)="openEditItem(item)" aria-label="Edit"><app-icon name="pencil" [size]="16" /></button>
                            <button class="btn btn-ghost btn-icon btn-sm danger" (click)="deleteItem(item)" aria-label="Delete"><app-icon name="trash" [size]="16" /></button>
                          </div>
                        </td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      </div>

      <!-- ─── Category dialog ─── -->
      @if (showCategory()) {
        <div class="modal-backdrop" (click)="showCategory.set(false)">
          <form class="modal" role="dialog" aria-modal="true" (click)="$event.stopPropagation()" (ngSubmit)="saveCategory()">
            <div class="modal-header">
              <h3>{{ editingCategory() ? 'Rename category' : 'Add category' }}</h3>
              <button type="button" class="btn btn-ghost btn-icon modal-close" (click)="showCategory.set(false)" aria-label="Close"><app-icon name="x" /></button>
            </div>
            <div class="modal-body">
              <div class="field">
                <label for="cat-name">Name</label>
                <input id="cat-name" name="cname" class="input" [(ngModel)]="categoryName" placeholder="e.g. Starters" autofocus />
              </div>
            </div>
            <div class="modal-footer">
              @if (editingCategory()) {
                <button type="button" class="btn btn-danger-soft" (click)="deleteCategory(editingCategory()!)"><app-icon name="trash" /> Delete</button>
                <span class="spacer"></span>
              }
              <button type="button" class="btn" (click)="showCategory.set(false)">Cancel</button>
              <button type="submit" class="btn btn-primary" [disabled]="!categoryName.trim()">Save</button>
            </div>
          </form>
        </div>
      }

      <!-- ─── Dish dialog ─── -->
      @if (showItem()) {
        <div class="modal-backdrop" (click)="showItem.set(false)">
          <form class="modal modal-lg" role="dialog" aria-modal="true" (click)="$event.stopPropagation()" (ngSubmit)="saveItem()">
            <div class="modal-header">
              <div>
                <h3>{{ editingItem() ? 'Edit dish' : 'Add dish' }}</h3>
                <p>Price changes never affect orders already taken.</p>
              </div>
              <button type="button" class="btn btn-ghost btn-icon modal-close" (click)="showItem.set(false)" aria-label="Close"><app-icon name="x" /></button>
            </div>
            <div class="modal-body">
              <div class="grid-2">
                <div class="field">
                  <label for="d-name">Name</label>
                  <input id="d-name" name="dname" class="input" [(ngModel)]="f.name" placeholder="e.g. Chicken Wings" autofocus />
                </div>
                <div class="field">
                  <label for="d-cat">Category</label>
                  <select id="d-cat" name="dcat" class="select" [(ngModel)]="f.categoryId">
                    @for (c of categories(); track c._id) { <option [value]="c._id">{{ c.name }}</option> }
                  </select>
                </div>
              </div>

              <div class="grid-2">
                <div class="field">
                  <span class="label">Kitchen station</span>
                  <div class="segmented full">
                    @for (s of stations; track s.key) {
                      <button type="button" [class.active]="f.station === s.key" (click)="f.station = s.key">{{ s.label }}</button>
                    }
                  </div>
                  <span class="hint">{{ f.skipKitchen ? 'Used for reports only — this dish is not sent to a kitchen screen.' : "Tickets for this dish go to that station's screen." }}</span>
                </div>
                <div class="field">
                  <span class="label">Type</span>
                  <div class="segmented full">
                    <button type="button" [class.active]="f.isVeg" (click)="f.isVeg = true"><span class="diet veg"><i></i></span> Veg</button>
                    <button type="button" [class.active]="!f.isVeg" (click)="f.isVeg = false"><span class="diet"><i></i></span> Non-veg</button>
                  </div>
                </div>
              </div>

              <label class="switch switch-block">
                <input type="checkbox" [checked]="f.skipKitchen" (change)="f.skipKitchen = $any($event.target).checked" />
                <span class="track"></span>
                <span><strong>Served from the counter</strong><small>Waiters add it to the bill without sending a ticket to the kitchen — e.g. soft drinks, water bottles, ice cream cups.</small></span>
              </label>

              <div class="field">
                <span class="label">Price</span>
                <div class="segmented">
                  <button type="button" [class.active]="!usePortions" (click)="usePortions = false">Single price</button>
                  <button type="button" [class.active]="usePortions" (click)="enablePortions()">Sizes (e.g. Half / Full)</button>
                </div>
                @if (!usePortions) {
                  <div class="input-group price">
                    <span class="input-prefix-text">₹</span>
                    <input name="dprice" class="input num" type="number" min="0" [(ngModel)]="f.price" />
                  </div>
                } @else {
                  <div class="portions">
                    @for (p of f.portions; track $index; let i = $index) {
                      <div class="portion-row">
                        <input class="input" [name]="'pl' + i" [(ngModel)]="p.label" placeholder="Size, e.g. Half" />
                        <div class="input-group">
                          <span class="input-prefix-text">₹</span>
                          <input class="input num" [name]="'pp' + i" type="number" min="0" [(ngModel)]="p.price" />
                        </div>
                        <button type="button" class="btn btn-ghost btn-icon" (click)="f.portions.splice(i, 1)" aria-label="Remove size"><app-icon name="x" /></button>
                      </div>
                    }
                    <button type="button" class="btn btn-sm btn-ghost add-size" (click)="f.portions.push({ label: '', price: 0 })"><app-icon name="plus" /> Add size</button>
                  </div>
                }
              </div>

              <div class="grid-2">
                <div class="field">
                  <label for="d-desc">Description <span class="text-muted">(optional)</span></label>
                  <input id="d-desc" name="ddesc" class="input" [(ngModel)]="f.description" placeholder="Shown to waiters" />
                </div>
                <div class="field">
                  <label for="d-print">Kitchen name <span class="text-muted">(optional)</span></label>
                  <input id="d-print" name="dprint" class="input" [(ngModel)]="f.printName" placeholder="Short or local-language name" />
                </div>
              </div>

              @if (formError()) {
                <div class="alert alert-danger"><app-icon name="alert-circle" /><div class="alert-body">{{ formError() }}</div></div>
              }
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" (click)="showItem.set(false)">Cancel</button>
              <button type="submit" class="btn btn-primary" [disabled]="saving()">{{ editingItem() ? 'Save changes' : 'Add dish' }}</button>
            </div>
          </form>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .mb { margin-bottom: 1rem; }
      .layout { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 1rem; align-items: start; }
      .cats { padding: 0.5rem; position: sticky; top: 1rem; }
      .cats-head { padding: 0.5rem 0.6rem 0.25rem; margin: 0; }
      .cat { display: flex; align-items: center; gap: 0.5rem; width: 100%; min-height: 40px; padding: 0 0.6rem; border-radius: 8px; border: 0; background: none; text-align: left; cursor: pointer; font-size: var(--fs-sm); color: var(--text); }
      .cat:hover { background: var(--gray-50); }
      .cat.sel { background: var(--primary-soft); color: var(--primary-active); font-weight: 600; }
      .cat-name { flex: 1; min-width: 0; }
      .cat-count { font-size: var(--fs-xs); color: var(--text-subtle); font-weight: 600; }
      .cat-actions { display: none; gap: 0; }
      .cat:hover .cat-actions, .cat.sel .cat-actions { display: inline-flex; }
      .cat:hover .cat-count, .cat.sel .cat-count { display: none; }
      .flip { transform: rotate(180deg); }
      .empty-state.small { padding: 1rem; }
      .toolbar { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center; margin-bottom: 0.75rem; }
      .search { width: 260px; max-width: 100%; }
      .dish { display: flex; align-items: center; gap: 0.65rem; }
      .dish-text { display: flex; flex-direction: column; min-width: 0; }
      .dish-text small { color: var(--text-muted); font-size: var(--fs-xs); max-width: 42ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      tr.out td { background: #fffafa; }
      tr.out .text-strong { color: var(--text-muted); }
      .diet { width: 15px; height: 15px; border: 1.5px solid #b3261e; border-radius: 3px; display: inline-grid; place-items: center; flex-shrink: 0; }
      .diet i { width: 7px; height: 7px; border-radius: 50%; background: #b3261e; }
      .diet.veg { border-color: #1e8a3c; }
      .diet.veg i { background: #1e8a3c; }
      .actions { display: inline-flex; gap: 0.15rem; }
      .danger:hover:not(:disabled) { color: var(--danger); background: var(--danger-soft); }
      .switch { min-height: 32px; }
      .switch-block { align-items: flex-start; }
      .switch-block .track { margin-top: 0.1rem; }
      .switch-block span:last-child { display: flex; flex-direction: column; gap: 0.1rem; line-height: 1.3; }
      .switch-block small { font-weight: 400; color: var(--text-muted); font-size: var(--fs-xs); }
      .switch-block strong { color: var(--text-strong); }
      .segmented.full { display: flex; }
      .segmented.full button { flex: 1; justify-content: center; }
      .price { max-width: 200px; margin-top: 0.5rem; }
      .portions { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.5rem; }
      .portion-row { display: grid; grid-template-columns: 1fr 160px 40px; gap: 0.5rem; align-items: center; }
      .add-size { align-self: flex-start; color: var(--primary); }
      @media (max-width: 900px) {
        .layout { grid-template-columns: 1fr; }
        .cats { position: static; display: flex; overflow-x: auto; gap: 0.25rem; }
        .cats-head { display: none; }
        .cat { width: auto; white-space: nowrap; flex-shrink: 0; }
        .cat-actions { display: none !important; }
        .cat-count { display: inline !important; }
      }
    `,
  ],
})
export class MenuAdminComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private socket = inject(SocketService);
  private ui = inject(UiService);
  private sub?: Subscription;
  private api = environment.apiUrl;

  readonly isOwner = this.auth.currentUser?.role === 'owner';
  readonly stations = STATIONS;

  readonly categories = signal<Category[]>([]);
  readonly items = signal<MenuItemData[]>([]);
  readonly loading = signal(true);
  readonly selectedId = signal<string>('all');
  readonly query = signal('');
  readonly stationFilter = signal<'all' | Station>('all');
  readonly onlyOut = signal(false);
  readonly showCategory = signal(false);
  readonly editingCategory = signal<Category | null>(null);
  readonly showItem = signal(false);
  readonly editingItem = signal<MenuItemData | null>(null);
  readonly saving = signal(false);
  readonly formError = signal('');

  categoryName = '';
  usePortions = false;
  f = this.emptyForm();

  readonly outOfStock = computed(() => this.items().filter((i) => !i.available).length);
  readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const cat = this.selectedId();
    const st = this.stationFilter();
    return this.items()
      .filter((i) => (cat === 'all' || this.catId(i) === cat) && (st === 'all' || i.station === st) && (!this.onlyOut() || !i.available))
      .filter((i) => !q || i.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  ngOnInit(): void {
    this.fetchCategories();
    this.fetchItems();
    this.sub = this.socket.fromEvent<MenuItemData>('menu:updated').subscribe((updated) => {
      if (!updated?._id) return;
      this.items.update((list) => {
        if (updated.active === false) return list.filter((i) => i._id !== updated._id);
        const idx = list.findIndex((i) => i._id === updated._id);
        if (idx === -1) return [...list, updated];
        const copy = list.slice();
        copy[idx] = { ...copy[idx], ...updated };
        return copy;
      });
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  private emptyForm() {
    return { name: '', printName: '', categoryId: '', price: 0, station: 'main' as Station, skipKitchen: false, isVeg: false, description: '', portions: [] as Portion[] };
  }

  catId(i: MenuItemData): string {
    return typeof i.categoryId === 'object' && i.categoryId ? String(i.categoryId._id) : String(i.categoryId);
  }

  countIn(catId: string): number {
    return this.items().filter((i) => this.catId(i) === catId).length;
  }

  stationLabel(s: Station): string {
    return STATIONS.find((x) => x.key === s)?.label ?? s;
  }

  minPrice(i: MenuItemData): number {
    return Math.min(...i.portions.map((p) => p.price));
  }

  maxPrice(i: MenuItemData): number {
    return Math.max(...i.portions.map((p) => p.price));
  }

  fetchCategories(): void {
    this.http.get<{ categories: Category[] }>(`${this.api}/categories`).subscribe({
      next: (res) => this.categories.set((res.categories || []).filter((c) => c.active).sort((a, b) => a.order - b.order)),
      error: (err) => this.ui.apiError(err, 'Could not load categories'),
    });
  }

  fetchItems(): void {
    this.http.get<{ items: MenuItemData[] }>(`${this.api}/items`).subscribe({
      next: (res) => {
        this.items.set(res.items || []);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.ui.apiError(err, 'Could not load dishes');
      },
    });
  }

  // ─── Categories ─────────────────────────────────────────────────────────
  moveCategory(cat: Category, dir: number): void {
    const list = this.categories();
    const idx = list.findIndex((c) => c._id === cat._id);
    const other = list[idx + dir];
    if (!other) return;
    // Optimistic swap, then persist both orders
    const reordered = list.slice();
    [reordered[idx], reordered[idx + dir]] = [other, cat];
    this.categories.set(reordered.map((c, i) => ({ ...c, order: i + 1 })));
    this.http.patch(`${this.api}/categories/${cat._id}`, { order: idx + dir + 1 }).subscribe({ error: () => this.fetchCategories() });
    this.http.patch(`${this.api}/categories/${other._id}`, { order: idx + 1 }).subscribe({ error: () => this.fetchCategories() });
  }

  openCategory(c?: Category): void {
    this.editingCategory.set(c ?? null);
    this.categoryName = c?.name ?? '';
    this.showCategory.set(true);
  }

  saveCategory(): void {
    const name = this.categoryName.trim();
    if (!name) return;
    const c = this.editingCategory();
    const req = c
      ? this.http.patch(`${this.api}/categories/${c._id}`, { name })
      : this.http.post(`${this.api}/categories`, { name, order: this.categories().length + 1 });
    req.subscribe({
      next: () => {
        this.showCategory.set(false);
        this.ui.success(c ? 'Category renamed' : `Category "${name}" added`);
        this.fetchCategories();
      },
      error: (err) => this.ui.apiError(err, 'Could not save the category'),
    });
  }

  async deleteCategory(c: Category): Promise<void> {
    const ok = await this.ui.confirm({ title: `Delete "${c.name}"?`, message: 'Only empty categories can be deleted.', confirmText: 'Delete', danger: true });
    if (!ok) return;
    this.http.delete(`${this.api}/categories/${c._id}`).subscribe({
      next: () => {
        this.showCategory.set(false);
        if (this.selectedId() === c._id) this.selectedId.set('all');
        this.ui.success('Category deleted');
        this.fetchCategories();
      },
      error: (err) => this.ui.apiError(err, 'Could not delete the category'),
    });
  }

  // ─── Dishes ─────────────────────────────────────────────────────────────
  openAddItem(): void {
    this.editingItem.set(null);
    this.f = this.emptyForm();
    const sel = this.selectedId();
    this.f.categoryId = sel !== 'all' ? sel : this.categories()[0]?._id ?? '';
    this.usePortions = false;
    this.formError.set('');
    this.showItem.set(true);
  }

  openEditItem(item: MenuItemData): void {
    this.editingItem.set(item);
    this.f = {
      name: item.name,
      printName: item.printName ?? '',
      categoryId: this.catId(item),
      price: item.price,
      station: item.station,
      skipKitchen: !!item.skipKitchen,
      isVeg: item.isVeg,
      description: item.description ?? '',
      portions: (item.portions ?? []).map((p) => ({ ...p })),
    };
    this.usePortions = this.f.portions.length > 0;
    this.formError.set('');
    this.showItem.set(true);
  }

  enablePortions(): void {
    this.usePortions = true;
    if (!this.f.portions.length) this.f.portions = [{ label: 'Half', price: 0 }, { label: 'Full', price: this.f.price || 0 }];
  }

  saveItem(): void {
    const name = this.f.name.trim();
    if (!name) return this.formError.set('Enter the dish name');
    if (!this.f.categoryId) return this.formError.set('Choose a category');
    const portions = this.usePortions ? this.f.portions.filter((p) => p.label.trim() && p.price > 0).map((p) => ({ label: p.label.trim(), price: p.price })) : [];
    if (this.usePortions && portions.length === 0) return this.formError.set('Add at least one size with a price');
    const price = this.usePortions ? Math.min(...portions.map((p) => p.price)) : this.f.price;
    if (!(price > 0)) return this.formError.set('Enter a price');

    const payload = {
      name,
      printName: this.f.printName.trim(),
      categoryId: this.f.categoryId,
      price,
      station: this.f.station,
      skipKitchen: this.f.skipKitchen,
      isVeg: this.f.isVeg,
      description: this.f.description.trim(),
      portions,
    };
    const editing = this.editingItem();
    this.saving.set(true);
    const req = editing ? this.http.patch(`${this.api}/items/${editing._id}`, payload) : this.http.post(`${this.api}/items`, payload);
    req.subscribe({
      next: () => {
        this.saving.set(false);
        this.showItem.set(false);
        this.ui.success(editing ? `${name} updated` : `${name} added to the menu`);
        this.fetchItems();
      },
      error: (err) => {
        this.saving.set(false);
        this.formError.set(err.error?.message || 'Could not save the dish');
      },
    });
  }

  toggleItemAvailability(item: MenuItemData): void {
    const next = !item.available;
    this.items.update((list) => list.map((i) => (i._id === item._id ? { ...i, available: next } : i)));
    this.http.patch<{ item: MenuItemData }>(`${this.api}/items/${item._id}/availability`, { available: next }).subscribe({
      next: () => this.ui.info(next ? `${item.name} is back on the menu` : `${item.name} hidden from waiters`),
      error: (err) => {
        this.items.update((list) => list.map((i) => (i._id === item._id ? { ...i, available: !next } : i)));
        this.ui.apiError(err, 'Could not update availability');
      },
    });
  }

  async deleteItem(item: MenuItemData): Promise<void> {
    const ok = await this.ui.confirm({
      title: `Delete ${item.name}?`,
      message: 'It disappears from the menu. Past orders and reports keep it. To hide it for today, switch it out of stock instead.',
      confirmText: 'Delete dish',
      danger: true,
    });
    if (!ok) return;
    this.http.delete(`${this.api}/items/${item._id}`).subscribe({
      next: () => {
        this.items.update((list) => list.filter((i) => i._id !== item._id));
        this.ui.success(`${item.name} deleted`);
      },
      error: (err) => this.ui.apiError(err, 'Could not delete'),
    });
  }
}
