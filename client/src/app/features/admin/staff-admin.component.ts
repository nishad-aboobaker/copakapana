import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/auth/auth.service';
import { SocketService } from '../../core/socket/socket.service';
import { IconComponent } from '../../shared/icon.component';
import { UiService } from '../../shared/ui.service';

type Role = 'waiter' | 'cashier' | 'manager' | 'owner' | 'kitchen' | 'delivery';
type Station = 'fried_chicken' | 'juice' | 'main';

interface StaffUser {
  _id: string;
  name: string;
  role: Role;
  station?: Station;
  active: boolean;
  createdAt: string;
}

const ROLE_META: Record<Role, { label: string; icon: string; desc: string; cls: string }> = {
  waiter: { label: 'Waiter', icon: 'utensils', desc: 'Takes orders on their phone · signs in with a PIN', cls: 'badge-primary' },
  cashier: { label: 'Cashier', icon: 'receipt', desc: 'Bills, discounts and payments · password', cls: 'badge-info' },
  manager: { label: 'Manager', icon: 'chart', desc: 'Cashier + reports and menu availability · password', cls: 'badge-warning' },
  owner: { label: 'Owner', icon: 'shield', desc: 'Full access', cls: 'badge-dark' },
  delivery: { label: 'Delivery', icon: 'bike', desc: 'Delivery app on their phone · signs in with a PIN', cls: 'badge-info' },
  kitchen: { label: 'Station screen', icon: 'monitor', desc: 'Kitchen display for one station · PIN', cls: 'badge-success' },
};

const STATIONS: { key: Station; label: string; icon: string }[] = [
  { key: 'fried_chicken', label: 'Fried Chicken', icon: 'flame' },
  { key: 'juice', label: 'Juice Counter', icon: 'sparkles' },
  { key: 'main', label: 'Main Kitchen', icon: 'utensils' },
];

@Component({
  selector: 'app-staff-admin',
  // Angular 22 defaults to OnPush; this page keeps plain-field state updated by HTTP/socket callbacks
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: true,
  imports: [FormsModule, IconComponent],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1 class="page-title">Staff &amp; screens</h1>
          <p class="page-subtitle">Who can sign in, what they can do, and the kitchen station screens.</p>
        </div>
        <div class="page-actions">
          <button class="btn btn-primary" (click)="openCreate(tab() === 'screens' ? 'kitchen' : 'waiter')">
            <app-icon name="plus" /> {{ tab() === 'screens' ? 'Add station screen' : 'Add staff' }}
          </button>
        </div>
      </header>

      <div class="tabs">
        <button [class.active]="tab() === 'people'" (click)="tab.set('people')"><app-icon name="users" /> People <span class="text-subtle">{{ people().length }}</span></button>
        <button [class.active]="tab() === 'screens'" (click)="tab.set('screens')"><app-icon name="monitor" /> Kitchen screens <span class="text-subtle">{{ screens().length }}</span></button>
      </div>

      @if (tab() === 'people') {
        <div class="toolbar">
          <div class="input-group search">
            <app-icon name="search" />
            <input class="input" type="search" placeholder="Search by name" [value]="query()" (input)="query.set($any($event.target).value)" />
          </div>
          <div class="chips">
            @for (f of roleFilters; track f.key) {
              <button class="chip" [class.active]="roleFilter() === f.key" (click)="roleFilter.set(f.key)">{{ f.label }}</button>
            }
          </div>
        </div>

        @if (loading()) {
          <div class="skeleton" style="height: 220px; border-radius: 12px"></div>
        } @else if (filteredPeople().length === 0) {
          <div class="card">
            <div class="empty-state">
              <div class="empty-icon"><app-icon name="users" /></div>
              <h3>{{ query() || roleFilter() !== 'all' ? 'Nobody matches' : 'No staff yet' }}</h3>
              <p>Add waiters so they can sign in on their phones.</p>
              <button class="btn btn-primary" (click)="openCreate('waiter')"><app-icon name="plus" /> Add staff</button>
            </div>
          </div>
        } @else {
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Added</th><th class="text-right">Actions</th></tr></thead>
              <tbody>
                @for (s of filteredPeople(); track s._id) {
                  <tr [class.inactive]="!s.active">
                    <td>
                      <div class="person">
                        <span class="avatar" [style.background]="color(s.name)">{{ initials(s.name) }}</span>
                        <span class="text-strong cap">{{ s.name }}</span>
                        @if (s._id === meId) { <span class="badge">You</span> }
                      </div>
                    </td>
                    <td><span class="badge" [class]="'badge ' + roleMeta[s.role].cls">{{ roleMeta[s.role].label }}</span></td>
                    <td>
                      <span class="status" [class.on]="s.active"><i></i>{{ s.active ? 'Active' : 'Deactivated' }}</span>
                    </td>
                    <td class="text-muted">{{ date(s.createdAt) }}</td>
                    <td class="text-right">
                      <div class="actions">
                        <button class="btn btn-sm" (click)="openCredential(s)">
                          <app-icon name="lock" /> {{ usesPin(s.role) ? 'Reset PIN' : 'Set password' }}
                        </button>
                        @if (s._id !== meId && s.role !== 'owner') {
                          <button class="btn btn-sm" [class.btn-danger-soft]="s.active" (click)="toggleActive(s)">
                            {{ s.active ? 'Deactivate' : 'Activate' }}
                          </button>
                        }
                      </div>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      }

      @if (tab() === 'screens') {
        <div class="alert alert-info screens-help">
          <app-icon name="info" />
          <div class="alert-body">
            On each station's tablet, open <strong class="mono">{{ origin }}/login/kitchen</strong>, tap the station and enter its PIN.
            The screen then stays signed in.
          </div>
        </div>
        <div class="grid-3">
          @for (st of stations; track st.key) {
            <div class="card screen">
              <div class="screen-head">
                <span class="st-icon"><app-icon [name]="st.icon" /></span>
                <div>
                  <h3>{{ st.label }}</h3>
                  @if (screenFor(st.key); as acc) {
                    <span class="status" [class.on]="online(st.key)"><i></i>{{ online(st.key) ? 'Screen online' : 'Screen offline' }}</span>
                  } @else {
                    <span class="text-muted text-sm">Not set up</span>
                  }
                </div>
              </div>
              @if (screenFor(st.key); as acc) {
                <div class="screen-body">
                  <div class="kv"><span>Account</span><strong>{{ acc.name }}</strong></div>
                  <div class="kv"><span>Status</span><strong>{{ acc.active ? 'Active' : 'Deactivated' }}</strong></div>
                </div>
                <div class="card-footer">
                  <button class="btn btn-sm" (click)="openCredential(acc)"><app-icon name="lock" /> Reset PIN</button>
                  <button class="btn btn-sm" [class.btn-danger-soft]="acc.active" (click)="toggleActive(acc)">{{ acc.active ? 'Deactivate' : 'Activate' }}</button>
                </div>
              } @else {
                <div class="screen-body">
                  <p class="text-muted text-sm">Tickets for {{ st.label }} won't be seen until a screen is set up.</p>
                </div>
                <div class="card-footer">
                  <button class="btn btn-primary btn-sm" (click)="openCreate('kitchen', st.key)"><app-icon name="plus" /> Set up screen</button>
                </div>
              }
            </div>
          }
        </div>
      }

      <!-- ─── Add dialog ─── -->
      @if (showCreate()) {
        <div class="modal-backdrop" (click)="showCreate.set(false)">
          <form class="modal" role="dialog" aria-modal="true" aria-label="Add staff" (click)="$event.stopPropagation()" (ngSubmit)="createStaff()">
            <div class="modal-header">
              <div>
                <h3>{{ newRole === 'kitchen' ? 'Add station screen' : 'Add staff' }}</h3>
                <p>{{ roleMeta[newRole].desc }}</p>
              </div>
              <button type="button" class="btn btn-ghost btn-icon modal-close" (click)="showCreate.set(false)" aria-label="Close"><app-icon name="x" /></button>
            </div>
            <div class="modal-body">
              <div class="roles">
                @for (r of creatableRoles; track r) {
                  <button type="button" class="role" [class.sel]="newRole === r" (click)="newRole = r; formError.set('')">
                    <app-icon [name]="roleMeta[r].icon" />
                    <span>{{ roleMeta[r].label }}</span>
                  </button>
                }
              </div>

              @if (newRole === 'kitchen') {
                <div class="field">
                  <span class="label">Station</span>
                  <div class="segmented full">
                    @for (st of stations; track st.key) {
                      <button type="button" [class.active]="newStation === st.key" (click)="newStation = st.key; suggestScreenName()">{{ st.label }}</button>
                    }
                  </div>
                  @if (screenFor(newStation)) {
                    <span class="hint text-warning">This station already has a screen account. Add another only for a second display.</span>
                  }
                </div>
              }

              <div class="field">
                <label for="new-name">{{ newRole === 'kitchen' ? 'Screen name' : 'Name' }}</label>
                <input id="new-name" name="name" class="input" [(ngModel)]="newName" [placeholder]="newRole === 'kitchen' ? 'e.g. fryer-screen' : 'e.g. anu'" autocomplete="off" required />
                <span class="hint">{{ newRole === 'kitchen' || newRole === 'waiter' || newRole === 'delivery' ? 'Shown on the sign-in screen.' : 'Used as the username to sign in.' }}</span>
              </div>

              @if (usesPin(newRole)) {
                <div class="field">
                  <label for="new-pin">PIN</label>
                  <input id="new-pin" name="pin" class="input num pin-input" type="password" inputmode="numeric" maxlength="6" [(ngModel)]="newPin" placeholder="4–6 digits" autocomplete="new-password" />
                  <span class="hint">Give each waiter their own PIN — it's how orders are traced to them.</span>
                </div>
              } @else {
                <div class="field">
                  <label for="new-pass">Password</label>
                  <input id="new-pass" name="password" class="input" type="password" [(ngModel)]="newPassword" placeholder="At least 6 characters" autocomplete="new-password" />
                </div>
              }

              @if (formError()) {
                <div class="alert alert-danger"><app-icon name="alert-circle" /><div class="alert-body">{{ formError() }}</div></div>
              }
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" (click)="showCreate.set(false)">Cancel</button>
              <button type="submit" class="btn btn-primary" [disabled]="saving()">
                @if (saving()) { <span class="spinner"></span> } Add {{ roleMeta[newRole].label.toLowerCase() }}
              </button>
            </div>
          </form>
        </div>
      }

      <!-- ─── PIN / password dialog ─── -->
      @if (credUser(); as u) {
        <div class="modal-backdrop" (click)="credUser.set(null)">
          <form class="modal" role="dialog" aria-modal="true" (click)="$event.stopPropagation()" (ngSubmit)="saveCredential()">
            <div class="modal-header">
              <div>
                <h3>{{ usesPin(u.role) ? 'Reset PIN' : 'Set new password' }} · <span class="cap">{{ u.name }}</span></h3>
                <p>{{ usesPin(u.role) ? 'Also unlocks the account if it was locked.' : 'They will use this next time they sign in.' }}</p>
              </div>
              <button type="button" class="btn btn-ghost btn-icon modal-close" (click)="credUser.set(null)" aria-label="Close"><app-icon name="x" /></button>
            </div>
            <div class="modal-body">
              <div class="field">
                <label for="cred">{{ usesPin(u.role) ? 'New PIN' : 'New password' }}</label>
                <input
                  id="cred"
                  name="cred"
                  class="input"
                  [class.num]="usesPin(u.role)"
                  type="password"
                  [attr.inputmode]="usesPin(u.role) ? 'numeric' : null"
                  [attr.maxlength]="usesPin(u.role) ? 6 : null"
                  [(ngModel)]="credValue"
                  [placeholder]="usesPin(u.role) ? '4–6 digits' : 'At least 6 characters'"
                  autocomplete="new-password"
                  autofocus
                />
              </div>
              @if (formError()) {
                <div class="alert alert-danger"><app-icon name="alert-circle" /><div class="alert-body">{{ formError() }}</div></div>
              }
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" (click)="credUser.set(null)">Cancel</button>
              <button type="submit" class="btn btn-primary" [disabled]="saving()">Save</button>
            </div>
          </form>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .tabs { margin-bottom: 1rem; }
      .toolbar { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
      .search { width: 280px; max-width: 100%; }
      .person { display: flex; align-items: center; gap: 0.6rem; }
      .avatar { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-size: 0.75rem; font-weight: 700; flex-shrink: 0; }
      .cap { text-transform: capitalize; }
      tr.inactive td { opacity: 0.55; }
      .status { display: inline-flex; align-items: center; gap: 0.4rem; font-size: var(--fs-sm); color: var(--text-muted); }
      .status i { width: 8px; height: 8px; border-radius: 50%; background: var(--gray-400); }
      .status.on { color: var(--success); }
      .status.on i { background: var(--success); }
      .actions { display: inline-flex; gap: 0.4rem; }
      .screens-help { margin-bottom: 1rem; }
      .screen { display: flex; flex-direction: column; }
      .screen-head { display: flex; gap: 0.75rem; align-items: center; padding: 1.1rem 1.25rem 0.5rem; }
      .st-icon { width: 42px; height: 42px; border-radius: 12px; display: grid; place-items: center; background: var(--primary-soft); color: var(--primary); }
      .screen-body { padding: 0.5rem 1.25rem 1rem; flex: 1; display: flex; flex-direction: column; gap: 0.4rem; }
      .kv { display: flex; justify-content: space-between; font-size: var(--fs-sm); }
      .kv span { color: var(--text-muted); }
      .roles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem; }
      .role { display: flex; flex-direction: column; align-items: center; gap: 0.35rem; padding: 0.7rem 0.3rem; border-radius: 10px; border: 1.5px solid var(--border); background: var(--surface); font-size: var(--fs-xs); font-weight: 600; color: var(--text); }
      .role.sel { border-color: var(--primary); background: var(--primary-soft); color: var(--primary-active); }
      .segmented.full { display: flex; }
      .segmented.full button { flex: 1; justify-content: center; }
      .pin-input { letter-spacing: 0.3em; font-size: var(--fs-lg); }
      @media (max-width: 520px) { .roles { grid-template-columns: repeat(2, 1fr); } }
    `,
  ],
})
export class StaffAdminComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private socket = inject(SocketService);
  private ui = inject(UiService);
  private sub?: Subscription;

  readonly roleMeta = ROLE_META;
  readonly stations = STATIONS;
  readonly creatableRoles: Role[] = ['waiter', 'delivery', 'cashier', 'manager', 'kitchen'];
  readonly roleFilters: { key: 'all' | Role; label: string }[] = [
    { key: 'all', label: 'Everyone' },
    { key: 'waiter', label: 'Waiters' },
    { key: 'delivery', label: 'Delivery' },
    { key: 'cashier', label: 'Cashiers' },
    { key: 'manager', label: 'Managers' },
    { key: 'owner', label: 'Owners' },
  ];
  readonly meId = this.auth.currentUser?.id;
  readonly origin = window.location.origin;

  readonly staff = signal<StaffUser[]>([]);
  readonly loading = signal(true);
  readonly tab = signal<'people' | 'screens'>('people');
  readonly query = signal('');
  readonly roleFilter = signal<'all' | Role>('all');
  readonly stationStatus = signal<Record<string, { online: boolean }>>({});
  readonly showCreate = signal(false);
  readonly saving = signal(false);
  readonly formError = signal('');
  readonly credUser = signal<StaffUser | null>(null);

  newRole: Role = 'waiter';
  newStation: Station = 'fried_chicken';
  newName = '';
  newPin = '';
  newPassword = '';
  credValue = '';

  readonly people = computed(() => this.staff().filter((s) => s.role !== 'kitchen'));
  readonly screens = computed(() => this.staff().filter((s) => s.role === 'kitchen'));
  readonly filteredPeople = computed(() => {
    const q = this.query().trim().toLowerCase();
    const f = this.roleFilter();
    return this.people()
      .filter((s) => (f === 'all' || s.role === f) && (!q || s.name.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  });

  ngOnInit(): void {
    this.fetchStaff();
    this.http.get<any>(`${environment.apiUrl}/kds/status`).subscribe({ next: (r) => this.stationStatus.set(r.stations || {}), error: () => {} });
    this.sub = this.socket.fromEvent<any>('kds:status').subscribe((s) => this.stationStatus.set(s || {}));
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  usesPin(role: Role): boolean {
    return role === 'waiter' || role === 'kitchen' || role === 'delivery';
  }

  screenFor(station: Station): StaffUser | undefined {
    return this.screens().find((s) => s.station === station && s.active) ?? this.screens().find((s) => s.station === station);
  }

  online(station: Station): boolean {
    return !!this.stationStatus()[station]?.online;
  }

  fetchStaff(): void {
    this.http.get<{ users: StaffUser[] }>(`${environment.apiUrl}/users`).subscribe({
      next: (res) => {
        this.staff.set(res.users || []);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.ui.apiError(err, 'Could not load staff');
      },
    });
  }

  openCreate(role: Role, station?: Station): void {
    this.newRole = role;
    this.newStation = station ?? STATIONS.find((s) => !this.screenFor(s.key))?.key ?? 'fried_chicken';
    this.newName = '';
    this.newPin = '';
    this.newPassword = '';
    this.formError.set('');
    if (role === 'kitchen') this.suggestScreenName();
    this.showCreate.set(true);
  }

  suggestScreenName(): void {
    if (this.newRole !== 'kitchen') return;
    const base = { fried_chicken: 'fryer-screen', juice: 'juice-screen', main: 'main-screen' }[this.newStation];
    if (!this.newName || /-screen(-\d+)?$/.test(this.newName)) {
      let name = base;
      let n = 2;
      while (this.staff().some((s) => s.name === name)) name = `${base}-${n++}`;
      this.newName = name;
    }
  }

  createStaff(): void {
    const name = this.newName.trim();
    if (!name) return this.formError.set('Enter a name');
    if (this.staff().some((s) => s.name.toLowerCase() === name.toLowerCase())) return this.formError.set('That name is already taken');
    const payload: Record<string, string> = { name, role: this.newRole };
    if (this.usesPin(this.newRole)) {
      if (!/^\d{4,6}$/.test(this.newPin)) return this.formError.set('PIN must be 4 to 6 digits');
      payload['pin'] = this.newPin;
    } else {
      if (this.newPassword.length < 6) return this.formError.set('Password must be at least 6 characters');
      payload['password'] = this.newPassword;
    }
    if (this.newRole === 'kitchen') payload['station'] = this.newStation;

    this.saving.set(true);
    this.http.post(`${environment.apiUrl}/users`, payload).subscribe({
      next: () => {
        this.saving.set(false);
        this.showCreate.set(false);
        this.ui.success(`${name} can now sign in`, `${ROLE_META[this.newRole].label} added`);
        this.fetchStaff();
      },
      error: (err) => {
        this.saving.set(false);
        this.formError.set(err.error?.message || 'Could not add');
      },
    });
  }

  async toggleActive(user: StaffUser): Promise<void> {
    if (user.active) {
      const ok = await this.ui.confirm({
        title: `Deactivate ${user.name}?`,
        message: 'They will be signed out and can no longer sign in. Their past orders and reports stay intact.',
        confirmText: 'Deactivate',
        danger: true,
      });
      if (!ok) return;
    }
    this.http.patch(`${environment.apiUrl}/users/${user._id}`, { active: !user.active }).subscribe({
      next: () => {
        this.staff.update((list) => list.map((s) => (s._id === user._id ? { ...s, active: !s.active } : s)));
        this.ui.success(`${user.name} ${user.active ? 'deactivated' : 'activated'}`);
      },
      error: (err) => this.ui.apiError(err),
    });
  }

  openCredential(user: StaffUser): void {
    this.credValue = '';
    this.formError.set('');
    this.credUser.set(user);
  }

  saveCredential(): void {
    const u = this.credUser();
    if (!u) return;
    const pin = this.usesPin(u.role);
    if (pin && !/^\d{4,6}$/.test(this.credValue)) return this.formError.set('PIN must be 4 to 6 digits');
    if (!pin && this.credValue.length < 6) return this.formError.set('Password must be at least 6 characters');
    this.saving.set(true);
    const req = pin
      ? this.http.post(`${environment.apiUrl}/users/${u._id}/reset-pin`, { pin: this.credValue })
      : this.http.patch(`${environment.apiUrl}/users/${u._id}`, { password: this.credValue });
    req.subscribe({
      next: () => {
        this.saving.set(false);
        this.credUser.set(null);
        this.ui.success(pin ? `New PIN set for ${u.name}` : `New password set for ${u.name}`);
      },
      error: (err) => {
        this.saving.set(false);
        this.formError.set(err.error?.message || 'Could not save');
      },
    });
  }

  date(iso: string): string {
    return iso ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)) : '—';
  }

  initials(name: string): string {
    return name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  }

  color(name: string): string {
    const palette = ['#e4572e', '#2f7d6d', '#5b5bd6', '#c2780a', '#b4417a', '#3f7cc4', '#7a5c3e', '#4f8a3a'];
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return palette[h % palette.length];
  }
}
