import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../../environments/environment';
import { IconComponent } from '../../shared/icon.component';

interface CustomerRow {
  _id: string;
  name: string;
  phone: string;
  orderCount: number;
  lastOrderAt?: string;
  createdAt: string;
  addressCount: number;
  totalSpent: number;
}

interface HistoryItem {
  name: string;
  qty: number;
  price: number;
  portion?: string;
  note?: string;
  cancelled: boolean;
}

interface HistoryOrder {
  _id: string;
  number: number;
  type: 'dine_in' | 'takeaway' | 'delivery';
  status: 'open' | 'billed' | 'paid' | 'cancelled';
  createdAt: string;
  waiterName: string;
  address: string;
  items: HistoryItem[];
  itemsTotal: number;
  bill: {
    number: number;
    status: 'open' | 'paid' | 'void';
    total: number;
    discountAmount: number;
    paidAt?: string;
    paymentModes: string[];
  } | null;
}

interface CustomerDetail {
  customer: {
    _id: string;
    name: string;
    phone: string;
    addresses: { label?: string; text: string; isDefault: boolean }[];
    orderCount: number;
    lastOrderAt?: string;
    createdAt: string;
  };
  summary: { totalSpent: number; paidOrders: number; averageBill: number; favourites: { name: string; qty: number }[] };
  orders: HistoryOrder[];
}

const PAGE_SIZE = 50;

@Component({
  selector: 'app-customers',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1 class="page-title">Customers</h1>
          <p class="page-subtitle">Takeaway and delivery customers, saved automatically from their orders.</p>
        </div>
      </header>

      <div class="layout" [class.has-detail]="selectedId()">
        <!-- List -->
        <section class="list-pane">
          <div class="input-group search">
            <app-icon name="search" />
            <input
              class="input"
              type="search"
              placeholder="Search name or phone"
              [value]="query()"
              (input)="onSearch($any($event.target).value)"
              aria-label="Search customers"
            />
          </div>
          <p class="count text-muted text-sm">
            @if (!loading()) {
              {{ total() }} customer{{ total() === 1 ? '' : 's' }}{{ query() ? ' found' : '' }}
            }
          </p>

          @if (loading() && customers().length === 0) {
            <div class="skeleton" style="height: 260px; border-radius: 12px"></div>
          } @else if (customers().length === 0) {
            <div class="card">
              <div class="empty-state">
                <div class="empty-icon"><app-icon name="user" /></div>
                <h3>{{ query() ? 'No one matches' : 'No customers yet' }}</h3>
                <p>{{ query() ? 'Try part of the name or the last few digits of the phone number.' : 'Customers appear here after their first takeaway or delivery order.' }}</p>
              </div>
            </div>
          } @else {
            <ul class="customer-list card" role="list">
              @for (c of customers(); track c._id) {
                <li>
                  <button class="customer-row" [class.active]="c._id === selectedId()" (click)="select(c._id)">
                    <span class="avatar" [style.background]="color(c.name)">{{ initials(c.name) }}</span>
                    <span class="who">
                      <span class="name">{{ c.name }}</span>
                      <span class="phone">{{ formatPhone(c.phone) }}</span>
                    </span>
                    <span class="meta">
                      <span class="spent">{{ money(c.totalSpent) }}</span>
                      <span class="text-muted">{{ c.orderCount }} order{{ c.orderCount === 1 ? '' : 's' }} · {{ relative(c.lastOrderAt) }}</span>
                    </span>
                    <app-icon name="chevron-right" class="chev" />
                  </button>
                </li>
              }
            </ul>
            @if (customers().length < total()) {
              <button class="btn btn-block more" [disabled]="loading()" (click)="loadMore()">
                {{ loading() ? 'Loading…' : 'Show more' }}
              </button>
            }
          }
        </section>

        <!-- Detail -->
        <section class="detail-pane">
          @if (!selectedId()) {
            <div class="card placeholder">
              <div class="empty-state">
                <div class="empty-icon"><app-icon name="history" /></div>
                <h3>Select a customer</h3>
                <p>See their contact details, addresses and every past order.</p>
              </div>
            </div>
          } @else if (detailLoading() && !detail()) {
            <div class="skeleton" style="height: 420px; border-radius: 12px"></div>
          } @else if (detailError()) {
            <div class="card"><div class="empty-state"><h3>{{ detailError() }}</h3>
              <button class="btn" (click)="select(selectedId()!)">Try again</button></div></div>
          } @else if (detail(); as d) {
            <button class="btn btn-ghost back" (click)="clearSelection()"><app-icon name="arrow-left" /> All customers</button>

            <div class="card profile">
              <span class="avatar lg" [style.background]="color(d.customer.name)">{{ initials(d.customer.name) }}</span>
              <div class="profile-text">
                <h2>{{ d.customer.name }}</h2>
                <a class="phone-link" [href]="'tel:' + d.customer.phone"><app-icon name="phone" /> {{ formatPhone(d.customer.phone) }}</a>
                <span class="text-muted text-sm">Customer since {{ date(d.customer.createdAt) }}</span>
              </div>
            </div>

            <div class="stats">
              <div class="stat"><span class="stat-label">Total spent</span><span class="stat-value">{{ money(d.summary.totalSpent) }}</span><span class="stat-meta">{{ d.summary.paidOrders }} paid order{{ d.summary.paidOrders === 1 ? '' : 's' }}</span></div>
              <div class="stat"><span class="stat-label">Average bill</span><span class="stat-value">{{ money(d.summary.averageBill) }}</span><span class="stat-meta">per paid order</span></div>
              <div class="stat"><span class="stat-label">Last order</span><span class="stat-value small">{{ relative(d.customer.lastOrderAt) }}</span><span class="stat-meta">{{ d.customer.lastOrderAt ? dateTime(d.customer.lastOrderAt) : '' }}</span></div>
            </div>

            @if (d.summary.favourites.length || d.customer.addresses.length) {
              <div class="two-col">
                @if (d.summary.favourites.length) {
                  <div class="card">
                    <div class="card-header"><h3>Usually orders</h3></div>
                    <div class="card-body favs">
                      @for (f of d.summary.favourites; track f.name) {
                        <span class="fav">{{ f.name }} <b>×{{ f.qty }}</b></span>
                      }
                    </div>
                  </div>
                }
                @if (d.customer.addresses.length) {
                  <div class="card">
                    <div class="card-header"><h3>Addresses</h3></div>
                    <ul class="card-body addresses">
                      @for (a of d.customer.addresses; track a.text) {
                        <li><app-icon name="pin" /> <span>{{ a.text }}</span> @if (a.isDefault) { <span class="badge">Default</span> }</li>
                      }
                    </ul>
                  </div>
                }
              </div>
            }

            <div class="card">
              <div class="card-header"><h3>Order history</h3><span class="text-muted text-sm">{{ d.orders.length }} order{{ d.orders.length === 1 ? '' : 's' }}</span></div>
              @if (d.orders.length === 0) {
                <div class="empty-state"><p>No orders recorded yet.</p></div>
              } @else {
                <ul class="orders" role="list">
                  @for (o of d.orders; track o._id) {
                    <li class="order" [class.open]="expanded().has(o._id)">
                      <button class="order-head" (click)="toggle(o._id)" [attr.aria-expanded]="expanded().has(o._id)">
                        <span class="type-icon" [class]="'type-icon ' + o.type"><app-icon [name]="typeIcon(o.type)" /></span>
                        <span class="order-main">
                          <span class="order-title">Order #{{ o.number }} <span class="text-muted">· {{ typeLabel(o.type) }}</span></span>
                          <span class="text-muted text-sm">{{ dateTime(o.createdAt) }} · {{ itemCount(o) }} item{{ itemCount(o) === 1 ? '' : 's' }}</span>
                        </span>
                        <span class="order-right">
                          <span class="amount">{{ money(o.bill?.total ?? o.itemsTotal) }}</span>
                          <span class="badge" [class]="'badge ' + statusClass(o)">{{ statusLabel(o) }}</span>
                        </span>
                        <app-icon name="chevron-down" class="chev" />
                      </button>
                      @if (expanded().has(o._id)) {
                        <div class="order-body">
                          <table class="items">
                            <tbody>
                              @for (i of o.items; track $index) {
                                <tr [class.cancelled]="i.cancelled">
                                  <td class="qty">{{ i.qty }}×</td>
                                  <td>
                                    {{ i.name }}@if (i.portion) { <span class="text-muted"> · {{ i.portion }}</span> }
                                    @if (i.note) { <div class="note">{{ i.note }}</div> }
                                    @if (i.cancelled) { <span class="badge badge-danger">Cancelled</span> }
                                  </td>
                                  <td class="text-right">{{ money(i.price * i.qty) }}</td>
                                </tr>
                              }
                            </tbody>
                          </table>
                          <div class="order-foot text-sm">
                            @if (o.bill) {
                              <span>Bill #{{ o.bill.number }}</span>
                              @if (o.bill.discountAmount) { <span>Discount {{ money(o.bill.discountAmount) }}</span> }
                              @if (o.bill.paymentModes.length) { <span>Paid by {{ modes(o.bill.paymentModes) }}</span> }
                            }
                            @if (o.waiterName) { <span>Taken by {{ o.waiterName }}</span> }
                            @if (o.address) { <span class="addr"><app-icon name="pin" /> {{ o.address }}</span> }
                          </div>
                        </div>
                      }
                    </li>
                  }
                </ul>
              }
            </div>
          }
        </section>
      </div>
    </div>
  `,
  styles: [
    `
      .layout { display: grid; grid-template-columns: minmax(300px, 400px) 1fr; gap: 1.25rem; align-items: start; }
      .list-pane { display: flex; flex-direction: column; gap: 0.6rem; position: sticky; top: 1rem; }
      .search { width: 100%; }
      .count { min-height: 1.2em; }
      .customer-list { list-style: none; margin: 0; padding: 0.35rem; max-height: calc(100vh - 14rem); overflow-y: auto; }
      .customer-row { width: 100%; display: flex; align-items: center; gap: 0.7rem; padding: 0.65rem 0.6rem; border: 0; background: none; border-radius: var(--radius-sm, 8px); text-align: left; cursor: pointer; color: inherit; }
      .customer-row:hover { background: var(--gray-50, #f7f6f4); }
      .customer-row.active { background: var(--primary-soft); }
      .who { display: flex; flex-direction: column; min-width: 0; flex: 1; }
      .name { font-weight: 650; color: var(--text-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-transform: capitalize; }
      .phone { font-size: var(--fs-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }
      .meta { display: flex; flex-direction: column; align-items: flex-end; font-size: var(--fs-xs); white-space: nowrap; }
      .spent { font-weight: 700; font-size: var(--fs-sm); color: var(--text-strong); font-variant-numeric: tabular-nums; }
      .chev { color: var(--text-subtle); display: inline-flex; }
      .more { margin-top: 0.25rem; }
      .avatar { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-size: 0.8rem; font-weight: 700; flex-shrink: 0; }
      .avatar.lg { width: 56px; height: 56px; font-size: 1.15rem; }

      .detail-pane { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
      .placeholder { min-height: 320px; display: grid; place-items: center; }
      .back { display: none; align-self: flex-start; }
      .profile { display: flex; align-items: center; gap: 1rem; padding: 1.15rem 1.25rem; }
      .profile-text { display: flex; flex-direction: column; gap: 0.2rem; }
      .profile h2 { font-size: var(--fs-lg); text-transform: capitalize; }
      .phone-link { display: inline-flex; align-items: center; gap: 0.35rem; color: var(--primary); font-weight: 600; text-decoration: none; font-variant-numeric: tabular-nums; }
      .phone-link app-icon { display: inline-flex; }
      .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.75rem; }
      .stat-value.small { font-size: var(--fs-lg); }
      .two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; }
      .favs { display: flex; flex-wrap: wrap; gap: 0.4rem; }
      .fav { padding: 0.3rem 0.65rem; border-radius: var(--radius-full); background: var(--gray-100); font-size: var(--fs-sm); }
      .fav b { color: var(--text-muted); font-weight: 600; }
      .addresses { list-style: none; margin: 0; display: flex; flex-direction: column; gap: 0.55rem; font-size: var(--fs-sm); }
      .addresses li { display: flex; align-items: flex-start; gap: 0.45rem; }
      .addresses app-icon { color: var(--text-subtle); display: inline-flex; margin-top: 0.1rem; }

      .orders { list-style: none; margin: 0; padding: 0; }
      .order + .order { border-top: 1px solid var(--border); }
      .order-head { width: 100%; display: flex; align-items: center; gap: 0.75rem; padding: 0.85rem 1.25rem; border: 0; background: none; text-align: left; cursor: pointer; color: inherit; }
      .order-head:hover { background: var(--gray-50, #f7f6f4); }
      .order.open .order-head .chev { transform: rotate(180deg); }
      .type-icon { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: var(--gray-100); color: var(--text-muted); flex-shrink: 0; }
      .type-icon.delivery { background: var(--info-soft); color: var(--info); }
      .type-icon.takeaway { background: var(--warning-soft); color: var(--warning); }
      .order-main { display: flex; flex-direction: column; flex: 1; min-width: 0; }
      .order-title { font-weight: 650; color: var(--text-strong); }
      .order-right { display: flex; flex-direction: column; align-items: flex-end; gap: 0.2rem; }
      .amount { font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text-strong); }
      .order-body { padding: 0 1.25rem 1rem 4.1rem; }
      .items { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
      .items td { padding: 0.3rem 0; vertical-align: top; }
      .items .qty { width: 2.5rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
      .items td.text-right { font-variant-numeric: tabular-nums; white-space: nowrap; }
      .items tr.cancelled td { color: var(--text-subtle); text-decoration: line-through; }
      .items tr.cancelled .badge { text-decoration: none; margin-left: 0.35rem; }
      .note { font-size: var(--fs-xs); color: var(--text-muted); font-style: italic; }
      .order-foot { display: flex; flex-wrap: wrap; gap: 0.35rem 1rem; margin-top: 0.6rem; padding-top: 0.6rem; border-top: 1px dashed var(--border); color: var(--text-muted); }
      .addr { display: inline-flex; align-items: center; gap: 0.3rem; }
      .addr app-icon { display: inline-flex; }

      @media (max-width: 900px) {
        .layout { grid-template-columns: 1fr; }
        .list-pane { position: static; }
        .customer-list { max-height: none; }
        .layout.has-detail .list-pane { display: none; }
        .layout:not(.has-detail) .detail-pane { display: none; }
        .back { display: inline-flex; }
      }
      @media (max-width: 560px) {
        .stats { grid-template-columns: 1fr 1fr; }
        .stats .stat:last-child { grid-column: span 2; }
        .order-head { padding: 0.8rem 1rem; }
        .order-body { padding: 0 1rem 1rem; }
      }
    `,
  ],
})
export class CustomersComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);

  customers = signal<CustomerRow[]>([]);
  total = signal(0);
  query = signal('');
  loading = signal(false);
  private page = 1;

  selectedId = signal<string | null>(null);
  detail = signal<CustomerDetail | null>(null);
  detailLoading = signal(false);
  detailError = signal('');
  expanded = signal<Set<string>>(new Set());

  hasMore = computed(() => this.customers().length < this.total());

  private searchTimer?: ReturnType<typeof setTimeout>;
  private listSub?: Subscription;
  private detailSub?: Subscription;

  ngOnInit(): void {
    this.load(true);
  }

  ngOnDestroy(): void {
    clearTimeout(this.searchTimer);
    this.listSub?.unsubscribe();
    this.detailSub?.unsubscribe();
  }

  onSearch(value: string): void {
    this.query.set(value);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.load(true), 250);
  }

  loadMore(): void {
    this.page += 1;
    this.load(false);
  }

  private load(reset: boolean): void {
    if (reset) this.page = 1;
    this.loading.set(true);
    this.listSub?.unsubscribe();
    const params = { q: this.query().trim(), page: String(this.page), limit: String(PAGE_SIZE) };
    this.listSub = this.http
      .get<{ total: number; customers: CustomerRow[] }>(`${environment.apiUrl}/customers`, { params })
      .subscribe({
        next: (res) => {
          this.total.set(res.total);
          this.customers.set(reset ? res.customers : [...this.customers(), ...res.customers]);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  select(id: string): void {
    this.selectedId.set(id);
    this.detailError.set('');
    if (this.detail()?.customer._id !== id) this.detail.set(null);
    this.detailLoading.set(true);
    this.detailSub?.unsubscribe();
    this.detailSub = this.http.get<CustomerDetail>(`${environment.apiUrl}/customers/${id}`).subscribe({
      next: (d) => {
        this.detail.set(d);
        // Open the latest order so the history is visible straight away
        this.expanded.set(new Set(d.orders.length ? [d.orders[0]._id] : []));
        this.detailLoading.set(false);
      },
      error: (err) => {
        this.detailError.set(err.status === 404 ? 'Customer not found' : 'Could not load this customer');
        this.detailLoading.set(false);
      },
    });
  }

  clearSelection(): void {
    this.selectedId.set(null);
    this.detail.set(null);
  }

  toggle(id: string): void {
    const next = new Set(this.expanded());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expanded.set(next);
  }

  itemCount(o: HistoryOrder): number {
    return o.items.filter((i) => !i.cancelled).reduce((n, i) => n + i.qty, 0);
  }

  typeLabel(t: HistoryOrder['type']): string {
    return t === 'dine_in' ? 'Dine-in' : t === 'takeaway' ? 'Takeaway' : 'Delivery';
  }

  typeIcon(t: HistoryOrder['type']): string {
    return t === 'delivery' ? 'bike' : t === 'takeaway' ? 'bag' : 'utensils';
  }

  statusLabel(o: HistoryOrder): string {
    if (o.status === 'cancelled') return 'Cancelled';
    if (o.bill?.status === 'void') return 'Void';
    if (o.bill?.status === 'paid' || o.status === 'paid') return 'Paid';
    if (o.status === 'billed') return 'Billed';
    return 'Open';
  }

  statusClass(o: HistoryOrder): string {
    const s = this.statusLabel(o);
    return s === 'Paid' ? 'badge-success' : s === 'Cancelled' || s === 'Void' ? 'badge-danger' : 'badge-warning';
  }

  modes(m: string[]): string {
    return m.map((x) => (x === 'upi' ? 'UPI' : x.charAt(0).toUpperCase() + x.slice(1))).join(' + ');
  }

  money(n: number | undefined): string {
    return '₹' + Math.round(n ?? 0).toLocaleString('en-IN');
  }

  formatPhone(p: string): string {
    const d = (p || '').replace(/\D/g, '');
    return d.length === 10 ? `${d.slice(0, 5)} ${d.slice(5)}` : p;
  }

  date(iso?: string): string {
    if (!iso) return '—';
    return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  }

  dateTime(iso?: string): string {
    if (!iso) return '—';
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  }

  relative(iso?: string): string {
    if (!iso) return 'never';
    const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
    const days = Math.round((Date.parse(day(new Date())) - Date.parse(day(new Date(iso)))) / 86_400_000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    if (days < 365) return `${Math.round(days / 30)} mo ago`;
    return `${Math.round(days / 365)} yr ago`;
  }

  initials(name: string): string {
    return (name || '?').trim().split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  }

  color(name: string): string {
    const palette = ['#e4572e', '#2f7d6d', '#5b5bd6', '#c2780a', '#b4417a', '#3f7cc4', '#7a5c3e', '#4f8a3a'];
    let h = 0;
    for (const c of name || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return palette[h % palette.length];
  }
}
