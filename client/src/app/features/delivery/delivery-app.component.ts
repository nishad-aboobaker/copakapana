import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/auth/auth.service';
import { SocketService } from '../../core/socket/socket.service';
import { IconComponent } from '../../shared/icon.component';
import { UiService } from '../../shared/ui.service';

type DeliveryStatus = 'waiting' | 'out' | 'delivered';
type CollectedMode = 'cash' | 'upi' | 'prepaid';

interface DeliveryOrder {
  _id: string;
  number: number;
  createdAt: string;
  status: 'open' | 'billed' | 'paid' | 'cancelled';
  customer: { name?: string; phone?: string; address?: string };
  items: { name: string; qty: number; portion?: string; note?: string }[];
  total: number;
  paid: boolean;
  amountDue: number;
  billNumber?: number;
  billed: boolean;
  kitchen: 'none' | 'cooking' | 'ready';
  delivery: {
    status: DeliveryStatus;
    outAt?: string;
    deliveredAt?: string;
    collectedMode?: CollectedMode;
    collectedAmount?: number;
  };
}

interface DeliveryList {
  active: DeliveryOrder[];
  done: DeliveryOrder[];
  totals: { delivered: number; cash: number; upi: number };
}

/** Delivery staff app: what to deliver, where, and what to collect. */
@Component({
  selector: 'app-delivery',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div class="app">
      <header class="top">
        <div class="who">
          <span class="avatar"><app-icon name="bike" [size]="20" /></span>
          <div>
            <strong>Deliveries</strong>
            <small>{{ userName }} · <span [class.live]="connected()" class="dot"></span>{{ connected() ? 'Live' : 'Reconnecting…' }}</small>
          </div>
        </div>
        <div class="top-actions">
          <button class="btn btn-ghost btn-icon" (click)="load()" aria-label="Refresh"><app-icon name="refresh" /></button>
          <button class="btn btn-ghost btn-icon" (click)="signOut()" aria-label="Sign out"><app-icon name="logout" /></button>
        </div>
      </header>

      <nav class="tabs-bar">
        <button [class.active]="tab() === 'todo'" (click)="tab.set('todo')">
          To deliver <span class="count">{{ data().active.length }}</span>
        </button>
        <button [class.active]="tab() === 'done'" (click)="tab.set('done')">
          Done today <span class="count">{{ data().done.length }}</span>
        </button>
      </nav>

      <main class="content">
        @if (loading() && !loaded()) {
          @for (i of [1, 2]; track i) { <div class="skeleton" style="height: 220px; border-radius: 16px"></div> }
        } @else if (error()) {
          <div class="empty-state">
            <div class="empty-icon"><app-icon name="wifi-off" /></div>
            <h3>Can't load deliveries</h3>
            <p>Check your internet connection.</p>
            <button class="btn btn-primary" (click)="load()"><app-icon name="refresh" /> Try again</button>
          </div>
        } @else if (tab() === 'todo') {
          @if (data().active.length === 0) {
            <div class="empty-state">
              <div class="empty-icon"><app-icon name="check-circle" /></div>
              <h3>No deliveries right now</h3>
              <p>New delivery orders appear here automatically.</p>
            </div>
          }
          @for (o of data().active; track o._id) {
            <article class="card order" [class.out]="o.delivery.status === 'out'">
              <div class="order-top">
                <span class="order-no">#{{ o.number }}</span>
                <span class="chip" [class]="'chip ' + o.delivery.status">{{ o.delivery.status === 'out' ? 'On the way' : 'To pick up' }}</span>
                @if (o.kitchen !== 'none' && o.delivery.status === 'waiting') {
                  <span class="chip" [class.ready]="o.kitchen === 'ready'" [class.cooking]="o.kitchen === 'cooking'">
                    {{ o.kitchen === 'ready' ? 'Food ready' : 'Cooking' }}
                  </span>
                }
                <span class="ago">{{ ago(o.delivery.outAt || o.createdAt) }}</span>
              </div>

              <h2 class="cust">{{ o.customer.name || 'Customer' }}</h2>
              @if (o.customer.address) { <p class="addr">{{ o.customer.address }}</p> }

              <div class="contact">
                @if (o.customer.phone) {
                  <a class="btn btn-lg" [href]="'tel:' + o.customer.phone"><app-icon name="phone" /> {{ o.customer.phone }}</a>
                }
                @if (o.customer.address) {
                  <a class="btn btn-lg" [href]="mapsUrl(o.customer.address)" target="_blank" rel="noopener"><app-icon name="pin" /> Map</a>
                }
              </div>

              <button class="items-toggle" (click)="toggleItems(o._id)" [attr.aria-expanded]="openItems().has(o._id)">
                <span>{{ itemCount(o) }} item{{ itemCount(o) === 1 ? '' : 's' }}</span>
                <app-icon name="chevron-down" [size]="16" [class.flip]="openItems().has(o._id)" />
              </button>
              @if (openItems().has(o._id)) {
                <ul class="items">
                  @for (i of o.items; track $index) {
                    <li><b>{{ i.qty }}×</b> {{ i.name }}{{ i.portion ? ' · ' + i.portion : '' }}</li>
                  }
                </ul>
              }

              <div class="money" [class.paid]="o.paid">
                @if (o.paid) {
                  <app-icon name="check-circle" /> <span>Paid · nothing to collect</span>
                } @else {
                  <span>Collect</span><strong>₹{{ o.amountDue }}</strong>
                }
              </div>
              @if (!o.billed && !o.paid) {
                <p class="warn"><app-icon name="info" [size]="14" /> Bill not made yet — ask the cashier for the delivery bill.</p>
              }

              <div class="actions">
                @if (o.delivery.status === 'waiting') {
                  <button class="btn btn-primary btn-xl btn-block" [disabled]="busyId() === o._id" (click)="markOut(o)">
                    <app-icon name="bike" /> Picked up · on the way
                  </button>
                } @else {
                  <button class="btn btn-success btn-xl btn-block" [disabled]="busyId() === o._id" (click)="openDelivered(o)">
                    <app-icon name="check" /> Delivered
                  </button>
                  <button class="btn btn-ghost btn-sm undo" [disabled]="busyId() === o._id" (click)="undo(o)">Not picked up yet</button>
                }
              </div>
            </article>
          }
        } @else {
          <div class="summary">
            <div class="sum"><span>Delivered</span><strong>{{ data().totals.delivered }}</strong></div>
            <div class="sum cash"><span>Cash to hand over</span><strong>₹{{ data().totals.cash }}</strong></div>
            <div class="sum"><span>UPI</span><strong>₹{{ data().totals.upi }}</strong></div>
          </div>
          @if (data().done.length === 0) {
            <div class="empty-state"><p>Nothing delivered yet today.</p></div>
          }
          @for (o of data().done; track o._id) {
            <article class="card done-row">
              <div class="done-main">
                <strong>#{{ o.number }} · {{ o.customer.name || 'Customer' }}</strong>
                <small>{{ time(o.delivery.deliveredAt) }}{{ o.customer.address ? ' · ' + o.customer.address : '' }}</small>
              </div>
              <div class="done-right">
                <span class="badge" [class.badge-success]="o.delivery.collectedMode !== 'cash'" [class.badge-warning]="o.delivery.collectedMode === 'cash'">
                  {{ collectedLabel(o) }}
                </span>
                @if (o.status !== 'paid' || o.delivery.collectedMode === 'prepaid') {
                  <button class="btn btn-ghost btn-sm" [disabled]="busyId() === o._id" (click)="undo(o)">Undo</button>
                } @else {
                  <small class="text-muted">Settled</small>
                }
              </div>
            </article>
          }
        }
      </main>

      @if (sheetOrder(); as o) {
        <div class="sheet-backdrop" (click)="closeSheet()">
          <div class="sheet" (click)="$event.stopPropagation()" role="dialog" aria-label="Mark delivered">
            <div class="sheet-handle"></div>
            <div class="sheet-body">
              <h3>Delivered #{{ o.number }} · {{ o.customer.name }}</h3>
              @if (o.paid) {
                <p class="text-muted">This order is already paid. Nothing to collect.</p>
              } @else {
                <p class="text-muted">How did the customer pay?</p>
                <div class="segmented full">
                  <button [class.active]="mode() === 'cash'" (click)="mode.set('cash')"><app-icon name="cash" /> Cash</button>
                  <button [class.active]="mode() === 'upi'" (click)="mode.set('upi')"><app-icon name="qr" /> UPI</button>
                </div>
                <label class="field">
                  <span class="label">Amount collected</span>
                  <div class="input-group">
                    <span class="input-prefix-text">₹</span>
                    <input class="input input-lg num" type="number" inputmode="numeric" min="0" [value]="amount()" (input)="amount.set(+$any($event.target).value)" />
                  </div>
                  @if (amount() > 0 && amount() !== o.amountDue) {
                    <small class="warn-text">The bill is ₹{{ o.amountDue }} — tell the cashier about the difference.</small>
                  }
                </label>
              }
              <button class="btn btn-success btn-xl btn-block" [disabled]="busyId() === o._id || (!o.paid && !(amount() > 0))" (click)="confirmDelivered(o)">
                <app-icon name="check" /> {{ o.paid ? 'Mark delivered' : 'Delivered · ₹' + (amount() || 0) + ' ' + (mode() === 'cash' ? 'cash' : 'UPI') }}
              </button>
              <button class="btn btn-ghost btn-block" (click)="closeSheet()">Cancel</button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host { display: block; min-height: 100vh; background: var(--bg, #f6f5f3); }
      .app { max-width: 640px; margin: 0 auto; min-height: 100vh; display: flex; flex-direction: column; }
      .top { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 1rem; background: var(--surface); border-bottom: 1px solid var(--border); }
      .who { display: flex; align-items: center; gap: 0.65rem; }
      .who strong { display: block; font-size: var(--fs-md); color: var(--text-strong); }
      .who small { color: var(--text-muted); font-size: var(--fs-xs); display: inline-flex; align-items: center; gap: 0.3rem; text-transform: capitalize; }
      .avatar { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: var(--primary); color: #fff; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--gray-400); display: inline-block; }
      .dot.live { background: var(--success); }
      .top-actions { display: flex; gap: 0.25rem; }
      .tabs-bar { display: grid; grid-template-columns: 1fr 1fr; gap: 0.35rem; padding: 0.6rem 1rem; background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 65px; z-index: 4; }
      .tabs-bar button { min-height: 44px; border: 0; border-radius: 12px; background: var(--gray-100); color: var(--text-muted); font-weight: 700; font-size: var(--fs-sm); display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; }
      .tabs-bar button.active { background: var(--gray-900); color: #fff; }
      .count { min-width: 22px; height: 22px; padding: 0 6px; border-radius: 11px; background: rgba(127, 127, 127, 0.25); display: inline-grid; place-items: center; font-size: 0.75rem; }
      .content { flex: 1; padding: 1rem; display: flex; flex-direction: column; gap: 0.9rem; padding-bottom: 2rem; }

      .order { padding: 1rem; border-radius: 16px; display: flex; flex-direction: column; gap: 0.6rem; }
      .order.out { border-color: var(--info); box-shadow: 0 0 0 2px var(--info-soft); }
      .order-top { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
      .order-no { font-weight: 800; color: var(--text-strong); }
      .ago { margin-left: auto; font-size: var(--fs-xs); color: var(--text-muted); }
      .chip { padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.72rem; font-weight: 700; background: var(--gray-100); color: var(--text-muted); }
      .chip.out { background: var(--info-soft); color: var(--info); }
      .chip.waiting { background: var(--warning-soft); color: var(--warning); }
      .chip.ready { background: var(--success-soft); color: var(--success); }
      .chip.cooking { background: var(--gray-100); color: var(--text-muted); }
      .cust { font-size: 1.35rem; line-height: 1.2; text-transform: capitalize; }
      .addr { color: var(--text); font-size: var(--fs-md); line-height: 1.35; margin: 0; }
      .contact { display: grid; grid-template-columns: 1fr auto; gap: 0.5rem; }
      .contact .btn { justify-content: center; font-variant-numeric: tabular-nums; }
      .items-toggle { display: flex; align-items: center; justify-content: space-between; border: 0; background: var(--gray-50, #f7f6f4); border-radius: 10px; padding: 0.55rem 0.75rem; font-weight: 600; color: var(--text); }
      .items-toggle .flip { transform: rotate(180deg); }
      .items { list-style: none; margin: 0; padding: 0 0.25rem; display: flex; flex-direction: column; gap: 0.25rem; font-size: var(--fs-sm); }
      .items b { color: var(--text-muted); font-weight: 600; margin-right: 0.25rem; }
      .money { display: flex; align-items: baseline; justify-content: space-between; padding: 0.7rem 0.85rem; border-radius: 12px; background: var(--warning-soft); color: var(--warning); font-weight: 700; }
      .money strong { font-size: 1.6rem; color: var(--text-strong); font-variant-numeric: tabular-nums; }
      .money.paid { background: var(--success-soft); color: var(--success); align-items: center; justify-content: flex-start; gap: 0.4rem; }
      .warn { display: flex; align-items: center; gap: 0.35rem; margin: 0; font-size: var(--fs-xs); color: var(--warning); }
      .actions { display: flex; flex-direction: column; gap: 0.35rem; }
      .undo { align-self: center; color: var(--text-muted); }

      .summary { display: grid; grid-template-columns: 1fr 1.3fr 1fr; gap: 0.5rem; }
      .sum { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 0.65rem 0.75rem; display: flex; flex-direction: column; gap: 0.15rem; }
      .sum span { font-size: 0.7rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; }
      .sum strong { font-size: 1.25rem; color: var(--text-strong); font-variant-numeric: tabular-nums; }
      .sum.cash { border-color: var(--warning); background: var(--warning-soft); }
      .done-row { display: flex; align-items: center; gap: 0.75rem; padding: 0.8rem 0.9rem; border-radius: 12px; }
      .done-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .done-main strong { text-transform: capitalize; color: var(--text-strong); }
      .done-main small { color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .done-right { display: flex; flex-direction: column; align-items: flex-end; gap: 0.2rem; }

      .sheet-body { padding: 0.5rem 1.25rem 1.25rem; display: flex; flex-direction: column; gap: 0.85rem; }
      .sheet-body h3 { text-transform: capitalize; }
      .sheet-body p { margin: 0; }
      .field { display: flex; flex-direction: column; gap: 0.35rem; }
      .warn-text { color: var(--warning); font-size: var(--fs-xs); font-weight: 600; }
    `,
  ],
})
export class DeliveryAppComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private socket = inject(SocketService);
  private ui = inject(UiService);

  readonly userName = this.auth.currentUser?.name ?? '';
  readonly data = signal<DeliveryList>({ active: [], done: [], totals: { delivered: 0, cash: 0, upi: 0 } });
  readonly loading = signal(false);
  readonly loaded = signal(false);
  readonly error = signal(false);
  readonly tab = signal<'todo' | 'done'>('todo');
  readonly connected = signal(this.socket.isConnected);
  readonly busyId = signal<string | null>(null);
  readonly openItems = signal<Set<string>>(new Set());

  readonly sheetOrder = signal<DeliveryOrder | null>(null);
  readonly mode = signal<'cash' | 'upi'>('cash');
  readonly amount = signal(0);

  readonly activeCount = computed(() => this.data().active.length);

  private subs: Subscription[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private knownIds = new Set<string>();
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') this.load();
  };

  ngOnInit(): void {
    this.load();
    this.subs.push(
      this.socket.connected$.subscribe((c) => this.connected.set(c)),
      this.socket.reconnect$.subscribe((n) => n > 0 && this.load()),
      this.socket.fromEvent<unknown>('delivery:changed').subscribe(() => this.load()),
    );
    this.timer = setInterval(() => this.load(), 60_000);
    document.addEventListener('visibilitychange', this.onVisible);
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
    clearInterval(this.timer);
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  load(): void {
    this.loading.set(true);
    this.http.get<DeliveryList>(`${environment.apiUrl}/delivery/orders`).subscribe({
      next: (d) => {
        // Buzz when a new delivery shows up (not on the first load)
        const fresh = d.active.filter((o) => !this.knownIds.has(o._id));
        if (this.loaded() && fresh.length) {
          navigator.vibrate?.([120, 60, 120]);
          this.ui.success(`${fresh.length} new deliver${fresh.length === 1 ? 'y' : 'ies'}`, 'New delivery');
        }
        d.active.forEach((o) => this.knownIds.add(o._id));
        this.data.set(d);
        this.loading.set(false);
        this.loaded.set(true);
        this.error.set(false);
      },
      error: () => {
        this.loading.set(false);
        if (!this.loaded()) this.error.set(true);
      },
    });
  }

  markOut(o: DeliveryOrder): void {
    this.post(o, 'out', {}, `#${o.number} — on the way`);
  }

  openDelivered(o: DeliveryOrder): void {
    this.mode.set('cash');
    this.amount.set(o.amountDue);
    this.sheetOrder.set(o);
  }

  closeSheet(): void {
    this.sheetOrder.set(null);
  }

  confirmDelivered(o: DeliveryOrder): void {
    const body = o.paid ? { mode: 'prepaid' } : { mode: this.mode(), amount: this.amount() };
    this.post(o, 'delivered', body, `#${o.number} delivered`, () => this.closeSheet());
  }

  async undo(o: DeliveryOrder): Promise<void> {
    const delivered = o.delivery.status === 'delivered';
    const ok = await this.ui.confirm({
      title: delivered ? `Undo delivery of #${o.number}?` : `Move #${o.number} back to "to pick up"?`,
      message: delivered ? 'It goes back to "on the way" and the amount you recorded is cleared.' : 'Use this if you tapped by mistake.',
      confirmText: 'Undo',
    });
    if (ok) this.post(o, 'undo', {}, 'Undone');
  }

  private post(o: DeliveryOrder, action: string, body: unknown, done: string, after?: () => void): void {
    this.busyId.set(o._id);
    this.http.post(`${environment.apiUrl}/delivery/orders/${o._id}/${action}`, body).subscribe({
      next: () => {
        this.busyId.set(null);
        this.ui.success(done);
        after?.();
        this.load();
      },
      error: (err) => {
        this.busyId.set(null);
        this.ui.apiError(err, 'Could not update the delivery');
        this.load();
      },
    });
  }

  async signOut(): Promise<void> {
    const ok = await this.ui.confirm({ title: 'Sign out?', confirmText: 'Sign out' });
    if (ok) this.auth.logout();
  }

  toggleItems(id: string): void {
    const s = new Set(this.openItems());
    if (s.has(id)) s.delete(id);
    else s.add(id);
    this.openItems.set(s);
  }

  itemCount(o: DeliveryOrder): number {
    return o.items.reduce((n, i) => n + i.qty, 0);
  }

  mapsUrl(address: string): string {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  }

  collectedLabel(o: DeliveryOrder): string {
    const m = o.delivery.collectedMode;
    if (m === 'prepaid') return 'Already paid';
    return `₹${o.delivery.collectedAmount ?? 0} ${m === 'upi' ? 'UPI' : 'cash'}`;
  }

  ago(iso?: string): string {
    if (!iso) return '';
    const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min`;
    return `${Math.floor(min / 60)} h ${min % 60} min`;
  }

  time(iso?: string): string {
    if (!iso) return '';
    return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }
}
