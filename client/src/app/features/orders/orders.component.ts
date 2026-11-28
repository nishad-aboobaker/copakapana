import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { environment } from '../../../environments/environment';
import { IconComponent } from '../../shared/icon.component';
import { UiService } from '../../shared/ui.service';

type OrderType = 'dine_in' | 'takeaway' | 'delivery';
type OrderStatus = 'open' | 'billed' | 'paid' | 'cancelled';

interface OrderRow {
  _id: string;
  number: number;
  type: OrderType;
  status: OrderStatus;
  createdAt: string;
  table: { name?: string; floor?: string } | null;
  customer: { name?: string; phone?: string; address?: string } | null;
  waiterName: string;
  itemCount: number;
  itemsTotal: number;
  bill: {
    _id: string;
    number: number;
    total: number;
    status: 'open' | 'paid' | 'void';
    paidAt?: string;
    businessDate?: string;
    discountAmount: number;
    modes: string[];
  } | null;
}

interface HistoryResponse {
  from: string;
  to: string;
  total: number;
  orders: OrderRow[];
  totals: { paidTotal: number; paidCount: number; byStatus: Partial<Record<OrderStatus, number>> };
}

interface OrderDetail {
  order: {
    _id: string;
    number: number;
    type: OrderType;
    status: OrderStatus;
    createdAt: string;
    updatedAt: string;
    tableId?: { name?: string; number?: string; floor?: string } | null;
    waiterId?: { name?: string } | null;
    customerSnapshot?: { name?: string; phone?: string; address?: string };
    items: { _id: string; name: string; qty: number; price: number; portion?: string; note?: string; status: 'active' | 'cancelled'; skipKitchen?: boolean }[];
    delivery?: { status?: string; riderName?: string; deliveredAt?: string; collectedMode?: string; collectedAmount?: number };
  };
  tickets: { _id: string; number: number; station: string; status: string; createdAt: string; isEdited?: boolean; editedAt?: string }[];
  bill: {
    _id: string;
    number: number;
    status: 'open' | 'paid' | 'void';
    subtotal: number;
    discountAmount: number;
    discount?: { type?: string; value?: number; reason?: string };
    gst: number;
    serviceCharge: number;
    total: number;
    payments: { mode: string; amount: number; tendered?: number; change?: number }[];
    paidAt?: string;
    closedByName?: string;
    voidReason?: string;
    businessDate?: string;
    createdAt: string;
  } | null;
}

const STATION_NAMES: Record<string, string> = { fried_chicken: 'Fried Chicken', juice: 'Juice', main: 'Main Kitchen' };
const PAGE_SIZE = 50;
const todayIST = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const addDays = (ymd: string, n: number): string => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Orders — every order by business day, with its items, bill and kitchen tickets,
 * filters and bill printing (cashier and above).
 */
@Component({
  selector: 'app-orders',
  standalone: true,
  imports: [IconComponent, FormsModule],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1 class="page-title">Orders</h1>
          <p class="page-subtitle">Every order by business day. Open one to see its details or print its bill.</p>
        </div>
      </header>

      <section class="card filters">
        <div class="field date"><label for="o-from">From</label><input id="o-from" class="input" type="date" [max]="today" [(ngModel)]="from" (change)="reload()" /></div>
        <div class="field date"><label for="o-to">To</label><input id="o-to" class="input" type="date" [max]="today" [(ngModel)]="to" (change)="reload()" /></div>
        <div class="presets">
          <button class="btn btn-sm" [class.btn-soft]="preset() === 'today'" (click)="setPreset('today')">Today</button>
          <button class="btn btn-sm" [class.btn-soft]="preset() === 'yesterday'" (click)="setPreset('yesterday')">Yesterday</button>
          <button class="btn btn-sm" [class.btn-soft]="preset() === 'week'" (click)="setPreset('week')">Last 7 days</button>
          <button class="btn btn-sm" [class.btn-soft]="preset() === 'month'" (click)="setPreset('month')">This month</button>
        </div>
        <div class="row2">
          <div class="segmented">
            @for (t of typeFilters; track t.key) {
              <button [class.active]="type === t.key" (click)="type = t.key; reload()">{{ t.label }}</button>
            }
          </div>
          <select class="select status" aria-label="Status" [(ngModel)]="status" (change)="reload()">
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="billed">Billed</option>
            <option value="paid">Paid</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <div class="input-group search">
            <app-icon name="search" />
            <input class="input" type="search" placeholder="Order #, table, customer or phone" [value]="q" (input)="onSearch($any($event.target).value)" aria-label="Search orders" />
          </div>
        </div>
      </section>

      @if (data(); as d) {
        <div class="summary">
          <span><strong>{{ d.total }}</strong> order{{ d.total === 1 ? '' : 's' }}</span>
          <span><strong>{{ money(d.totals.paidTotal) }}</strong> paid ({{ d.totals.paidCount }} bill{{ d.totals.paidCount === 1 ? '' : 's' }})</span>
          @if (d.totals.byStatus.open || d.totals.byStatus.billed) { <span class="warn"><strong>{{ (d.totals.byStatus.open || 0) + (d.totals.byStatus.billed || 0) }}</strong> not paid yet</span> }
          @if (d.totals.byStatus.cancelled) { <span class="muted"><strong>{{ d.totals.byStatus.cancelled }}</strong> cancelled</span> }
        </div>
      }

      <div class="layout" [class.has-detail]="selectedId()">
        <section class="list-pane">
          @if (loading() && rows().length === 0) {
            <div class="skeleton" style="height: 300px; border-radius: 12px"></div>
          } @else if (rows().length === 0) {
            <div class="card"><div class="empty-state">
              <div class="empty-icon"><app-icon name="receipt" /></div>
              <h3>No orders</h3>
              <p>Nothing matches these dates and filters.</p>
            </div></div>
          } @else {
            <ul class="order-list card" role="list">
              @for (o of rows(); track o._id) {
                <li>
                  <button class="order-row" [class.active]="o._id === selectedId()" (click)="select(o._id)">
                    <span class="type-icon" [class]="'type-icon ' + o.type"><app-icon [name]="typeIcon(o.type)" /></span>
                    <span class="who">
                      <span class="title">#{{ o.number }} · {{ where(o) }}</span>
                      <span class="sub">{{ dateTime(o.createdAt) }}{{ o.waiterName ? ' · ' + o.waiterName : '' }} · {{ o.itemCount }} item{{ o.itemCount === 1 ? '' : 's' }}</span>
                    </span>
                    <span class="right">
                      <span class="amt">{{ money(o.bill?.total ?? o.itemsTotal) }}</span>
                      <span class="badge" [class]="'badge ' + statusClass(o)">{{ statusLabel(o) }}</span>
                    </span>
                  </button>
                </li>
              }
            </ul>
            @if (rows().length < (data()?.total ?? 0)) {
              <button class="btn btn-block" [disabled]="loading()" (click)="loadMore()">{{ loading() ? 'Loading…' : 'Show more' }}</button>
            }
          }
        </section>

        <section class="detail-pane">
          @if (!selectedId()) {
            <div class="card placeholder"><div class="empty-state">
              <div class="empty-icon"><app-icon name="file" /></div>
              <h3>Select an order</h3>
              <p>See its items, bill, payment and kitchen tickets, and print the bill.</p>
            </div></div>
          } @else if (detail(); as d) {
            <button class="btn btn-ghost back" (click)="selectedId.set(null)"><app-icon name="arrow-left" /> All orders</button>

            <div class="card head">
              <div class="head-main">
                <span class="type-icon lg" [class]="'type-icon lg ' + d.order.type"><app-icon [name]="typeIcon(d.order.type)" /></span>
                <div>
                  <h2>Order #{{ d.order.number }} <span class="badge" [class]="'badge ' + statusClass(rowLike(d))">{{ statusLabel(rowLike(d)) }}</span></h2>
                  <span class="text-muted text-sm">{{ typeLabel(d.order.type) }} · {{ detailWhere(d) }} · {{ dateTime(d.order.createdAt) }}{{ d.order.waiterId?.name ? ' · ' + d.order.waiterId?.name : '' }}</span>
                </div>
              </div>
              <div class="print-actions">
                @if (d.bill && d.bill.status !== 'void') {
                  <button class="btn btn-primary" [disabled]="printing()" (click)="printBill(d)"><app-icon name="printer" /> {{ d.bill.status === 'paid' ? 'Reprint bill' : 'Print bill' }}</button>
                } @else if (!d.bill && (d.order.status === 'open' || d.order.status === 'billed') && hasActiveItems(d)) {
                  <button class="btn btn-primary" [disabled]="printing()" (click)="generateAndPrint(d)"><app-icon name="printer" /> Generate &amp; print bill</button>
                }
                @if (d.order.type === 'delivery' && d.bill && d.bill.status !== 'void') {
                  <button class="btn" [disabled]="printing()" (click)="printDeliveryBill(d)"><app-icon name="bike" /> Delivery bill</button>
                }
              </div>
            </div>

            @if (d.order.customerSnapshot?.name || d.order.customerSnapshot?.phone) {
              <div class="card cust">
                <app-icon name="user" />
                <div>
                  <strong>{{ d.order.customerSnapshot?.name }}</strong>
                  @if (d.order.customerSnapshot?.phone) { · <a [href]="'tel:' + d.order.customerSnapshot?.phone">{{ d.order.customerSnapshot?.phone }}</a> }
                  @if (d.order.customerSnapshot?.address) { <div class="text-muted text-sm">{{ d.order.customerSnapshot?.address }}</div> }
                  @if (d.order.delivery?.status) {
                    <div class="text-sm">Delivery: <strong>{{ deliveryLabel(d) }}</strong></div>
                  }
                </div>
              </div>
            }

            <div class="card">
              <div class="card-header"><h3>Items</h3><span class="text-muted text-sm">{{ activeCount(d) }} item{{ activeCount(d) === 1 ? '' : 's' }}</span></div>
              <table class="table items">
                <tbody>
                  @for (i of d.order.items; track i._id) {
                    <tr [class.cancelled]="i.status === 'cancelled'">
                      <td class="qty">{{ i.qty }}×</td>
                      <td>
                        {{ i.name }}@if (i.portion) { <span class="text-muted"> · {{ i.portion }}</span> }
                        @if (i.skipKitchen) { <span class="badge">Counter</span> }
                        @if (i.status === 'cancelled') { <span class="badge badge-danger">Cancelled</span> }
                        @if (i.note) { <div class="note">{{ i.note }}</div> }
                      </td>
                      <td class="text-right num">{{ money(i.price) }}</td>
                      <td class="text-right num strong">{{ money(i.price * i.qty) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>

            @if (d.bill; as b) {
              <div class="card">
                <div class="card-header"><h3>Bill #{{ b.number }}</h3><span class="badge" [class.badge-success]="b.status === 'paid'" [class.badge-danger]="b.status === 'void'" [class.badge-warning]="b.status === 'open'">{{ b.status === 'open' ? 'Not paid' : b.status }}</span></div>
                <div class="card-body bill">
                  <div class="line"><span>Subtotal</span><span class="num">{{ money(b.subtotal) }}</span></div>
                  @if (b.discountAmount) { <div class="line"><span>Discount{{ b.discount?.reason ? ' · ' + b.discount?.reason : '' }}</span><span class="num">−{{ money(b.discountAmount) }}</span></div> }
                  @if (b.gst) { <div class="line"><span>GST</span><span class="num">{{ money(b.gst) }}</span></div> }
                  @if (b.serviceCharge) { <div class="line"><span>Service charge</span><span class="num">{{ money(b.serviceCharge) }}</span></div> }
                  <div class="line total"><span>Total</span><span class="num">{{ money(b.total) }}</span></div>
                  @for (p of b.payments; track $index) {
                    <div class="line pay"><span>Paid by {{ modeLabel(p.mode) }}{{ p.tendered && p.tendered > p.amount ? ' · given ' + money(p.tendered) : '' }}</span><span class="num">{{ money(p.amount) }}</span></div>
                  }
                  <div class="meta text-sm text-muted">
                    @if (b.paidAt) { <span>Settled {{ dateTime(b.paidAt) }}{{ b.closedByName ? ' by ' + b.closedByName : '' }}</span> }
                    @if (b.businessDate) { <span>Counted for {{ dayLabel(b.businessDate) }}</span> }
                    @if (b.voidReason) { <span class="text-danger">Void: {{ b.voidReason }}</span> }
                  </div>
                </div>
              </div>
            } @else {
              <div class="card"><div class="card-body text-muted text-sm">No bill yet{{ d.order.status === 'cancelled' ? ' — the order was cancelled.' : '.' }}</div></div>
            }

            @if (d.tickets.length) {
              <div class="card">
                <div class="card-header"><h3>Kitchen tickets</h3></div>
                <ul class="tickets">
                  @for (t of d.tickets; track t._id) {
                    <li>
                      <span>{{ stationName(t.station) }} · #{{ t.number }}
                        @if (t.isEdited) { <span class="badge badge-danger">Extra</span> } @else if (t.editedAt) { <span class="badge badge-warning">Updated</span> }
                      </span>
                      <span class="text-muted text-sm">{{ time(t.createdAt) }} · {{ ticketStatus(t.status) }}</span>
                    </li>
                  }
                </ul>
              </div>
            }
          } @else {
            <div class="skeleton" style="height: 420px; border-radius: 12px"></div>
          }
        </section>
      </div>
    </div>
  `,
  styles: [
    `
      .filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.75rem; padding: 1rem 1.25rem; margin-bottom: 0.75rem; }
      .filters .date { width: 165px; }
      .presets { display: flex; flex-wrap: wrap; gap: 0.35rem; padding-bottom: 0.35rem; }
      .row2 { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; width: 100%; }
      .status { width: 160px; }
      .search { flex: 1; min-width: 220px; }
      .summary { display: flex; flex-wrap: wrap; gap: 0.4rem 1.25rem; margin: 0 0 0.9rem; font-size: var(--fs-sm); color: var(--text-muted); }
      .summary strong { color: var(--text-strong); font-variant-numeric: tabular-nums; }
      .summary .warn strong { color: var(--warning); }

      .layout { display: grid; grid-template-columns: minmax(320px, 430px) 1fr; gap: 1.25rem; align-items: start; }
      .list-pane { display: flex; flex-direction: column; gap: 0.6rem; position: sticky; top: 1rem; }
      .order-list { list-style: none; margin: 0; padding: 0.35rem; max-height: calc(100vh - 20rem); overflow-y: auto; }
      .order-row { width: 100%; display: flex; align-items: center; gap: 0.65rem; padding: 0.65rem 0.6rem; border: 0; background: none; border-radius: var(--radius-sm, 8px); text-align: left; cursor: pointer; color: inherit; }
      .order-row:hover { background: var(--gray-50, #f7f6f4); }
      .order-row.active { background: var(--primary-soft); }
      .who { display: flex; flex-direction: column; min-width: 0; flex: 1; }
      .title { font-weight: 650; color: var(--text-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sub { font-size: var(--fs-xs); color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .right { display: flex; flex-direction: column; align-items: flex-end; gap: 0.2rem; }
      .amt { font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text-strong); }
      .type-icon { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: var(--gray-100); color: var(--text-muted); flex-shrink: 0; }
      .type-icon.lg { width: 44px; height: 44px; }
      .type-icon.delivery { background: var(--info-soft); color: var(--info); }
      .type-icon.takeaway { background: var(--warning-soft); color: var(--warning); }

      .detail-pane { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
      .placeholder { min-height: 320px; display: grid; place-items: center; }
      .back { display: none; align-self: flex-start; }
      .head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; padding: 1rem 1.25rem; }
      .head-main { display: flex; align-items: center; gap: 0.8rem; min-width: 0; }
      .head h2 { font-size: var(--fs-lg); display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
      .print-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
      .cust { display: flex; gap: 0.7rem; align-items: flex-start; padding: 0.9rem 1.25rem; }
      .cust app-icon { color: var(--text-subtle); display: inline-flex; margin-top: 0.15rem; }
      .cust a { color: var(--primary); text-decoration: none; }
      .items td { vertical-align: top; }
      .items .qty { width: 2.75rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
      .items tr.cancelled td { color: var(--text-subtle); text-decoration: line-through; }
      .items tr.cancelled .badge { text-decoration: none; }
      .items .badge { margin-left: 0.35rem; }
      .note { font-size: var(--fs-xs); color: var(--text-muted); font-style: italic; }
      .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
      .strong { font-weight: 700; color: var(--text-strong); }
      .bill { display: flex; flex-direction: column; gap: 0.35rem; }
      .bill .line { display: flex; justify-content: space-between; gap: 1rem; }
      .bill .total { font-weight: 800; font-size: var(--fs-md); color: var(--text-strong); border-top: 1px dashed var(--border); padding-top: 0.45rem; margin-top: 0.2rem; }
      .bill .pay { color: var(--success); font-weight: 600; }
      .bill .meta { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; margin-top: 0.4rem; }
      .tickets { list-style: none; margin: 0; padding: 0.4rem 1.25rem 0.8rem; }
      .tickets li { display: flex; justify-content: space-between; gap: 1rem; padding: 0.45rem 0; border-bottom: 1px solid var(--gray-100); }
      .tickets li:last-child { border-bottom: 0; }

      @media (max-width: 900px) {
        .layout { grid-template-columns: 1fr; }
        .list-pane { position: static; }
        .order-list { max-height: none; }
        .layout.has-detail .list-pane { display: none; }
        .layout:not(.has-detail) .detail-pane { display: none; }
        .back { display: inline-flex; }
      }
      @media (max-width: 560px) {
        .filters .date { width: calc(50% - 0.4rem); }
        .status { width: 100%; }
        .segmented { width: 100%; display: flex; }
        .segmented button { flex: 1; justify-content: center; padding: 0 0.4rem; }
      }
    `,
  ],
})
export class OrdersComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private ui = inject(UiService);

  readonly today = todayIST();
  readonly typeFilters: { key: '' | OrderType; label: string }[] = [
    { key: '', label: 'All' },
    { key: 'dine_in', label: 'Dine-in' },
    { key: 'takeaway', label: 'Takeaway' },
    { key: 'delivery', label: 'Delivery' },
  ];

  from = todayIST();
  to = todayIST();
  type: '' | OrderType = '';
  status: '' | OrderStatus = '';
  q = '';
  preset = signal<'today' | 'yesterday' | 'week' | 'month' | ''>('today');

  data = signal<HistoryResponse | null>(null);
  rows = signal<OrderRow[]>([]);
  loading = signal(false);
  private page = 1;

  selectedId = signal<string | null>(null);
  detail = signal<OrderDetail | null>(null);
  printing = signal(false);

  private searchTimer?: ReturnType<typeof setTimeout>;
  private listSub?: Subscription;
  private detailSub?: Subscription;

  ngOnInit(): void {
    // Start on the current business day (after midnight that's still yesterday's date)
    this.http.get<{ date: string }>(`${environment.apiUrl}/business-day`).subscribe({
      next: (d) => {
        if (d?.date && d.date <= this.today) {
          this.from = d.date;
          this.to = d.date;
        }
        this.reload();
      },
      error: () => this.reload(),
    });
  }

  ngOnDestroy(): void {
    clearTimeout(this.searchTimer);
    this.listSub?.unsubscribe();
    this.detailSub?.unsubscribe();
  }

  setPreset(p: 'today' | 'yesterday' | 'week' | 'month'): void {
    const t = this.today;
    if (p === 'today') [this.from, this.to] = [t, t];
    if (p === 'yesterday') [this.from, this.to] = [addDays(t, -1), addDays(t, -1)];
    if (p === 'week') [this.from, this.to] = [addDays(t, -6), t];
    if (p === 'month') [this.from, this.to] = [`${t.slice(0, 7)}-01`, t];
    this.preset.set(p);
    this.load(true);
  }

  reload(): void {
    this.preset.set(this.from === this.to && this.to === this.today ? 'today' : '');
    this.load(true);
  }

  onSearch(v: string): void {
    this.q = v;
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.load(true), 250);
  }

  loadMore(): void {
    this.page += 1;
    this.load(false);
  }

  private load(reset: boolean): void {
    if (!this.from || !this.to) return;
    if (this.from > this.to) [this.from, this.to] = [this.to, this.from];
    if (reset) this.page = 1;
    this.loading.set(true);
    this.listSub?.unsubscribe();
    const params: Record<string, string> = { from: this.from, to: this.to, page: String(this.page), limit: String(PAGE_SIZE) };
    if (this.type) params['type'] = this.type;
    if (this.status) params['status'] = this.status;
    if (this.q.trim()) params['q'] = this.q.trim();
    this.listSub = this.http.get<HistoryResponse>(`${environment.apiUrl}/orders/history`, { params }).subscribe({
      next: (r) => {
        this.data.set(r);
        this.rows.set(reset ? r.orders : [...this.rows(), ...r.orders]);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.ui.apiError(err, 'Could not load orders');
      },
    });
  }

  select(id: string): void {
    if (this.selectedId() !== id) this.detail.set(null);
    this.selectedId.set(id);
    this.detailSub?.unsubscribe();
    this.detailSub = this.http.get<OrderDetail>(`${environment.apiUrl}/orders/${id}`).subscribe({
      next: (d) => this.detail.set(d),
      error: (err) => this.ui.apiError(err, 'Could not load this order'),
    });
  }

  // ─── Printing ──────────────────────────────────────────────────────────
  printBill(d: OrderDetail): void {
    if (!d.bill || this.printing()) return;
    this.printing.set(true);
    this.http.post(`${environment.apiUrl}/bills/${d.bill._id}/reprint`, {}).subscribe({
      next: () => {
        this.printing.set(false);
        this.ui.success(`Bill #${d.bill!.number} sent to the counter printer`);
      },
      error: (err) => {
        this.printing.set(false);
        this.ui.apiError(err, 'Could not print the bill');
      },
    });
  }

  async generateAndPrint(d: OrderDetail): Promise<void> {
    const ok = await this.ui.confirm({
      title: `Generate the bill for order #${d.order.number}?`,
      message: 'This prints the bill and locks the items, the same as Generate & print bill on the billing desk. Payment is still taken at the billing desk.',
      confirmText: 'Generate & print',
    });
    if (!ok) return;
    this.printing.set(true);
    this.http.post(`${environment.apiUrl}/orders/${d.order._id}/bill`, {}).subscribe({
      next: () => {
        this.printing.set(false);
        this.ui.success('Bill sent to the counter printer');
        this.select(d.order._id);
        this.load(true);
      },
      error: (err) => {
        this.printing.set(false);
        this.ui.apiError(err, 'Could not generate the bill');
      },
    });
  }

  printDeliveryBill(d: OrderDetail): void {
    if (!d.bill || this.printing()) return;
    this.printing.set(true);
    this.http.post<{ amountDue: number }>(`${environment.apiUrl}/bills/${d.bill._id}/delivery-bill`, {}).subscribe({
      next: () => {
        this.printing.set(false);
        this.ui.success('Delivery bill sent to the counter printer');
      },
      error: (err) => {
        this.printing.set(false);
        this.ui.apiError(err, 'Could not print the delivery bill');
      },
    });
  }

  // ─── Display helpers ───────────────────────────────────────────────────
  where(o: OrderRow): string {
    if (o.type === 'dine_in') return o.table?.name ? `Table ${o.table.name}` : 'Dine-in';
    return o.customer?.name || (o.type === 'delivery' ? 'Delivery' : 'Takeaway');
  }

  detailWhere(d: OrderDetail): string {
    const t = d.order.tableId;
    if (d.order.type === 'dine_in') return t ? `Table ${t.name ?? t.number}${t.floor ? ' · ' + (t.floor === 'ground' ? 'Ground floor' : t.floor === 'first' ? 'First floor' : t.floor) : ''}` : 'Dine-in';
    return d.order.customerSnapshot?.name || '';
  }

  /** Shape the detail like a list row for the shared status helpers. */
  rowLike(d: OrderDetail): OrderRow {
    return { status: d.order.status, bill: d.bill ? { status: d.bill.status } : null } as OrderRow;
  }

  hasActiveItems(d: OrderDetail): boolean {
    return d.order.items.some((i) => i.status === 'active');
  }

  activeCount(d: OrderDetail): number {
    return d.order.items.filter((i) => i.status === 'active').reduce((n, i) => n + i.qty, 0);
  }

  typeLabel(t: OrderType): string {
    return t === 'dine_in' ? 'Dine-in' : t === 'takeaway' ? 'Takeaway' : 'Delivery';
  }

  typeIcon(t: OrderType): string {
    return t === 'delivery' ? 'bike' : t === 'takeaway' ? 'bag' : 'utensils';
  }

  statusLabel(o: Pick<OrderRow, 'status' | 'bill'>): string {
    if (o.status === 'cancelled') return 'Cancelled';
    if (o.bill?.status === 'void') return 'Void';
    if (o.bill?.status === 'paid' || o.status === 'paid') return 'Paid';
    if (o.status === 'billed') return 'Billed';
    return 'Open';
  }

  statusClass(o: Pick<OrderRow, 'status' | 'bill'>): string {
    const s = this.statusLabel(o);
    return s === 'Paid' ? 'badge-success' : s === 'Cancelled' || s === 'Void' ? 'badge-danger' : s === 'Billed' ? 'badge-info' : 'badge-warning';
  }

  deliveryLabel(d: OrderDetail): string {
    const x = d.order.delivery;
    if (!x?.status) return '';
    if (x.status === 'delivered') {
      const got = x.collectedAmount ? ` · collected ${this.money(x.collectedAmount)} ${this.modeLabel(x.collectedMode ?? '')}` : '';
      return `Delivered ${x.deliveredAt ? this.time(x.deliveredAt) : ''}${x.riderName ? ' by ' + x.riderName : ''}${got}`;
    }
    return x.status === 'out' ? `On the way${x.riderName ? ' with ' + x.riderName : ''}` : 'Waiting for pickup';
  }

  stationName(s: string): string {
    return STATION_NAMES[s] || s;
  }

  ticketStatus(s: string): string {
    return s === 'new' ? 'Sent' : s === 'preparing' ? 'Preparing' : s === 'ready' ? 'Ready' : s === 'served' ? 'Served' : s;
  }

  modeLabel(m: string): string {
    return m === 'upi' ? 'UPI' : m === 'prepaid' ? 'prepaid' : m ? m.charAt(0).toUpperCase() + m.slice(1) : '';
  }

  money(n: number | undefined): string {
    return '₹' + Math.round(n ?? 0).toLocaleString('en-IN');
  }

  dateTime(iso?: string): string {
    if (!iso) return '—';
    return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }

  time(iso: string): string {
    return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }

  dayLabel(ymd: string): string {
    return new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
}
