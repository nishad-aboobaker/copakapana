import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { Subscription, forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/auth/auth.service';
import { SocketService } from '../../core/socket/socket.service';
import { IconComponent } from '../../shared/icon.component';

interface Eod {
  date: string;
  summary: { totalRevenue: number; orderCount: number; avgBill: number; totalDiscount?: number };
  payments: { cash: number; upi: number; total: number };
  orderTypes: { type: string; orderCount: number; totalRevenue: number }[];
  topItems: { name: string; station: string; totalQty: number; totalRevenue: number }[];
  waiters: { name: string; orderCount: number; totalRevenue: number }[];
}

const STATIONS = [
  { key: 'fried_chicken', label: 'Fried Chicken' },
  { key: 'juice', label: 'Juice Counter' },
  { key: 'main', label: 'Main Kitchen' },
];

/** Owner overview: today's numbers, live service status and first-run setup. */
@Component({
  selector: 'app-admin-dashboard',
  standalone: true,
  imports: [RouterLink, IconComponent],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1 class="page-title">{{ greeting }}, {{ name }}</h1>
          <p class="page-subtitle">{{ todayLabel }} · Today's business at a glance</p>
        </div>
        <div class="page-actions">
          <a class="btn" routerLink="/admin/reports"><app-icon name="chart" /> Reports</a>
          <a class="btn btn-primary" routerLink="/cashier/home"><app-icon name="receipt" /> Billing desk</a>
        </div>
      </header>

      <!-- First-run setup -->
      @if (setup().done < setup().steps.length) {
        <section class="card setup">
          <div class="card-header">
            <div>
              <h3>Finish setting up</h3>
              <p>{{ setup().done }} of {{ setup().steps.length }} done — complete these before the first service.</p>
            </div>
            <div class="progress"><span [style.width.%]="(setup().done / setup().steps.length) * 100"></span></div>
          </div>
          <div class="steps">
            @for (s of setup().steps; track s.label) {
              <a class="step" [class.done]="s.done" [routerLink]="s.link">
                <span class="step-check"><app-icon [name]="s.done ? 'check' : s.icon" [size]="16" /></span>
                <span class="step-text">
                  <strong>{{ s.label }}</strong>
                  <small>{{ s.hint }}</small>
                </span>
                <app-icon name="chevron-right" class="text-subtle" />
              </a>
            }
          </div>
        </section>
      }

      <!-- KPIs -->
      <section class="grid-4 kpis">
        <div class="stat">
          <span class="stat-label"><app-icon name="cash" /> Sales today</span>
          @if (loading()) { <span class="skeleton" style="height: 34px; width: 60%"></span> } @else {
            <span class="stat-value">₹{{ fmt(eod()?.summary?.totalRevenue) }}</span>
          }
          <span class="stat-meta">Paid bills, after discounts</span>
        </div>
        <div class="stat">
          <span class="stat-label"><app-icon name="receipt" /> Bills</span>
          @if (loading()) { <span class="skeleton" style="height: 34px; width: 40%"></span> } @else {
            <span class="stat-value">{{ eod()?.summary?.orderCount ?? 0 }}</span>
          }
          <span class="stat-meta">Closed today</span>
        </div>
        <div class="stat">
          <span class="stat-label"><app-icon name="chart" /> Average bill</span>
          @if (loading()) { <span class="skeleton" style="height: 34px; width: 50%"></span> } @else {
            <span class="stat-value">₹{{ fmt(eod()?.summary?.avgBill) }}</span>
          }
          <span class="stat-meta">Per paid bill</span>
        </div>
        <a class="stat stat-link" routerLink="/cashier/home">
          <span class="stat-label"><app-icon name="orders" /> Open orders</span>
          <span class="stat-value">{{ openOrders() }}</span>
          <span class="stat-meta">{{ billAsked() ? billAsked() + ' waiting for the bill' : 'On the floor right now' }}</span>
        </a>
      </section>

      <section class="grid-3 row-2">
        <!-- Payments -->
        <div class="card">
          <div class="card-header"><h3>Payments</h3><span class="text-muted text-sm num">₹{{ fmt(eod()?.payments?.total) }}</span></div>
          <div class="card-body stack">
            @for (p of paymentRows(); track p.label) {
              <div class="bar-row">
                <div class="bar-label"><span><i class="sw" [style.background]="p.color"></i>{{ p.label }}</span><strong class="num">₹{{ fmt(p.value) }}</strong></div>
                <div class="bar"><span [style.width.%]="p.pct" [style.background]="p.color"></span></div>
              </div>
            }
            @if (!eod()?.payments?.total) {
              <p class="text-muted text-sm">No payments yet today.</p>
            }
          </div>
        </div>

        <!-- Order types -->
        <div class="card">
          <div class="card-header"><h3>Order types</h3></div>
          <div class="card-body stack">
            @for (t of typeRows(); track t.label) {
              <div class="bar-row">
                <div class="bar-label"><span><app-icon [name]="t.icon" [size]="15" /> {{ t.label }}</span><span class="num"><strong>{{ t.count }}</strong> · ₹{{ fmt(t.revenue) }}</span></div>
                <div class="bar"><span [style.width.%]="t.pct"></span></div>
              </div>
            }
          </div>
        </div>

        <!-- Live service -->
        <div class="card">
          <div class="card-header"><h3>Kitchen &amp; printer</h3><span class="badge" [class.badge-success]="allOnline()" [class.badge-danger]="!allOnline()">{{ allOnline() ? 'All online' : 'Check devices' }}</span></div>
          <div class="card-body devices">
            @for (s of stations; track s.key) {
              <div class="device-row">
                <span class="dev-icon" [class.on]="stationOnline(s.key)"><app-icon name="monitor" [size]="16" /></span>
                <span class="dev-name">{{ s.label }} screen</span>
                <span class="dev-state" [class.on]="stationOnline(s.key)">{{ stationOnline(s.key) ? 'Online' : 'Offline' }}</span>
              </div>
            }
            <div class="device-row">
              <span class="dev-icon" [class.on]="agentOnline()"><app-icon name="printer" [size]="16" /></span>
              <span class="dev-name">Bill printer</span>
              <span class="dev-state" [class.on]="agentOnline()">{{ agentOnline() ? 'Online' : 'Offline' }}</span>
            </div>
          </div>
        </div>
      </section>

      <section class="grid-2">
        <div class="card">
          <div class="card-header"><h3>Top dishes today</h3><a routerLink="/admin/reports" class="text-sm">All items</a></div>
          @if (eod()?.topItems?.length) {
            <table class="table">
              <thead><tr><th>Dish</th><th class="text-right">Qty</th><th class="text-right">Sales</th></tr></thead>
              <tbody>
                @for (i of eod()!.topItems.slice(0, 6); track i.name; let idx = $index) {
                  <tr>
                    <td><span class="rank">{{ idx + 1 }}</span> <span class="text-strong">{{ i.name }}</span></td>
                    <td class="text-right num">{{ i.totalQty }}</td>
                    <td class="text-right num">₹{{ fmt(i.totalRevenue) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <div class="empty-state"><div class="empty-icon"><app-icon name="utensils" /></div><p>Best sellers appear once bills are paid.</p></div>
          }
        </div>

        <div class="card">
          <div class="card-header"><h3>Staff today</h3></div>
          @if (eod()?.waiters?.length) {
            <table class="table">
              <thead><tr><th>Waiter</th><th class="text-right">Bills</th><th class="text-right">Sales</th></tr></thead>
              <tbody>
                @for (w of eod()!.waiters; track w.name) {
                  <tr>
                    <td class="text-strong" style="text-transform: capitalize">{{ w.name }}</td>
                    <td class="text-right num">{{ w.orderCount }}</td>
                    <td class="text-right num">₹{{ fmt(w.totalRevenue) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <div class="empty-state"><div class="empty-icon"><app-icon name="users" /></div><p>Sales per waiter appear once bills are paid.</p></div>
          }
        </div>
      </section>
    </div>
  `,
  styles: [
    `
      .kpis, .row-2 { margin-bottom: 1rem; }
      .stat-link { text-decoration: none !important; color: inherit; transition: border-color 0.15s, box-shadow 0.15s; }
      .stat-link:hover { border-color: var(--border-strong); box-shadow: var(--shadow); }
      .setup { margin-bottom: 1rem; }
      .progress { width: 160px; height: 8px; border-radius: 4px; background: var(--gray-100); overflow: hidden; flex-shrink: 0; }
      .progress span { display: block; height: 100%; background: var(--primary); border-radius: 4px; transition: width 0.3s; }
      .steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
      .step { display: flex; align-items: center; gap: 0.75rem; padding: 0.9rem 1.25rem; border-top: 1px solid var(--gray-100); color: inherit; text-decoration: none !important; }
      .step:hover { background: var(--gray-25); }
      .step-check { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; background: var(--primary-soft); color: var(--primary); flex-shrink: 0; }
      .step.done .step-check { background: var(--success-soft); color: var(--success); }
      .step-text { flex: 1; display: flex; flex-direction: column; line-height: 1.3; min-width: 0; }
      .step-text strong { color: var(--text-strong); font-size: var(--fs-sm); }
      .step.done .step-text strong { color: var(--text-muted); text-decoration: line-through; }
      .step-text small { color: var(--text-muted); font-size: var(--fs-xs); }
      .bar-row { display: flex; flex-direction: column; gap: 0.35rem; }
      .bar-label { display: flex; justify-content: space-between; align-items: center; font-size: var(--fs-sm); }
      .bar-label span { display: inline-flex; align-items: center; gap: 0.4rem; }
      .sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
      .bar { height: 8px; background: var(--gray-100); border-radius: 4px; overflow: hidden; }
      .bar span { display: block; height: 100%; background: var(--primary); border-radius: 4px; transition: width 0.4s var(--ease); }
      .devices { display: flex; flex-direction: column; gap: 0.55rem; }
      .device-row { display: flex; align-items: center; gap: 0.65rem; font-size: var(--fs-sm); }
      .dev-icon { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; background: var(--danger-soft); color: var(--danger); }
      .dev-icon.on { background: var(--success-soft); color: var(--success); }
      .dev-name { flex: 1; color: var(--text-strong); font-weight: 500; }
      .dev-state { font-size: var(--fs-xs); font-weight: 700; color: var(--danger); }
      .dev-state.on { color: var(--success); }
      .rank { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; background: var(--gray-100); font-size: var(--fs-xs); font-weight: 700; color: var(--text-muted); margin-right: 0.35rem; }
      .card > .table { border-radius: 0 0 var(--radius) var(--radius); }
    `,
  ],
})
export class AdminDashboardComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private socket = inject(SocketService);
  private subs: Subscription[] = [];
  private api = environment.apiUrl;

  readonly stations = STATIONS;
  readonly name = this.auth.currentUser?.name ?? '';
  readonly loading = signal(true);
  readonly eod = signal<Eod | null>(null);
  readonly openOrders = signal(0);
  readonly billAsked = signal(0);
  readonly stationStatus = signal<Record<string, { online: boolean }>>({});
  readonly agentOnline = signal(false);
  readonly counts = signal({ tables: 0, items: 0, waiters: 0, cashiers: 0, screens: 0 });

  get greeting(): string {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  }

  readonly todayLabel = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' }).format(new Date());

  readonly setup = computed(() => {
    const c = this.counts();
    const steps = [
      { label: 'Add your tables', hint: `${c.tables} added · Ground & First floor`, done: c.tables > 0, link: '/admin/tables', icon: 'table' },
      { label: 'Build the menu', hint: `${c.items} dishes`, done: c.items > 0, link: '/admin/menu', icon: 'layers' },
      { label: 'Add waiters', hint: `${c.waiters} waiter accounts`, done: c.waiters > 0, link: '/admin/staff', icon: 'users' },
      { label: 'Connect kitchen screens', hint: `${c.screens} of 3 station screens`, done: c.screens >= 3, link: '/admin/staff', icon: 'monitor' },
      { label: 'Restaurant details & printer', hint: 'Bill header and printer IP', done: this.settingsDone(), link: '/admin/settings', icon: 'settings' },
    ];
    return { steps, done: steps.filter((s) => s.done).length };
  });
  private readonly settingsDone = signal(false);

  readonly paymentRows = computed(() => {
    const p = this.eod()?.payments ?? { cash: 0, upi: 0, total: 0 };
    const total = p.total || 1;
    return [
      { label: 'Cash', value: p.cash, pct: (p.cash / total) * 100, color: '#2f7d6d' },
      { label: 'UPI', value: p.upi, pct: (p.upi / total) * 100, color: '#5b5bd6' },
    ];
  });

  readonly typeRows = computed(() => {
    const list = this.eod()?.orderTypes ?? [];
    const max = Math.max(1, ...list.map((t) => t.orderCount));
    const meta = [
      { key: 'dine_in', label: 'Dine-in', icon: 'table' },
      { key: 'takeaway', label: 'Takeaway', icon: 'bag' },
      { key: 'delivery', label: 'Delivery', icon: 'bike' },
    ];
    return meta.map((m) => {
      const r = list.find((t) => t.type === m.key);
      return { ...m, count: r?.orderCount ?? 0, revenue: r?.totalRevenue ?? 0, pct: ((r?.orderCount ?? 0) / max) * 100 };
    });
  });

  readonly allOnline = computed(() => this.agentOnline() && STATIONS.every((s) => this.stationStatus()[s.key]?.online));

  ngOnInit(): void {
    this.load();
    this.subs.push(
      this.socket.fromEvent<any>('kds:status').subscribe((s) => this.stationStatus.set(s || {})),
      this.socket.fromEvent<any>('agent:status').subscribe((a) => this.agentOnline.set(!!a?.online)),
      this.socket.fromEvent<any>('order:updated').subscribe(() => this.loadOrders()),
      this.socket.fromEvent<any>('table:updated').subscribe(() => this.loadOrders()),
    );
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  stationOnline(key: string): boolean {
    return !!this.stationStatus()[key]?.online;
  }

  fmt(n: number | undefined): string {
    return (n ?? 0).toLocaleString('en-IN');
  }

  private load(): void {
    const safe = <T>(obs: any, fallback: T) => obs.pipe(catchError(() => of(fallback)));
    forkJoin({
      eod: safe(this.http.get<{ eod: Eod }>(`${this.api}/reports/eod`), { eod: null }),
      kds: safe(this.http.get<any>(`${this.api}/kds/status`), { stations: {} }),
      tables: safe(this.http.get<any>(`${this.api}/tables`), { tables: [] }),
      items: safe(this.http.get<any>(`${this.api}/items`), { items: [] }),
      users: safe(this.http.get<any>(`${this.api}/users`), { users: [] }),
      settings: safe(this.http.get<any>(`${this.api}/settings`), { settings: null }),
    }).subscribe((r: any) => {
      this.eod.set(r.eod?.eod ?? null);
      this.stationStatus.set(r.kds?.stations ?? {});
      const users: any[] = r.users?.users ?? [];
      const items = r.items?.items ?? r.items ?? [];
      this.counts.set({
        tables: (r.tables?.tables ?? []).length,
        items: Array.isArray(items) ? items.length : 0,
        waiters: users.filter((u) => u.role === 'waiter' && u.active).length,
        cashiers: users.filter((u) => u.role === 'cashier' && u.active).length,
        screens: new Set(users.filter((u) => u.role === 'kitchen' && u.active).map((u) => u.station)).size,
      });
      const s = r.settings?.settings;
      this.settingsDone.set(!!s && !!s.address && s.address !== '123 Main Street, City');
      this.loading.set(false);
    });
    this.loadOrders();
  }

  private loadOrders(): void {
    this.http.get<{ orders: any[] }>(`${this.api}/orders?status=open,billed`).subscribe({
      next: (res) => {
        const list = res.orders || [];
        this.openOrders.set(list.length);
        this.billAsked.set(list.filter((o) => o.status === 'billed' || o.tableId?.status === 'billing').length);
      },
      error: () => {},
    });
  }
}
