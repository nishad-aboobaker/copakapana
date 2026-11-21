import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Subscription, concatMap, from, toArray, catchError, of } from 'rxjs';
import { environment } from '../../../environments/environment';
import { SocketService } from '../../core/socket/socket.service';
import { IconComponent } from '../../shared/icon.component';
import { UiService } from '../../shared/ui.service';

interface TableItem {
  _id: string;
  name?: string;
  number: string | number;
  floor: 'ground' | 'first';
  capacity: number;
  status: 'free' | 'occupied' | 'billing';
  active: boolean;
}

type Floor = 'ground' | 'first';

@Component({
  selector: 'app-tables-admin',
  // Angular 22 defaults to OnPush; this page keeps plain-field state updated by HTTP/socket callbacks
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: true,
  imports: [FormsModule, IconComponent],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1 class="page-title">Tables</h1>
          <p class="page-subtitle">{{ activeCount() }} tables in use · status updates live as waiters take orders</p>
        </div>
        <div class="page-actions">
          <button class="btn" (click)="openBulk()"><app-icon name="layers" /> Add several</button>
          <button class="btn btn-primary" (click)="openAdd()"><app-icon name="plus" /> Add table</button>
        </div>
      </header>

      <div class="toolbar">
        <div class="segmented">
          <button [class.active]="floor() === 'ground'" (click)="floor.set('ground')">Ground floor · {{ countFloor('ground') }}</button>
          <button [class.active]="floor() === 'first'" (click)="floor.set('first')">First floor · {{ countFloor('first') }}</button>
        </div>
        <div class="legend">
          <span><i class="free"></i> Free</span>
          <span><i class="occupied"></i> Occupied</span>
          <span><i class="billing"></i> Bill asked</span>
          <span><i class="off"></i> Disabled</span>
        </div>
      </div>

      @if (loading()) {
        <div class="grid-tables">
          @for (i of [1, 2, 3, 4, 5, 6]; track i) { <div class="skeleton" style="height: 120px; border-radius: 12px"></div> }
        </div>
      } @else if (floorTables().length === 0) {
        <div class="card">
          <div class="empty-state">
            <div class="empty-icon"><app-icon name="table" /></div>
            <h3>No tables on the {{ floor() === 'ground' ? 'ground' : 'first' }} floor</h3>
            <p>Add them one at a time, or several at once (e.g. T1–T13).</p>
            <div class="row">
              <button class="btn" (click)="openBulk()"><app-icon name="layers" /> Add several</button>
              <button class="btn btn-primary" (click)="openAdd()"><app-icon name="plus" /> Add table</button>
            </div>
          </div>
        </div>
      } @else {
        <div class="grid-tables">
          @for (t of floorTables(); track t._id) {
            <button class="tcard" [class]="'tcard ' + (t.active ? t.status : 'off')" (click)="openEdit(t)" [attr.aria-label]="'Edit table ' + label(t)">
              <span class="t-top">
                <span class="t-name">{{ label(t) }}</span>
                <app-icon name="pencil" [size]="15" class="t-edit" />
              </span>
              <span class="t-seats"><app-icon name="users" [size]="14" /> {{ t.capacity }} seats</span>
              <span class="t-status">{{ t.active ? statusLabel(t.status) : 'Disabled' }}</span>
            </button>
          }
          <button class="tcard add" (click)="openAdd()"><app-icon name="plus" /> Add table</button>
        </div>
      }

      <!-- ─── Add / edit ─── -->
      @if (showModal()) {
        <div class="modal-backdrop" (click)="showModal.set(false)">
          <form class="modal" role="dialog" aria-modal="true" (click)="$event.stopPropagation()" (ngSubmit)="saveTable()">
            <div class="modal-header">
              <div>
                <h3>{{ editing() ? 'Edit table ' + label(editing()!) : 'Add table' }}</h3>
                <p>The name is what waiters and the kitchen see, e.g. "T7".</p>
              </div>
              <button type="button" class="btn btn-ghost btn-icon modal-close" (click)="showModal.set(false)" aria-label="Close"><app-icon name="x" /></button>
            </div>
            <div class="modal-body">
              <div class="grid-2">
                <div class="field">
                  <label for="t-name">Name</label>
                  <input id="t-name" name="name" class="input" [(ngModel)]="modalName" autofocus required />
                </div>
                <div class="field">
                  <label for="t-cap">Seats</label>
                  <input id="t-cap" name="cap" class="input num" type="number" min="1" max="30" [(ngModel)]="modalCapacity" />
                </div>
              </div>
              <div class="field">
                <span class="label">Floor</span>
                <div class="segmented full">
                  <button type="button" [class.active]="modalFloor === 'ground'" (click)="modalFloor = 'ground'">Ground floor</button>
                  <button type="button" [class.active]="modalFloor === 'first'" (click)="modalFloor = 'first'">First floor</button>
                </div>
              </div>
              @if (editing()) {
                <label class="switch">
                  <input type="checkbox" name="active" [(ngModel)]="modalActive" [disabled]="editing()!.status !== 'free' && editing()!.active" />
                  <span class="track"></span>
                  In use (waiters can open orders on it)
                </label>
                @if (editing()!.status !== 'free' && editing()!.active) {
                  <span class="hint text-muted text-sm">A table with an open order can't be disabled.</span>
                }
              }
              @if (modalError()) {
                <div class="alert alert-danger"><app-icon name="alert-circle" /><div class="alert-body">{{ modalError() }}</div></div>
              }
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" (click)="showModal.set(false)">Cancel</button>
              <button type="submit" class="btn btn-primary" [disabled]="saving()">{{ editing() ? 'Save changes' : 'Add table' }}</button>
            </div>
          </form>
        </div>
      }

      <!-- ─── Bulk add ─── -->
      @if (showBulk()) {
        <div class="modal-backdrop" (click)="showBulk.set(false)">
          <form class="modal" role="dialog" aria-modal="true" (click)="$event.stopPropagation()" (ngSubmit)="bulkAdd()">
            <div class="modal-header">
              <div>
                <h3>Add several tables</h3>
                <p>Creates a numbered run, e.g. T4 to T16.</p>
              </div>
              <button type="button" class="btn btn-ghost btn-icon modal-close" (click)="showBulk.set(false)" aria-label="Close"><app-icon name="x" /></button>
            </div>
            <div class="modal-body">
              <div class="field">
                <span class="label">Floor</span>
                <div class="segmented full">
                  <button type="button" [class.active]="bulkFloor === 'ground'" (click)="bulkFloor = 'ground'">Ground floor</button>
                  <button type="button" [class.active]="bulkFloor === 'first'" (click)="bulkFloor = 'first'">First floor</button>
                </div>
              </div>
              <div class="grid-4 bulk-grid">
                <div class="field"><label for="b-prefix">Prefix</label><input id="b-prefix" name="prefix" class="input" [(ngModel)]="bulkPrefix" /></div>
                <div class="field"><label for="b-from">From</label><input id="b-from" name="from" class="input num" type="number" min="1" [(ngModel)]="bulkFrom" /></div>
                <div class="field"><label for="b-to">To</label><input id="b-to" name="to" class="input num" type="number" min="1" [(ngModel)]="bulkTo" /></div>
                <div class="field"><label for="b-cap">Seats</label><input id="b-cap" name="bcap" class="input num" type="number" min="1" [(ngModel)]="bulkCapacity" /></div>
              </div>
              <div class="preview">
                @for (n of bulkPreview; track n) { <span class="chip">{{ n }}</span> }
                @if (bulkCount > bulkPreview.length) { <span class="text-muted text-sm">+{{ bulkCount - bulkPreview.length }} more</span> }
              </div>
              @if (modalError()) {
                <div class="alert alert-danger"><app-icon name="alert-circle" /><div class="alert-body">{{ modalError() }}</div></div>
              }
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" (click)="showBulk.set(false)">Cancel</button>
              <button type="submit" class="btn btn-primary" [disabled]="saving() || bulkCount < 1 || bulkCount > 50">
                @if (saving()) { <span class="spinner"></span> } Add {{ bulkCount }} table{{ bulkCount === 1 ? '' : 's' }}
              </button>
            </div>
          </form>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
      .legend { display: flex; gap: 1rem; font-size: var(--fs-xs); color: var(--text-muted); font-weight: 600; flex-wrap: wrap; }
      .legend span { display: inline-flex; align-items: center; gap: 0.35rem; }
      .legend i { width: 10px; height: 10px; border-radius: 3px; background: var(--free); }
      .legend i.occupied { background: var(--occupied); }
      .legend i.billing { background: var(--billing); }
      .legend i.off { background: var(--gray-300); }
      .grid-tables { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0.75rem; }
      .tcard { display: flex; flex-direction: column; gap: 0.35rem; padding: 1rem; min-height: 120px; text-align: left; border-radius: var(--radius); border: 1.5px solid var(--border); background: var(--surface); position: relative; transition: box-shadow 0.15s, border-color 0.15s; }
      .tcard:hover { box-shadow: var(--shadow); border-color: var(--border-strong); }
      .tcard::before { content: ''; position: absolute; left: 0; top: 14px; bottom: 14px; width: 4px; border-radius: 0 4px 4px 0; background: var(--free); }
      .tcard.occupied::before { background: var(--occupied); }
      .tcard.billing::before { background: var(--billing); }
      .tcard.off { background: var(--gray-50); border-style: dashed; }
      .tcard.off::before { background: var(--gray-300); }
      .tcard.off .t-name { color: var(--text-muted); }
      .t-top { display: flex; justify-content: space-between; align-items: center; }
      .t-name { font-size: 1.5rem; font-weight: 800; color: var(--text-strong); letter-spacing: -0.02em; }
      .t-edit { color: var(--text-subtle); opacity: 0; transition: opacity 0.15s; }
      .tcard:hover .t-edit { opacity: 1; }
      .t-seats { display: inline-flex; align-items: center; gap: 0.3rem; font-size: var(--fs-sm); color: var(--text-muted); }
      .t-status { margin-top: auto; font-size: var(--fs-xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--free); }
      .tcard.occupied .t-status { color: var(--occupied); }
      .tcard.billing .t-status { color: var(--billing); }
      .tcard.off .t-status { color: var(--text-subtle); }
      .tcard.add { align-items: center; justify-content: center; flex-direction: row; gap: 0.4rem; border-style: dashed; color: var(--text-muted); font-weight: 600; }
      .tcard.add::before { display: none; }
      .segmented.full { display: flex; }
      .segmented.full button { flex: 1; justify-content: center; }
      .bulk-grid { grid-template-columns: 1fr 1fr 1fr 1fr !important; }
      .preview { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; }
      .preview .chip { min-height: 28px; cursor: default; }
    `,
  ],
})
export class TablesAdminComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private socket = inject(SocketService);
  private ui = inject(UiService);
  private sub?: Subscription;

  readonly tables = signal<TableItem[]>([]);
  readonly loading = signal(true);
  readonly floor = signal<Floor>('ground');
  readonly showModal = signal(false);
  readonly showBulk = signal(false);
  readonly editing = signal<TableItem | null>(null);
  readonly saving = signal(false);
  readonly modalError = signal('');

  modalName = '';
  modalFloor: Floor = 'ground';
  modalCapacity = 4;
  modalActive = true;

  bulkFloor: Floor = 'first';
  bulkPrefix = 'T';
  bulkFrom = 1;
  bulkTo = 10;
  bulkCapacity = 4;

  readonly floorTables = computed(() =>
    this.tables()
      .filter((t) => t.floor === this.floor())
      .sort((a, b) => this.label(a).localeCompare(this.label(b), undefined, { numeric: true })),
  );
  readonly activeCount = computed(() => this.tables().filter((t) => t.active).length);

  ngOnInit(): void {
    this.fetchTables();
    this.sub = this.socket.fromEvent<TableItem>('table:updated').subscribe((updated) => {
      this.tables.update((list) => {
        const idx = list.findIndex((t) => t._id === updated._id);
        if (idx === -1) return [...list, updated];
        const copy = list.slice();
        copy[idx] = updated;
        return copy;
      });
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  label(t: TableItem): string {
    return String(t.name || t.number || '');
  }

  statusLabel(s: TableItem['status']): string {
    return s === 'free' ? 'Free' : s === 'occupied' ? 'Occupied' : 'Bill asked';
  }

  countFloor(f: Floor): number {
    return this.tables().filter((t) => t.floor === f && t.active).length;
  }

  fetchTables(): void {
    this.http.get<{ tables: TableItem[] }>(`${environment.apiUrl}/tables?all=1`).subscribe({
      next: (res) => {
        this.tables.set(res.tables || []);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.ui.apiError(err, 'Could not load tables');
      },
    });
  }

  /** Next free "T<n>" name across both floors. */
  private nextName(): string {
    const nums = this.tables()
      .map((t) => /^T?(\d+)$/i.exec(this.label(t))?.[1])
      .filter(Boolean)
      .map(Number);
    return `T${(nums.length ? Math.max(...nums) : 0) + 1}`;
  }

  openAdd(): void {
    this.editing.set(null);
    this.modalName = this.nextName();
    this.modalFloor = this.floor();
    this.modalCapacity = 4;
    this.modalActive = true;
    this.modalError.set('');
    this.showModal.set(true);
  }

  openEdit(t: TableItem): void {
    this.editing.set(t);
    this.modalName = this.label(t);
    this.modalFloor = t.floor;
    this.modalCapacity = t.capacity;
    this.modalActive = t.active;
    this.modalError.set('');
    this.showModal.set(true);
  }

  saveTable(): void {
    const name = this.modalName.trim();
    if (!name) return this.modalError.set('Enter a table name');
    if (!this.modalCapacity || this.modalCapacity < 1) return this.modalError.set('Seats must be at least 1');
    const editing = this.editing();
    const body: any = { name, number: name, floor: this.modalFloor, capacity: this.modalCapacity };
    if (editing) body.active = this.modalActive;

    this.saving.set(true);
    const req = editing
      ? this.http.patch(`${environment.apiUrl}/tables/${editing._id}`, body)
      : this.http.post(`${environment.apiUrl}/tables`, body);
    req.subscribe({
      next: () => {
        this.saving.set(false);
        this.showModal.set(false);
        this.floor.set(this.modalFloor);
        this.ui.success(editing ? `Table ${name} updated` : `Table ${name} added`);
        this.fetchTables();
      },
      error: (err) => {
        this.saving.set(false);
        this.modalError.set(err.error?.message || 'Could not save the table');
      },
    });
  }

  openBulk(): void {
    const next = Number(this.nextName().slice(1));
    this.bulkFloor = this.floor();
    this.bulkPrefix = 'T';
    this.bulkFrom = next;
    this.bulkTo = next + (this.bulkFloor === 'ground' ? 2 : 12);
    this.bulkCapacity = 4;
    this.modalError.set('');
    this.showBulk.set(true);
  }

  get bulkCount(): number {
    return Math.max(0, (this.bulkTo || 0) - (this.bulkFrom || 0) + 1);
  }

  get bulkPreview(): string[] {
    const out: string[] = [];
    for (let n = this.bulkFrom; n <= this.bulkTo && out.length < 12; n++) out.push(`${this.bulkPrefix}${n}`);
    return out;
  }

  bulkAdd(): void {
    if (this.bulkCount < 1 || this.bulkCount > 50) return this.modalError.set('Choose between 1 and 50 tables');
    const names = Array.from({ length: this.bulkCount }, (_, i) => `${this.bulkPrefix}${this.bulkFrom + i}`);
    const existing = new Set(this.tables().map((t) => this.label(t).toLowerCase()));
    const clash = names.filter((n) => existing.has(n.toLowerCase()));
    if (clash.length) return this.modalError.set(`Already exists: ${clash.join(', ')}`);

    this.saving.set(true);
    from(names)
      .pipe(
        concatMap((name) =>
          this.http
            .post(`${environment.apiUrl}/tables`, { name, number: name, floor: this.bulkFloor, capacity: this.bulkCapacity })
            .pipe(catchError(() => of(null))),
        ),
        toArray(),
      )
      .subscribe((results) => {
        this.saving.set(false);
        const ok = results.filter(Boolean).length;
        this.showBulk.set(false);
        this.floor.set(this.bulkFloor);
        if (ok === names.length) this.ui.success(`${ok} tables added`);
        else this.ui.warning(`${ok} of ${names.length} tables added`);
        this.fetchTables();
      });
  }
}
