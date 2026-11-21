import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService, STATION_LABELS, Station } from '../../core/auth/auth.service';
import { SocketService } from '../../core/socket/socket.service';
import { environment } from '../../../environments/environment';
import { IconComponent } from '../../shared/icon.component';
import { UiService } from '../../shared/ui.service';

type KotStatus = 'new' | 'preparing' | 'ready' | 'served';

interface KotItem {
  name: string;
  qty: number;
  portion?: string;
  note?: string;
}

interface Kot {
  _id: string;
  number: number;
  station: Station;
  orderId: string;
  context: {
    orderNumber: number;
    orderType: 'dine_in' | 'takeaway' | 'delivery';
    tableLabel?: string;
    floor?: string;
    waiterName?: string;
    customerName?: string;
    customerPhone?: string;
  };
  items: KotItem[];
  isEdited: boolean;
  againstKotNumber?: number;
  addedItems: KotItem[];
  cancelledItems: KotItem[];
  status: KotStatus;
  createdAt: string;
  servedAt?: string;
  resendCount?: number;
  lastResentAt?: string;
  resent?: boolean;
}

interface KdsSettings {
  kdsWarnMinutes: number;
  kdsLateMinutes: number;
  kdsSoundEnabled: boolean;
}

/**
 * Kitchen station screen (KDS). Replaces the station KOT printer.
 * Shows this station's open KOTs in three lanes: New → Preparing → Ready.
 */
@Component({
  selector: 'app-kds-screen',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div class="kds" [class.flash]="flashing()">
      <header class="bar">
        <div class="title">
          <span class="station">{{ stationLabel }}</span>
          <span class="counts">
            {{ lanes().new.length }} new · {{ lanes().preparing.length }} preparing · {{ lanes().ready.length }} ready
          </span>
        </div>
        <div class="right">
          <span class="clock">{{ clock() }}</span>
          <span class="conn" [class.ok]="connected()"><i></i>{{ connected() ? 'Live' : 'Offline' }}</span>
          <button class="ghost" (click)="openStock()" [class.has-out]="outCount() > 0">
            <app-icon name="package" [size]="18" /> Stock
            @if (outCount()) { <span class="out-pill">{{ outCount() }} out</span> }
          </button>
          <button class="ghost" (click)="showRecall.set(!showRecall())"><app-icon name="undo" [size]="18" /> Recall ({{ recentlyServed().length }})</button>
          <button class="ghost icon" (click)="toggleMute()" [attr.aria-label]="muted() ? 'Unmute' : 'Mute'">
            <app-icon [name]="settings().kdsSoundEnabled && !muted() ? 'volume' : 'volume-off'" [size]="20" />
          </button>
          <button class="ghost icon" (click)="logout()" aria-label="Sign out"><app-icon name="logout" [size]="20" /></button>
        </div>
      </header>

      @if (!connected()) {
        <div class="offline">Connection lost — reconnecting. New KOTs will appear automatically when the connection returns.</div>
      }

      @if (showRecall()) {
        <div class="recall">
          <strong>Cleared in the last 5 minutes</strong>
          @if (recentlyServed().length === 0) {
            <span class="muted">Nothing to recall</span>
          }
          @for (k of recentlyServed(); track k._id) {
            <button class="recall-btn" (click)="recall(k)">
              #{{ k.number }} · {{ header(k) }} · {{ k.items.length || k.addedItems.length }} item(s) — Recall
            </button>
          }
        </div>
      }

      <main class="lanes">
        @for (lane of laneDefs; track lane.key) {
          <section class="lane">
            <h2 [class]="'lane-h ' + lane.key">{{ lane.title }} <span>{{ lanes()[lane.key].length }}</span></h2>
            <div class="cards">
              @for (k of lanes()[lane.key]; track k._id) {
                <article class="card" [class]="'card ' + timerClass(k)" [class.edited]="k.isEdited" [class.fresh]="isFresh(k)">
                  @if (k.isEdited) {
                    <div class="edited-banner">EDITED{{ k.againstKotNumber ? ' · vs #' + k.againstKotNumber : '' }}</div>
                  }
                  @if (k.resent || k.resendCount) {
                    <div class="resent">RESENT {{ k.lastResentAt ? time(k.lastResentAt) : '' }}</div>
                  }
                  <div class="card-h">
                    <span class="num">#{{ k.number }}</span>
                    <span class="type">{{ header(k) }}</span>
                  </div>
                  <div class="card-sub">
                    <span>{{ k.context.waiterName || '' }}</span>
                    <span class="timer"><app-icon name="clock" [size]="15" /> {{ elapsed(k) }}</span>
                  </div>
                  @if (k.context.orderType === 'delivery' && k.context.customerPhone) {
                    <div class="card-sub"><span class="ph"><app-icon name="phone" [size]="14" /> {{ k.context.customerPhone }}</span></div>
                  }

                  <div class="items">
                    @if (k.isEdited) {
                      @if (k.addedItems.length) {
                        <div class="sec add">ADD</div>
                        @for (i of k.addedItems; track $index) {
                          <div class="item">
                            <b>{{ i.qty }} ×</b> {{ i.name }}{{ i.portion ? ' (' + i.portion + ')' : '' }}
                            @if (i.note) { <div class="note">note: {{ i.note }}</div> }
                          </div>
                        }
                      }
                      @if (k.cancelledItems.length) {
                        <div class="sec cancel">CANCEL</div>
                        @for (i of k.cancelledItems; track $index) {
                          <div class="item cancelled">
                            <b>{{ i.qty }} ×</b> {{ i.name }}{{ i.portion ? ' (' + i.portion + ')' : '' }}
                          </div>
                        }
                      }
                    } @else {
                      @for (i of k.items; track $index) {
                        <div class="item">
                          <b>{{ i.qty }} ×</b> {{ i.name }}{{ i.portion ? ' (' + i.portion + ')' : '' }}
                          @if (i.note) { <div class="note">note: {{ i.note }}</div> }
                        </div>
                      }
                    }
                  </div>

                  <div class="card-f">
                    <span class="order">Order #{{ k.context.orderNumber }}</span>
                    <div class="actions">
                      @if (k.status === 'preparing') {
                        <button class="back" [disabled]="busy().has(k._id)" (click)="move(k, 'new')" aria-label="Back to new"><app-icon name="undo" [size]="20" /></button>
                      }
                      @if (k.status === 'ready') {
                        <button class="back" [disabled]="busy().has(k._id)" (click)="move(k, 'preparing')" aria-label="Back to preparing"><app-icon name="undo" [size]="20" /></button>
                      }
                      @if (k.status === 'new') {
                        <button class="go start" [disabled]="busy().has(k._id)" (click)="move(k, 'preparing')"><app-icon name="play" [size]="18" /> START</button>
                      }
                      @if (k.status === 'preparing') {
                        <button class="go ready" [disabled]="busy().has(k._id)" (click)="move(k, 'ready')"><app-icon name="check" [size]="18" /> READY</button>
                      }
                      @if (k.status === 'ready') {
                        <button class="go clear" [disabled]="busy().has(k._id)" (click)="move(k, 'served')">CLEAR</button>
                      }
                    </div>
                  </div>
                </article>
              } @empty {
                <div class="empty">—</div>
              }
            </div>
          </section>
        }
      </main>

      <!-- Stock panel: this station marks its own dishes in / out of stock -->
      @if (stockOpen()) {
        <div class="stock-scrim" (click)="stockOpen.set(false)"></div>
        <aside class="stock" role="dialog" aria-modal="true" aria-label="Stock">
          <header class="stock-head">
            <div>
              <h2>{{ stationLabel }} stock</h2>
              <p>Out-of-stock dishes show greyed out on waiters' phones and can't be ordered.</p>
            </div>
            <button class="ghost icon" (click)="stockOpen.set(false)" aria-label="Close"><app-icon name="x" [size]="22" /></button>
          </header>
          <input class="stock-search" type="search" placeholder="Search dishes" [value]="stockQuery()" (input)="stockQuery.set($any($event.target).value)" />
          <div class="stock-list">
            @for (it of stockFiltered(); track it._id) {
              <div class="stock-row" [class.is-out]="!it.available">
                <div class="stock-name">
                  <strong>{{ it.name }}</strong>
                  <small>{{ it.categoryId?.name || '' }}</small>
                </div>
                <div class="stock-toggle" role="group" [attr.aria-label]="'Stock for ' + it.name">
                  <button [class.on]="it.available" [disabled]="stockBusy().has(it._id)" (click)="setStock(it, true)">
                    <app-icon name="check" [size]="18" /> In stock
                  </button>
                  <button class="out" [class.on]="!it.available" [disabled]="stockBusy().has(it._id)" (click)="setStock(it, false)">
                    <app-icon name="ban" [size]="18" /> Out
                  </button>
                </div>
              </div>
            } @empty {
              <p class="stock-empty">{{ stockItems().length ? 'No dishes match.' : 'No dishes are assigned to this station yet.' }}</p>
            }
          </div>
        </aside>
      }

      @if (error()) {
        <div class="toast" (click)="error.set('')">{{ error() }}</div>
      }

      @if (needsTap()) {
        <div class="tap" (click)="unlock()">
          <div>
            <h1>{{ stationLabel }}</h1>
            <p>Tap anywhere to start the station screen</p>
            <small>(enables sound alerts and keeps the screen awake)</small>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .kds { min-height: 100vh; background: #0b1120; color: #f1f5f9; display: flex; flex-direction: column; font-size: 18px; }
      .kds.flash { animation: flash 0.6s 3; }
      @keyframes flash { 50% { background: #1e3a8a; } }
      .bar { display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 1rem; background: #111827; border-bottom: 1px solid #1f2937; gap: 1rem; flex-wrap: wrap; }
      .title { display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap; }
      .station { font-size: 1.6rem; font-weight: 900; letter-spacing: 1px; text-transform: uppercase; color: #fbbf24; }
      .counts { color: #94a3b8; font-size: 0.95rem; }
      .right { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
      .clock { font-weight: 700; font-variant-numeric: tabular-nums; }
      .conn { display: inline-flex; align-items: center; gap: 0.4rem; font-weight: 800; color: #f87171; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.06em; }
      .conn i { width: 9px; height: 9px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 3px rgba(248, 113, 113, 0.25); }
      .conn.ok { color: #4ade80; }
      .conn.ok i { box-shadow: 0 0 0 3px rgba(74, 222, 128, 0.25); }
      .ghost { display: inline-flex; align-items: center; gap: 0.4rem; }
      .ghost.icon { width: 48px; justify-content: center; padding: 0; }
      .timer, .ph { display: inline-flex; align-items: center; gap: 0.3rem; }
      .actions button { display: inline-flex; align-items: center; justify-content: center; gap: 0.35rem; }
      .ghost { min-height: 48px; padding: 0 1rem; border-radius: 0.6rem; border: 1px solid #334155; background: transparent; color: #e2e8f0; font: inherit; font-size: 0.95rem; cursor: pointer; }
      .offline { background: #7f1d1d; color: #fff; padding: 0.6rem 1rem; font-weight: 700; text-align: center; }
      .recall { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; padding: 0.6rem 1rem; background: #1e293b; }
      .ghost.has-out { border-color: #f87171; }
      .out-pill { background: #dc2626; color: #fff; border-radius: 999px; padding: 0.05rem 0.5rem; font-size: 0.8rem; font-weight: 800; }
      .stock-scrim { position: fixed; inset: 0; background: rgba(2, 6, 23, 0.6); z-index: 40; }
      .stock { position: fixed; top: 0; right: 0; bottom: 0; width: min(560px, 100%); z-index: 41; background: #111827; border-left: 1px solid #1f2937; display: flex; flex-direction: column; padding: 1.25rem; gap: 1rem; box-shadow: -20px 0 40px rgba(0, 0, 0, 0.4); }
      .stock-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
      .stock-head h2 { margin: 0; font-size: 1.5rem; color: #fbbf24; text-transform: uppercase; letter-spacing: 1px; }
      .stock-head p { margin: 0.25rem 0 0; color: #94a3b8; font-size: 0.95rem; }
      .stock-search { min-height: 52px; border-radius: 0.6rem; border: 1px solid #334155; background: #0b1120; color: #f1f5f9; padding: 0 1rem; font: inherit; }
      .stock-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 0.5rem; }
      .stock-row { display: flex; align-items: center; gap: 1rem; padding: 0.75rem 0.9rem; border-radius: 0.7rem; background: #1e293b; border: 1px solid #334155; }
      .stock-row.is-out { border-color: #7f1d1d; background: #2a1215; }
      .stock-name { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .stock-name strong { font-size: 1.1rem; }
      .stock-row.is-out .stock-name strong { color: #fca5a5; }
      .stock-name small { color: #94a3b8; }
      .stock-toggle { display: inline-flex; border-radius: 0.6rem; overflow: hidden; border: 1px solid #475569; flex-shrink: 0; }
      .stock-toggle button { min-height: 56px; min-width: 110px; padding: 0 0.9rem; border: 0; background: transparent; color: #94a3b8; font: inherit; font-weight: 800; display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; cursor: pointer; }
      .stock-toggle button.on { background: #15803d; color: #fff; }
      .stock-toggle button.out.on { background: #dc2626; color: #fff; }
      .stock-toggle button:disabled { opacity: 0.6; }
      .stock-empty { color: #94a3b8; text-align: center; padding: 2rem 0; }
      .recall-btn { min-height: 48px; padding: 0 1rem; border-radius: 0.6rem; border: 1px solid #fbbf24; background: #422006; color: #fde68a; font: inherit; cursor: pointer; }
      .muted { color: #94a3b8; }
      .lanes { flex: 1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.75rem; padding: 0.75rem; min-height: 0; }
      .lane { display: flex; flex-direction: column; min-height: 0; background: #0f172a; border-radius: 0.8rem; }
      .lane-h { margin: 0; padding: 0.6rem 0.9rem; font-size: 1.1rem; letter-spacing: 1px; text-transform: uppercase; display: flex; justify-content: space-between; border-radius: 0.8rem 0.8rem 0 0; }
      .lane-h.new { background: #1d4ed8; }
      .lane-h.preparing { background: #b45309; }
      .lane-h.ready { background: #15803d; }
      .cards { flex: 1; overflow-y: auto; padding: 0.6rem; display: flex; flex-direction: column; gap: 0.6rem; }
      .empty { color: #334155; text-align: center; padding: 2rem 0; font-size: 2rem; }
      .card { background: #f8fafc; color: #0f172a; border-radius: 0.7rem; overflow: hidden; border: 4px solid transparent; }
      .card.warn { border-color: #f59e0b; }
      .card.late { border-color: #dc2626; }
      .card.late .timer { color: #dc2626; }
      .card.warn .timer { color: #b45309; }
      .card.edited { border-color: #dc2626; }
      .card.fresh { animation: pop 0.8s 2; }
      @keyframes pop { 50% { transform: scale(1.03); box-shadow: 0 0 0 6px #fbbf24; } }
      .edited-banner { background: #dc2626; color: #fff; font-weight: 900; text-align: center; padding: 0.35rem; letter-spacing: 2px; font-size: 1.1rem; }
      .resent { background: #7c3aed; color: #fff; font-weight: 800; text-align: center; padding: 0.2rem; font-size: 0.85rem; }
      .card-h { display: flex; justify-content: space-between; align-items: baseline; padding: 0.5rem 0.7rem 0; gap: 0.5rem; }
      .num { font-size: 1.5rem; font-weight: 900; }
      .type { font-weight: 800; text-align: right; }
      .card-sub { display: flex; justify-content: space-between; padding: 0 0.7rem; color: #475569; font-size: 0.95rem; }
      .timer { font-weight: 800; font-variant-numeric: tabular-nums; color: #0f172a; }
      .items { padding: 0.5rem 0.7rem; border-top: 1px dashed #cbd5e1; border-bottom: 1px dashed #cbd5e1; margin-top: 0.4rem; }
      .item { font-size: 1.15rem; padding: 0.15rem 0; }
      .item.cancelled { text-decoration: line-through; color: #b91c1c; }
      .note { font-size: 0.95rem; color: #b45309; font-style: italic; padding-left: 1.6rem; }
      .sec { font-weight: 900; font-size: 0.85rem; letter-spacing: 1px; margin-top: 0.2rem; }
      .sec.add { color: #15803d; }
      .sec.cancel { color: #b91c1c; }
      .card-f { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0.7rem; gap: 0.5rem; }
      .order { color: #64748b; font-size: 0.9rem; }
      .actions { display: flex; gap: 0.5rem; }
      .actions button { min-height: 64px; min-width: 64px; border-radius: 0.6rem; border: none; font: inherit; font-weight: 900; cursor: pointer; }
      .actions button:disabled { opacity: 0.5; }
      .go { padding: 0 1.2rem; color: #fff; font-size: 1.1rem; }
      .go.start { background: #1d4ed8; }
      .go.ready { background: #15803d; }
      .go.clear { background: #334155; }
      .back { background: #e2e8f0; color: #334155; font-size: 1.3rem; }
      .toast { position: fixed; bottom: 1rem; left: 50%; transform: translateX(-50%); background: #7f1d1d; color: #fff; padding: 0.8rem 1.2rem; border-radius: 0.6rem; font-weight: 700; }
      .tap { position: fixed; inset: 0; background: rgba(2, 6, 23, 0.94); display: flex; align-items: center; justify-content: center; text-align: center; cursor: pointer; }
      .tap h1 { font-size: 3rem; color: #fbbf24; margin: 0 0 0.5rem; text-transform: uppercase; }
      .tap p { font-size: 1.4rem; margin: 0 0 0.4rem; }
      .tap small { color: #94a3b8; }
      @media (max-width: 900px) {
        .lanes { grid-template-columns: 1fr; }
      }
    `,
  ],
})
export class KdsScreenComponent implements OnInit, OnDestroy {
  public readonly laneDefs: { key: 'new' | 'preparing' | 'ready'; title: string }[] = [
    { key: 'new', title: 'New' },
    { key: 'preparing', title: 'Preparing' },
    { key: 'ready', title: 'Ready' },
  ];

  public stationLabel = '';
  public kots = signal<Kot[]>([]);
  public recentlyServed = signal<Kot[]>([]);
  public settings = signal<KdsSettings>({ kdsWarnMinutes: 10, kdsLateMinutes: 15, kdsSoundEnabled: true });
  public connected = signal(false);
  public now = signal(Date.now());
  public flashing = signal(false);
  public showRecall = signal(false);

  // Stock (this station's dishes)
  public stockOpen = signal(false);
  public stockItems = signal<{ _id: string; name: string; available: boolean; categoryId?: { name?: string } }[]>([]);
  public stockQuery = signal('');
  public stockBusy = signal<Set<string>>(new Set());
  public outCount = computed(() => this.stockItems().filter((i) => !i.available).length);
  public stockFiltered = computed(() => {
    const q = this.stockQuery().trim().toLowerCase();
    return this.stockItems()
      .filter((i) => !q || i.name.toLowerCase().includes(q))
      .sort((a, b) => Number(a.available) - Number(b.available) || a.name.localeCompare(b.name));
  });
  public needsTap = signal(true);
  public muted = signal(false);
  public error = signal('');
  public busy = signal<Set<string>>(new Set());
  private freshIds = signal<Set<string>>(new Set());

  public lanes = computed(() => {
    const byAge = (a: Kot, b: Kot) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    const all = this.kots();
    return {
      new: all.filter((k) => k.status === 'new').sort(byAge),
      preparing: all.filter((k) => k.status === 'preparing').sort(byAge),
      ready: all.filter((k) => k.status === 'ready').sort(byAge),
    };
  });

  public clock = computed(() =>
    new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }).format(
      this.now(),
    ),
  );

  private subs: Subscription[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private serverOffsetMs = 0;
  private audioCtx?: AudioContext;
  private wakeLock: any = null;

  constructor(
    private http: HttpClient,
    private auth: AuthService,
    private socket: SocketService,
    private router: Router,
    private ui: UiService,
  ) {}

  ngOnInit(): void {
    const station = this.auth.currentUser?.station;
    this.stationLabel = station ? STATION_LABELS[station] : 'Station';
    this.muted.set(localStorage.getItem('kds_muted') === '1');

    this.timer = setInterval(() => this.now.set(Date.now() + this.serverOffsetMs), 1000);

    this.subs.push(
      this.socket.connected$.subscribe((c) => this.connected.set(c)),
      // Load (and reload after every reconnect) so nothing sent while offline is missed
      this.socket.reconnect$.subscribe(() => {
        this.load();
        this.loadStock();
      }),
      this.socket.fromEvent<Kot>('kot:new').subscribe((k) => this.onNewKot(k)),
      this.socket.fromEvent<Kot>('kot:updated').subscribe((k) => this.onUpdatedKot(k)),
      this.socket.fromEvent<KdsSettings>('kds:settings').subscribe((s) => this.settings.set({ ...this.settings(), ...s })),
      // Stock changes from the manager or another screen
      this.socket.fromEvent<any>('menu:updated').subscribe((it) => this.onMenuUpdated(it)),
    );

    document.addEventListener('visibilitychange', this.onVisibility);
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
    if (this.timer) clearInterval(this.timer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.wakeLock?.release?.().catch?.(() => {});
  }

  // ─── Data ──────────────────────────────────────────────────────────────────
  public load(): void {
    this.http
      .get<{ kots: Kot[]; recentlyServed: Kot[]; settings: KdsSettings; serverTime: string }>(`${environment.apiUrl}/kds/kots`)
      .subscribe({
        next: (res) => {
          this.serverOffsetMs = new Date(res.serverTime).getTime() - Date.now();
          const before = new Set(this.kots().map((k) => k._id));
          this.kots.set(res.kots);
          this.recentlyServed.set(res.recentlyServed);
          this.settings.set(res.settings);
          // Alert if a resync brought in KOTs we hadn't seen (e.g. sent while offline)
          const missed = res.kots.filter((k) => !before.has(k._id) && k.status === 'new');
          if (before.size > 0 && missed.length) this.alert(missed.map((k) => k._id));
        },
        error: (err) => this.error.set(err.error?.message || 'Could not load KOTs'),
      });
  }

  private onNewKot(k: Kot): void {
    if (k.station !== this.auth.currentUser?.station) return;
    // Confirm display to the server (drives the cashier's "undelivered" alert)
    this.socket.emit('kot:received', { kotId: k._id }, () => {});
    this.upsert(k);
    this.recentlyServed.update((list) => list.filter((x) => x._id !== k._id));
    this.alert([k._id]);
  }

  private onUpdatedKot(k: Kot): void {
    if (k.station !== this.auth.currentUser?.station) return;
    if (k.status === 'served') {
      this.kots.update((list) => list.filter((x) => x._id !== k._id));
      this.recentlyServed.update((list) => [k, ...list.filter((x) => x._id !== k._id)].slice(0, 10));
    } else {
      this.upsert(k);
      this.recentlyServed.update((list) => list.filter((x) => x._id !== k._id));
    }
  }

  private upsert(k: Kot): void {
    this.kots.update((list) => {
      const idx = list.findIndex((x) => x._id === k._id);
      if (idx === -1) return [...list, k];
      const copy = list.slice();
      copy[idx] = { ...copy[idx], ...k };
      return copy;
    });
  }

  // ─── Actions ───────────────────────────────────────────────────────────────
  public move(k: Kot, status: KotStatus): void {
    this.setBusy(k._id, true);
    this.http.post<{ kot: Kot }>(`${environment.apiUrl}/kds/kots/${k._id}/status`, { status }).subscribe({
      next: (res) => {
        this.setBusy(k._id, false);
        this.onUpdatedKot(res.kot);
      },
      error: (err) => {
        this.setBusy(k._id, false);
        this.error.set(err.error?.message || 'Update failed');
        this.load();
      },
    });
  }

  public recall(k: Kot): void {
    this.http.post<{ kot: Kot }>(`${environment.apiUrl}/kds/kots/${k._id}/recall`, {}).subscribe({
      next: (res) => {
        this.onUpdatedKot(res.kot);
        this.showRecall.set(false);
      },
      error: (err) => this.error.set(err.error?.message || 'Recall failed'),
    });
  }

  // ─── Stock ─────────────────────────────────────────────────────────────────
  public openStock(): void {
    this.stockQuery.set('');
    this.stockOpen.set(true);
    this.loadStock();
  }

  public loadStock(): void {
    this.http.get<{ items: any[] }>(`${environment.apiUrl}/kds/menu`).subscribe({
      next: (res) => this.stockItems.set(res.items || []),
      error: (err) => this.error.set(err.error?.message || 'Could not load stock'),
    });
  }

  public setStock(item: { _id: string; name: string; available: boolean }, available: boolean): void {
    if (item.available === available) return;
    const busy = new Set(this.stockBusy());
    busy.add(item._id);
    this.stockBusy.set(busy);
    const apply = (val: boolean) => this.stockItems.update((list) => list.map((i) => (i._id === item._id ? { ...i, available: val } : i)));
    apply(available);
    this.http.patch(`${environment.apiUrl}/kds/items/${item._id}/availability`, { available }).subscribe({
      next: () => this.clearStockBusy(item._id),
      error: (err) => {
        apply(!available);
        this.clearStockBusy(item._id);
        this.error.set(err.error?.message || 'Could not update stock');
      },
    });
  }

  private clearStockBusy(id: string): void {
    const busy = new Set(this.stockBusy());
    busy.delete(id);
    this.stockBusy.set(busy);
  }

  private onMenuUpdated(it: any): void {
    if (!it?._id || it.station !== this.auth.currentUser?.station) return;
    this.stockItems.update((list) => {
      if (it.active === false) return list.filter((i) => i._id !== String(it._id));
      const idx = list.findIndex((i) => i._id === String(it._id));
      if (idx === -1) return list;
      const copy = list.slice();
      copy[idx] = { ...copy[idx], available: it.available, name: it.name };
      return copy;
    });
  }

  public toggleMute(): void {
    this.muted.set(!this.muted());
    localStorage.setItem('kds_muted', this.muted() ? '1' : '0');
  }

  public async logout(): Promise<void> {
    const ok = await this.ui.confirm({
      title: 'Sign this station screen out?',
      message: 'New tickets will not show here until someone signs in again with the station PIN.',
      confirmText: 'Sign out',
      danger: true,
    });
    if (ok) this.auth.logout();
  }

  /** First tap: unlock audio (browser autoplay rules), keep screen awake, go fullscreen. */
  public unlock(): void {
    this.needsTap.set(false);
    try {
      this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.audioCtx.resume();
    } catch {
      /* no audio */
    }
    this.requestWakeLock();
    document.documentElement.requestFullscreen?.().catch(() => {});
  }

  // ─── Display helpers ───────────────────────────────────────────────────────
  public header(k: Kot): string {
    const c = k.context;
    const t = String(c.tableLabel ?? '');
    if (c.orderType === 'dine_in') return `${c.floor ? c.floor.replace(' Floor', '') + ' · ' : ''}${/^\d+$/.test(t) ? 'T' + t : t}`;
    if (c.orderType === 'takeaway') return `TAKEAWAY · ${c.customerName ?? ''}`;
    return `DELIVERY · ${c.customerName ?? ''}`;
  }

  public elapsed(k: Kot): string {
    const secs = Math.max(0, Math.floor((this.now() - new Date(k.createdAt).getTime()) / 1000));
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  public timerClass(k: Kot): string {
    if (k.status === 'ready') return '';
    const mins = (this.now() - new Date(k.createdAt).getTime()) / 60000;
    if (mins >= this.settings().kdsLateMinutes) return 'late';
    if (mins >= this.settings().kdsWarnMinutes) return 'warn';
    return '';
  }

  public time(iso: string): string {
    return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }).format(
      new Date(iso),
    );
  }

  public isFresh(k: Kot): boolean {
    return this.freshIds().has(k._id);
  }

  private setBusy(id: string, on: boolean): void {
    const next = new Set(this.busy());
    if (on) next.add(id);
    else next.delete(id);
    this.busy.set(next);
  }

  private alert(ids: string[]): void {
    this.freshIds.set(new Set([...this.freshIds(), ...ids]));
    setTimeout(() => {
      const next = new Set(this.freshIds());
      ids.forEach((id) => next.delete(id));
      this.freshIds.set(next);
    }, 4000);
    this.flashing.set(true);
    setTimeout(() => this.flashing.set(false), 1900);
    if (this.settings().kdsSoundEnabled && !this.muted()) this.chime();
  }

  /** Loud two-tone chime generated with WebAudio (no asset needed). */
  private chime(): void {
    const ctx = this.audioCtx;
    if (!ctx) return;
    const tone = (freq: number, start: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + 0.4);
    };
    tone(880, 0);
    tone(1320, 0.4);
    tone(880, 0.8);
  }

  private async requestWakeLock(): Promise<void> {
    try {
      this.wakeLock = await (navigator as any).wakeLock?.request('screen');
    } catch {
      /* not supported */
    }
  }

  // Wake locks are released when the tab is hidden; re-acquire and resync on return
  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      if (!this.needsTap()) this.requestWakeLock();
      this.load();
    }
  };
}
