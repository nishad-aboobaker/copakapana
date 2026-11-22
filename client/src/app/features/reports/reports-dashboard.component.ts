import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { IconComponent } from '../../shared/icon.component';
import { UiService } from '../../shared/ui.service';

type Tab = 'daily' | 'items' | 'payments' | 'order-types' | 'waiters' | 'kitchen' | 'eod';
type Preset = 'today' | 'yesterday' | '7days' | 'month' | 'custom';

const STATION_NAMES: Record<string, string> = { fried_chicken: 'Fried Chicken', juice: 'Juice Counter', main: 'Main Kitchen' };
const TYPE_NAMES: Record<string, string> = { dine_in: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' };

/** YYYY-MM-DD in Asia/Kolkata (report days follow the restaurant's timezone). */
const istDate = (d: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

@Component({
  selector: 'app-reports-dashboard',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet, IconComponent],
  template: `
    <div class="page">
      <header class="page-header no-print">
        <div>
          <h1 class="page-title">Reports</h1>
          <p class="page-subtitle">{{ rangeLabel() }}</p>
        </div>
        <div class="page-actions">
          @if (tab() !== 'eod') {
            <button class="btn" [disabled]="exporting()" (click)="exportActiveCsv()">
              @if (exporting()) { <span class="spinner"></span> } @else { <app-icon name="download" /> } Export CSV
            </button>
          } @else {
            <button class="btn btn-primary" (click)="print()"><app-icon name="printer" /> Print summary</button>
          }
        </div>
      </header>

      <!-- Range -->
      @if (tab() !== 'eod') {
        <div class="range card no-print">
          <div class="segmented">
            @for (p of presets; track p.key) {
              <button [class.active]="preset() === p.key" (click)="setPreset(p.key)">{{ p.label }}</button>
            }
          </div>
          <div class="dates">
            <input class="input" type="date" [max]="today" [(ngModel)]="fromDate" (change)="custom()" aria-label="From" />
            <app-icon name="arrow-right" [size]="16" class="text-subtle" />
            <input class="input" type="date" [max]="today" [min]="fromDate" [(ngModel)]="toDate" (change)="custom()" aria-label="To" />
          </div>
        </div>

        <!-- KPIs for the range -->
        <section class="grid-4 kpis no-print">
          <div class="stat"><span class="stat-label"><app-icon name="cash" /> Sales</span><span class="stat-value">₹{{ fmt(totals().revenue) }}</span><span class="stat-meta">{{ days() }} day{{ days() === 1 ? '' : 's' }}</span></div>
          <div class="stat"><span class="stat-label"><app-icon name="receipt" /> Bills</span><span class="stat-value">{{ totals().bills }}</span><span class="stat-meta">Paid</span></div>
          <div class="stat"><span class="stat-label"><app-icon name="chart" /> Average bill</span><span class="stat-value">₹{{ fmt(totals().avg) }}</span><span class="stat-meta">Per paid bill</span></div>
          <div class="stat"><span class="stat-label"><app-icon name="percent" /> Discounts</span><span class="stat-value">₹{{ fmt(totals().discount) }}</span><span class="stat-meta">Given</span></div>
        </section>
      }

      <div class="tabs no-print">
        @for (t of tabs; track t.key) {
          <button [class.active]="tab() === t.key" (click)="switchTab(t.key)"><app-icon [name]="t.icon" /> {{ t.label }}</button>
        }
      </div>

      <div class="panel">
        @if (loading()) {
          <div class="skeleton" style="height: 240px; border-radius: 12px"></div>
        } @else {
          @switch (tab()) {
            <!-- Sales by day -->
            @case ('daily') {
              @if (daily().length === 0) { <ng-container *ngTemplateOutlet="empty" /> } @else {
                <div class="card chart-card">
                  <div class="bars">
                    @for (r of daily(); track r.date) {
                      <div class="bar-col" [attr.title]="dayLabel(r.date) + ': ₹' + fmt(r.totalRevenue)">
                        <span class="bar-val num">₹{{ short(r.totalRevenue) }}</span>
                        <span class="bar" [style.height.%]="(r.totalRevenue / maxDaily()) * 100"></span>
                        <span class="bar-lbl">{{ dayShort(r.date) }}</span>
                      </div>
                    }
                  </div>
                </div>
                <div class="table-wrap">
                  <table class="table">
                    <thead><tr><th>Date</th><th class="text-right">Bills</th><th class="text-right">Average</th><th class="text-right">Discounts</th><th class="text-right">Sales</th></tr></thead>
                    <tbody>
                      @for (r of daily(); track r.date) {
                        <tr>
                          <td class="text-strong">{{ dayLabel(r.date) }}</td>
                          <td class="text-right num">{{ r.orderCount }}</td>
                          <td class="text-right num">₹{{ fmt(r.avgBill) }}</td>
                          <td class="text-right num">₹{{ fmt(r.totalDiscount) }}</td>
                          <td class="text-right num text-strong">₹{{ fmt(r.totalRevenue) }}</td>
                        </tr>
                      }
                    </tbody>
                    <tfoot><tr><td>Total</td><td class="text-right num">{{ totals().bills }}</td><td class="text-right num">₹{{ fmt(totals().avg) }}</td><td class="text-right num">₹{{ fmt(totals().discount) }}</td><td class="text-right num">₹{{ fmt(totals().revenue) }}</td></tr></tfoot>
                  </table>
                </div>
              }
            }

            <!-- Items -->
            @case ('items') {
              <div class="chips sub-filter">
                <button class="chip" [class.active]="station === 'all'" (click)="station = 'all'; load()">All stations</button>
                @for (s of stationKeys; track s) {
                  <button class="chip" [class.active]="station === s" (click)="station = s; load()">{{ stationNames[s] }}</button>
                }
              </div>
              @if (items().length === 0) { <ng-container *ngTemplateOutlet="empty" /> } @else {
                <div class="table-wrap">
                  <table class="table">
                    <thead><tr><th>#</th><th>Dish</th><th>Station</th><th class="text-right">Qty sold</th><th class="text-right">Sales</th><th class="share-col">Share</th></tr></thead>
                    <tbody>
                      @for (it of items(); track it.menuItemId ?? it.name; let i = $index) {
                        <tr>
                          <td class="text-muted num">{{ i + 1 }}</td>
                          <td class="text-strong">{{ it.name }}</td>
                          <td><span class="badge">{{ stationNames[it.station] || it.station }}</span></td>
                          <td class="text-right num">{{ it.totalQty }}</td>
                          <td class="text-right num text-strong">₹{{ fmt(it.totalRevenue) }}</td>
                          <td class="share-col"><span class="mini-bar"><span [style.width.%]="(it.totalRevenue / itemsMax()) * 100"></span></span></td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
            }

            <!-- Payments -->
            @case ('payments') {
              <div class="grid-3">
                <div class="stat pay cash"><span class="stat-label"><app-icon name="cash" /> Cash</span><span class="stat-value">₹{{ fmt(payments().cash) }}</span><span class="stat-meta">{{ pct(payments().cash) }}% of collections</span></div>
                <div class="stat pay upi"><span class="stat-label"><app-icon name="qr" /> UPI</span><span class="stat-value">₹{{ fmt(payments().upi) }}</span><span class="stat-meta">{{ pct(payments().upi) }}% of collections</span></div>
                <div class="stat"><span class="stat-label"><app-icon name="receipt" /> Total collected</span><span class="stat-value">₹{{ fmt(payments().total) }}</span><span class="stat-meta">Cash + UPI</span></div>
              </div>
              <div class="split-bar" aria-hidden="true">
                <span class="cash" [style.width.%]="pct(payments().cash)"></span>
                <span class="upi" [style.width.%]="pct(payments().upi)"></span>
              </div>
            }

            <!-- Order types -->
            @case ('order-types') {
              @if (types().length === 0) { <ng-container *ngTemplateOutlet="empty" /> } @else {
                <div class="grid-3">
                  @for (t of types(); track t.type) {
                    <div class="stat">
                      <span class="stat-label"><app-icon [name]="t.type === 'delivery' ? 'bike' : t.type === 'takeaway' ? 'bag' : 'table'" /> {{ typeNames[t.type] || t.type }}</span>
                      <span class="stat-value">₹{{ fmt(t.totalRevenue) }}</span>
                      <span class="stat-meta">{{ t.orderCount }} bills · {{ typeShare(t.totalRevenue) }}% of sales</span>
                    </div>
                  }
                </div>
              }
            }

            <!-- Staff -->
            @case ('waiters') {
              @if (waiters().length === 0) { <ng-container *ngTemplateOutlet="empty" /> } @else {
                <div class="table-wrap">
                  <table class="table">
                    <thead><tr><th>Waiter</th><th class="text-right">Bills</th><th class="text-right">Average</th><th class="text-right">Sales</th><th class="share-col">Share</th></tr></thead>
                    <tbody>
                      @for (w of waiters(); track w.name) {
                        <tr>
                          <td class="text-strong cap">{{ w.name }}</td>
                          <td class="text-right num">{{ w.orderCount }}</td>
                          <td class="text-right num">₹{{ fmt(w.orderCount ? Math.round(w.totalRevenue / w.orderCount) : 0) }}</td>
                          <td class="text-right num text-strong">₹{{ fmt(w.totalRevenue) }}</td>
                          <td class="share-col"><span class="mini-bar"><span [style.width.%]="(w.totalRevenue / waitersMax()) * 100"></span></span></td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
            }

            <!-- Kitchen -->
            @case ('kitchen') {
              @if (kitchen().length === 0) { <ng-container *ngTemplateOutlet="empty" /> } @else {
                <div class="grid-3">
                  @for (k of kitchen(); track k.station) {
                    <div class="stat">
                      <span class="stat-label"><app-icon name="monitor" /> {{ stationNames[k.station] || k.station }}</span>
                      <span class="stat-value">{{ k.avgPrepMinutes }}<small> min avg</small></span>
                      <span class="stat-meta">{{ k.ticketCount }} tickets · longest {{ k.maxPrepMinutes }} min · {{ k.editedCount }} edits</span>
                    </div>
                  }
                </div>
                <p class="text-muted text-sm note">Time from the order reaching the station screen to the cook tapping Ready.</p>
              }
            }

            <!-- End of day -->
            @case ('eod') {
              <div class="row no-print eod-pick">
                <label class="label" for="eod-date">Day</label>
                <input id="eod-date" class="input" type="date" [max]="today" [(ngModel)]="eodDate" (change)="load()" />
              </div>
              @if (eod(); as e) {
                <article class="card eod">
                  <header class="eod-head">
                    <h2>End of day summary</h2>
                    <span>{{ dayLabel(e.date) }}</span>
                  </header>
                  <div class="eod-grid">
                    <div><span>Sales</span><strong class="num">₹{{ fmt(e.summary.totalRevenue) }}</strong></div>
                    <div><span>Bills</span><strong class="num">{{ e.summary.orderCount || 0 }}</strong></div>
                    <div><span>Average bill</span><strong class="num">₹{{ fmt(e.summary.avgBill) }}</strong></div>
                    <div><span>Discounts</span><strong class="num">₹{{ fmt(e.summary.totalDiscount) }}</strong></div>
                  </div>
                  <div class="eod-cols">
                    <section>
                      <h4>Collections</h4>
                      <div class="eod-row"><span>Cash</span><span class="num">₹{{ fmt(e.payments?.cash) }}</span></div>
                      <div class="eod-row"><span>UPI</span><span class="num">₹{{ fmt(e.payments?.upi) }}</span></div>
                      <div class="eod-row total"><span>Total</span><span class="num">₹{{ fmt(e.payments?.total) }}</span></div>
                      <h4>Order types</h4>
                      @for (t of e.orderTypes; track t.type) {
                        <div class="eod-row"><span>{{ typeNames[t.type] || t.type }} ({{ t.orderCount }})</span><span class="num">₹{{ fmt(t.totalRevenue) }}</span></div>
                      } @empty { <p class="text-muted text-sm">None</p> }
                    </section>
                    <section>
                      <h4>Top dishes</h4>
                      @for (it of e.topItems; track it.name) {
                        <div class="eod-row"><span>{{ it.totalQty }} × {{ it.name }}</span><span class="num">₹{{ fmt(it.totalRevenue) }}</span></div>
                      } @empty { <p class="text-muted text-sm">None</p> }
                      <h4>Staff</h4>
                      @for (w of e.waiters; track w.name) {
                        <div class="eod-row"><span class="cap">{{ w.name }} ({{ w.orderCount }})</span><span class="num">₹{{ fmt(w.totalRevenue) }}</span></div>
                      } @empty { <p class="text-muted text-sm">None</p> }
                    </section>
                  </div>
                  <footer class="eod-foot">Printed {{ printedAt }} · Copakapana POS</footer>
                </article>
              }
            }
          }
        }
      </div>
    </div>

    <ng-template #empty>
      <div class="card">
        <div class="empty-state">
          <div class="empty-icon"><app-icon name="chart" /></div>
          <h3>No sales in this period</h3>
          <p>Reports count paid bills only. Try a wider date range.</p>
        </div>
      </div>
    </ng-template>
  `,
  styles: [
    `
      .range { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; padding: 0.6rem; margin-bottom: 1rem; }
      .dates { display: flex; align-items: center; gap: 0.5rem; }
      .dates .input { width: 160px; min-height: 38px; }
      .kpis { margin-bottom: 1.25rem; }
      .tabs { margin-bottom: 1rem; }
      .sub-filter { margin-bottom: 0.75rem; }
      .chart-card { padding: 1.25rem 1rem 0.75rem; margin-bottom: 1rem; }
      .bars { display: flex; align-items: flex-end; gap: 6px; height: 200px; overflow-x: auto; }
      .bar-col { flex: 1; min-width: 28px; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 4px; }
      .bar { width: 100%; max-width: 48px; min-height: 3px; border-radius: 6px 6px 2px 2px; background: var(--primary); opacity: 0.85; transition: height 0.4s var(--ease); }
      .bar-col:hover .bar { opacity: 1; }
      .bar-val { font-size: 0.65rem; color: var(--text-muted); font-weight: 600; white-space: nowrap; }
      .bar-lbl { font-size: 0.68rem; color: var(--text-muted); white-space: nowrap; }
      .share-col { width: 140px; }
      .mini-bar { display: block; height: 6px; background: var(--gray-100); border-radius: 3px; overflow: hidden; }
      .mini-bar span { display: block; height: 100%; background: var(--primary); border-radius: 3px; }
      .pay.cash .stat-value { color: #23705f; }
      .pay.upi .stat-value { color: #4b4bc4; }
      .split-bar { display: flex; height: 14px; border-radius: 7px; overflow: hidden; background: var(--gray-100); margin-top: 1rem; }
      .split-bar .cash { background: #2f7d6d; }
      .split-bar .upi { background: #5b5bd6; }
      .stat-value small { font-size: var(--fs-sm); font-weight: 600; color: var(--text-muted); }
      .note { margin-top: 0.75rem; }
      .cap { text-transform: capitalize; }
      .eod-pick { margin-bottom: 1rem; }
      .eod-pick .input { width: 180px; }
      .eod { max-width: 760px; padding: 2rem; }
      .eod-head { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid var(--gray-900); padding-bottom: 0.75rem; margin-bottom: 1.25rem; }
      .eod-head span { color: var(--text-muted); }
      .eod-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 1.5rem; }
      .eod-grid div { display: flex; flex-direction: column; }
      .eod-grid span { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); font-weight: 600; }
      .eod-grid strong { font-size: var(--fs-xl); color: var(--text-strong); }
      .eod-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; }
      .eod-cols h4 { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin: 1rem 0 0.4rem; }
      .eod-cols h4:first-child { margin-top: 0; }
      .eod-row { display: flex; justify-content: space-between; padding: 0.3rem 0; border-bottom: 1px dotted var(--gray-200); font-size: var(--fs-sm); }
      .eod-row.total { font-weight: 700; border-bottom: 0; }
      .eod-foot { margin-top: 1.5rem; font-size: var(--fs-xs); color: var(--text-subtle); text-align: center; }
      @media (max-width: 700px) { .eod-grid { grid-template-columns: 1fr 1fr; } .eod-cols { grid-template-columns: 1fr; } .share-col { display: none; } }
      @media print { .page { padding: 0; } .eod { border: 0; box-shadow: none; padding: 0; max-width: none; } }
    `,
  ],
})
export class ReportsDashboardComponent implements OnInit {
  private http = inject(HttpClient);
  private ui = inject(UiService);
  readonly Math = Math;

  readonly tabs: { key: Tab; label: string; icon: string }[] = [
    { key: 'daily', label: 'Sales', icon: 'chart' },
    { key: 'items', label: 'Dishes', icon: 'utensils' },
    { key: 'payments', label: 'Cash vs UPI', icon: 'cash' },
    { key: 'order-types', label: 'Order types', icon: 'layers' },
    { key: 'waiters', label: 'Staff', icon: 'users' },
    { key: 'kitchen', label: 'Kitchen times', icon: 'clock' },
    { key: 'eod', label: 'End of day', icon: 'file' },
  ];
  readonly presets: { key: Preset; label: string }[] = [
    { key: 'today', label: 'Today' },
    { key: 'yesterday', label: 'Yesterday' },
    { key: '7days', label: 'Last 7 days' },
    { key: 'month', label: 'This month' },
  ];
  readonly stationKeys = Object.keys(STATION_NAMES);
  readonly stationNames = STATION_NAMES;
  readonly typeNames = TYPE_NAMES;
  readonly today = istDate(new Date());
  readonly printedAt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date());

  readonly tab = signal<Tab>('daily');
  readonly preset = signal<Preset>('today');
  readonly loading = signal(false);
  readonly exporting = signal(false);
  readonly daily = signal<any[]>([]);
  readonly items = signal<any[]>([]);
  readonly payments = signal<{ cash: number; upi: number; total: number }>({ cash: 0, upi: 0, total: 0 });
  readonly types = signal<any[]>([]);
  readonly waiters = signal<any[]>([]);
  readonly kitchen = signal<any[]>([]);
  readonly eod = signal<any>(null);
  private readonly rangeTick = signal(0);

  fromDate = this.today;
  toDate = this.today;
  eodDate = this.today;
  station = 'all';

  readonly totals = computed(() => {
    const rows = this.daily();
    const revenue = rows.reduce((s, r) => s + (r.totalRevenue || 0), 0);
    const bills = rows.reduce((s, r) => s + (r.orderCount || 0), 0);
    const discount = rows.reduce((s, r) => s + (r.totalDiscount || 0), 0);
    return { revenue, bills, discount, avg: bills ? Math.round(revenue / bills) : 0 };
  });
  readonly maxDaily = computed(() => Math.max(1, ...this.daily().map((r) => r.totalRevenue)));
  readonly itemsMax = computed(() => Math.max(1, ...this.items().map((r) => r.totalRevenue)));
  readonly waitersMax = computed(() => Math.max(1, ...this.waiters().map((r) => r.totalRevenue)));
  readonly days = computed(() => {
    this.rangeTick();
    return Math.round((+new Date(this.toDate) - +new Date(this.fromDate)) / 86400000) + 1;
  });
  readonly rangeLabel = computed(() => {
    this.rangeTick();
    if (this.tab() === 'eod') return 'Printable summary for one day';
    const f = this.dayLabel(this.fromDate);
    return this.fromDate === this.toDate ? f : `${f} – ${this.dayLabel(this.toDate)}`;
  });

  ngOnInit(): void {
    this.loadSummary();
    this.load();
  }

  setPreset(p: Preset): void {
    const now = new Date();
    const shift = (days: number) => istDate(new Date(now.getTime() - days * 86400000));
    this.preset.set(p);
    if (p === 'today') [this.fromDate, this.toDate] = [this.today, this.today];
    if (p === 'yesterday') [this.fromDate, this.toDate] = [shift(1), shift(1)];
    if (p === '7days') [this.fromDate, this.toDate] = [shift(6), this.today];
    if (p === 'month') [this.fromDate, this.toDate] = [this.today.slice(0, 8) + '01', this.today];
    this.rangeChanged();
  }

  custom(): void {
    if (this.toDate < this.fromDate) this.toDate = this.fromDate;
    this.preset.set('custom');
    this.rangeChanged();
  }

  private rangeChanged(): void {
    this.rangeTick.update((t) => t + 1);
    this.loadSummary();
    if (this.tab() !== 'daily') this.load();
  }

  switchTab(t: Tab): void {
    this.tab.set(t);
    this.load();
  }

  private get range(): string {
    return `from=${this.fromDate}&to=${this.toDate}`;
  }

  /** Daily rows feed both the KPI strip and the Sales tab. */
  private loadSummary(): void {
    this.http.get<{ report: any[] }>(`${environment.apiUrl}/reports/daily?${this.range}`).subscribe({
      next: (res) => this.daily.set(res.report || []),
      error: (err) => this.ui.apiError(err, 'Could not load sales'),
    });
  }

  load(): void {
    const api = environment.apiUrl;
    const t = this.tab();
    if (t === 'daily') return;
    const fetch = (url: string, set: (r: any) => void) => {
      this.loading.set(true);
      this.http.get<any>(url).subscribe({
        next: (res) => {
          set(res);
          this.loading.set(false);
        },
        error: (err) => {
          this.loading.set(false);
          this.ui.apiError(err, 'Could not load the report');
        },
      });
    };
    if (t === 'items') fetch(`${api}/reports/items?${this.range}&station=${this.station}`, (r) => this.items.set(r.report || []));
    if (t === 'payments') fetch(`${api}/reports/payments?${this.range}`, (r) => this.payments.set(r.report || { cash: 0, upi: 0, total: 0 }));
    if (t === 'order-types') fetch(`${api}/reports/order-types?${this.range}`, (r) => this.types.set(r.report || []));
    if (t === 'waiters') fetch(`${api}/reports/waiters?${this.range}`, (r) => this.waiters.set(r.report || []));
    if (t === 'kitchen') fetch(`${api}/reports/kitchen?${this.range}`, (r) => this.kitchen.set(r.report || []));
    if (t === 'eod') fetch(`${api}/reports/eod?date=${this.eodDate}`, (r) => this.eod.set(r.eod || null));
  }

  // ─── Formatting ─────────────────────────────────────────────────────────
  fmt(n: number | undefined): string {
    return Math.round(n ?? 0).toLocaleString('en-IN');
  }

  short(n: number): string {
    return n >= 100000 ? (n / 100000).toFixed(1) + 'L' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n));
  }

  pct(n: number): number {
    const total = this.payments().total;
    return total ? Math.round((n / total) * 100) : 0;
  }

  typeShare(n: number): number {
    const total = this.types().reduce((s, t) => s + t.totalRevenue, 0);
    return total ? Math.round((n / total) * 100) : 0;
  }

  dayLabel(d: string): string {
    if (!d) return '';
    return new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(d + 'T12:00:00'));
  }

  dayShort(d: string): string {
    return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' }).format(new Date(d + 'T12:00:00'));
  }

  print(): void {
    window.print();
  }

  // ─── CSV (fetched with the auth token, then downloaded) ─────────────────
  exportActiveCsv(): void {
    const t = this.tab();
    const path: Record<string, string> = {
      daily: `/reports/daily?${this.range}`,
      items: `/reports/items?${this.range}&station=${this.station}`,
      payments: `/reports/payments?${this.range}`,
      'order-types': `/reports/order-types?${this.range}`,
      waiters: `/reports/waiters?${this.range}`,
      kitchen: `/reports/kitchen?${this.range}`,
    };
    if (!path[t]) return;
    this.exporting.set(true);
    this.http.get(`${environment.apiUrl}${path[t]}&format=csv`, { responseType: 'blob' }).subscribe({
      next: (blob) => {
        this.exporting.set(false);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${t}_${this.fromDate}_to_${this.toDate}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      error: async (err) => {
        this.exporting.set(false);
        let message = 'Export failed';
        try {
          if (err.error instanceof Blob) message = JSON.parse(await err.error.text()).message || message;
        } catch {
          /* non-JSON body */
        }
        this.ui.error(message);
      },
    });
  }
}
