import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { AuthService, UserRole } from '../core/auth/auth.service';
import { SocketService } from '../core/socket/socket.service';
import { IconComponent } from './icon.component';
import { UiService } from './ui.service';

interface NavItem {
  label: string;
  icon: string;
  link: string;
  minRole: Exclude<UserRole, 'kitchen' | 'delivery'>;
  exact?: boolean;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const LEVEL: Record<string, number> = { waiter: 0, cashier: 1, manager: 2, owner: 3 };

const NAV: NavGroup[] = [
  {
    title: 'Service',
    items: [
      { label: 'Billing desk', icon: 'receipt', link: '/cashier/home', minRole: 'cashier' },
      { label: 'Take orders', icon: 'utensils', link: '/waiter/tables', minRole: 'cashier' },
      { label: 'Orders', icon: 'history', link: '/orders', minRole: 'cashier' },
      { label: 'Customers', icon: 'user', link: '/customers', minRole: 'cashier' },
      { label: 'Accounts', icon: 'wallet', link: '/accounts', minRole: 'cashier' },
    ],
  },
  {
    title: 'Business',
    items: [
      { label: 'Overview', icon: 'dashboard', link: '/admin', minRole: 'owner', exact: true },
      { label: 'Reports', icon: 'chart', link: '/admin/reports', minRole: 'manager' },
      { label: 'Menu', icon: 'layers', link: '/admin/menu', minRole: 'manager' },
    ],
  },
  {
    title: 'Setup',
    items: [
      { label: 'Staff & screens', icon: 'users', link: '/admin/staff', minRole: 'owner' },
      { label: 'Tables', icon: 'table', link: '/admin/tables', minRole: 'owner' },
      { label: 'Settings', icon: 'settings', link: '/admin/settings', minRole: 'owner' },
    ],
  },
];

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', manager: 'Manager', cashier: 'Cashier', waiter: 'Waiter' };

/**
 * Layout for back-office pages (billing desk, admin, reports):
 * sidebar navigation filtered by role, user menu and connection status.
 */
@Component({
  selector: 'app-shell',
  // Eager so change detection reaches the routed back-office pages (Angular 22 defaults to OnPush)
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, IconComponent],
  template: `
    <div class="shell" [class.collapsed]="collapsed()" [class.drawer-open]="drawerOpen()">
      <aside class="shell-sidebar" aria-label="Main navigation">
        <div class="brand">
          <div class="brand-mark"><app-icon name="flame" [size]="18" /></div>
          <div class="brand-text">
            <strong>Copakapana</strong>
            <span>Restaurant POS</span>
          </div>
        </div>

        <nav class="nav">
          @for (g of groups(); track g.title) {
            <div class="nav-group">
              <div class="nav-title">{{ g.title }}</div>
              @for (item of g.items; track item.link) {
                <a
                  class="nav-item"
                  [routerLink]="item.link"
                  routerLinkActive="active"
                  [routerLinkActiveOptions]="{ exact: !!item.exact }"
                  [attr.title]="collapsed() ? item.label : null"
                  (click)="drawerOpen.set(false)"
                >
                  <app-icon [name]="item.icon" />
                  <span class="nav-label">{{ item.label }}</span>
                </a>
              }
            </div>
          }
        </nav>

        <div class="sidebar-foot">
          <div class="conn" [class.ok]="connected()" [attr.title]="connected() ? 'Live updates connected' : 'Reconnecting…'">
            <span class="dot"></span>
            <span class="nav-label">{{ connected() ? 'Live' : 'Reconnecting…' }}</span>
          </div>
          <div class="user">
            <div class="avatar">{{ initials() }}</div>
            <div class="user-text nav-label">
              <strong class="truncate">{{ user()?.name }}</strong>
              <span>{{ roleLabel() }}</span>
            </div>
            <button class="btn btn-ghost btn-icon btn-sm signout" (click)="signOut()" title="Sign out" aria-label="Sign out">
              <app-icon name="logout" [size]="18" />
            </button>
          </div>
          <button class="collapse-btn" (click)="toggleCollapsed()" [attr.aria-label]="collapsed() ? 'Expand sidebar' : 'Collapse sidebar'">
            <app-icon [name]="collapsed() ? 'chevron-right' : 'chevron-left'" [size]="16" />
            <span class="nav-label">Collapse</span>
          </button>
        </div>
      </aside>

      <div class="drawer-scrim" (click)="drawerOpen.set(false)"></div>

      <div class="shell-main">
        <header class="shell-topbar">
          <button class="btn btn-ghost btn-icon" (click)="drawerOpen.set(true)" aria-label="Open menu">
            <app-icon name="menu" />
          </button>
          <div class="brand-mark sm"><app-icon name="flame" [size]="16" /></div>
          <strong class="topbar-title">{{ pageTitle() }}</strong>
          <span class="spacer"></span>
          <span class="conn-dot" [class.ok]="connected()"></span>
        </header>
        <main class="shell-content">
          <router-outlet />
        </main>
      </div>
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .shell { min-height: 100vh; }
      .shell-sidebar {
        position: fixed; inset: 0 auto 0 0; z-index: 800; width: var(--sidebar-w);
        display: flex; flex-direction: column; background: var(--gray-900); color: #d9d5cf;
        transition: width 0.2s var(--ease), transform 0.25s var(--ease);
      }
      .brand { display: flex; align-items: center; gap: 0.7rem; padding: 1.1rem 1.1rem 1rem; }
      .brand-mark { width: 36px; height: 36px; border-radius: 10px; background: var(--primary); color: #fff; display: grid; place-items: center; flex-shrink: 0; box-shadow: 0 4px 12px rgba(228, 87, 46, 0.35); }
      .brand-mark.sm { width: 30px; height: 30px; border-radius: 8px; box-shadow: none; }
      .brand-text { display: flex; flex-direction: column; line-height: 1.15; min-width: 0; }
      .brand-text strong { color: #fff; font-size: 1rem; letter-spacing: -0.01em; }
      .brand-text span { font-size: 0.72rem; color: #8f8a83; }
      .nav { flex: 1; overflow-y: auto; padding: 0.25rem 0.65rem; }
      .nav-group { margin-top: 0.9rem; }
      .nav-title { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #6f6a63; padding: 0 0.6rem 0.35rem; white-space: nowrap; }
      .nav-item {
        display: flex; align-items: center; gap: 0.7rem; min-height: 40px; padding: 0 0.65rem; margin-bottom: 2px;
        border-radius: 8px; color: #c8c3bc; font-size: var(--fs-sm); font-weight: 550; text-decoration: none; white-space: nowrap;
        transition: background 0.12s, color 0.12s;
      }
      .nav-item:hover { background: rgba(255, 255, 255, 0.06); color: #fff; text-decoration: none; }
      .nav-item.active { background: rgba(228, 87, 46, 0.16); color: #ffb59b; }
      .nav-item.active app-icon { color: var(--primary); }
      .sidebar-foot { padding: 0.75rem 0.65rem 0.9rem; border-top: 1px solid rgba(255, 255, 255, 0.07); display: flex; flex-direction: column; gap: 0.5rem; }
      .conn { display: flex; align-items: center; gap: 0.55rem; font-size: var(--fs-xs); color: #a39e97; padding: 0 0.65rem; min-height: 24px; white-space: nowrap; }
      .dot, .conn-dot { width: 8px; height: 8px; border-radius: 50%; background: #e0a43a; flex-shrink: 0; box-shadow: 0 0 0 3px rgba(224, 164, 58, 0.18); }
      .conn.ok .dot, .conn-dot.ok { background: #3ec46d; box-shadow: 0 0 0 3px rgba(62, 196, 109, 0.18); }
      .user { display: flex; align-items: center; gap: 0.6rem; padding: 0.45rem; border-radius: 10px; background: rgba(255, 255, 255, 0.04); }
      .avatar { width: 34px; height: 34px; border-radius: 50%; background: #3a3631; color: #fff; display: grid; place-items: center; font-size: 0.8rem; font-weight: 700; flex-shrink: 0; }
      .user-text { display: flex; flex-direction: column; min-width: 0; flex: 1; line-height: 1.2; }
      .user-text strong { color: #fff; font-size: var(--fs-sm); }
      .user-text span { font-size: 0.72rem; color: #8f8a83; }
      .signout { color: #a39e97; }
      .signout:hover:not(:disabled) { background: rgba(255, 255, 255, 0.08); color: #fff; }
      .collapse-btn { display: flex; align-items: center; gap: 0.55rem; background: none; border: 0; color: #6f6a63; font-size: var(--fs-xs); padding: 0.3rem 0.65rem; min-height: 28px; white-space: nowrap; }
      .collapse-btn:hover { color: #c8c3bc; }

      .shell-main { margin-left: var(--sidebar-w); min-height: 100vh; display: flex; flex-direction: column; transition: margin 0.2s var(--ease); }
      .shell-content { flex: 1; min-width: 0; }
      .shell-topbar { display: none; }

      /* Collapsed (desktop icon rail) */
      .collapsed .shell-sidebar { width: 68px; }
      .collapsed .shell-main { margin-left: 68px; }
      .collapsed .nav-label, .collapsed .brand-text, .collapsed .nav-title { display: none; }
      .collapsed .nav-item { justify-content: center; padding: 0; }
      .collapsed .brand { justify-content: center; padding-inline: 0; }
      .collapsed .user { flex-direction: column; background: none; padding: 0; }
      .collapsed .conn, .collapsed .collapse-btn { justify-content: center; padding: 0; }
      .collapsed .nav-group { margin-top: 0.6rem; border-top: 1px solid rgba(255, 255, 255, 0.06); padding-top: 0.6rem; }
      .collapsed .nav-group:first-child { border-top: 0; }

      .drawer-scrim { display: none; }

      /* Tablet / phone: off-canvas drawer + top bar */
      @media (max-width: 1023px) {
        .shell-sidebar, .collapsed .shell-sidebar { width: 272px; transform: translateX(-100%); box-shadow: var(--shadow-lg); }
        .collapsed .nav-label, .collapsed .brand-text, .collapsed .nav-title { display: initial; }
        .collapsed .brand-text { display: flex; }
        .collapsed .user-text { display: flex; }
        .drawer-open .shell-sidebar { transform: none; }
        .drawer-open .drawer-scrim { display: block; position: fixed; inset: 0; z-index: 790; background: rgba(26, 24, 21, 0.45); animation: fade-in 0.15s; }
        .shell-main, .collapsed .shell-main { margin-left: 0; }
        .collapse-btn { display: none; }
        .shell-topbar {
          display: flex; align-items: center; gap: 0.6rem; position: sticky; top: 0; z-index: 700; height: var(--topbar-h);
          padding: 0 0.75rem; background: rgba(255, 255, 255, 0.92); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border);
        }
        .topbar-title { font-size: var(--fs-base); }
      }
    `,
  ],
})
export class ShellComponent {
  private auth = inject(AuthService);
  private socket = inject(SocketService);
  private router = inject(Router);
  private ui = inject(UiService);

  readonly user = toSignal(this.auth.currentUser$, { initialValue: this.auth.currentUser });
  readonly connected = toSignal(this.socket.connected$, { initialValue: false });
  readonly collapsed = signal(this.readCollapsed());
  readonly drawerOpen = signal(false);
  private readonly url = toSignal(
    this.router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd)),
    { initialValue: null },
  );

  readonly groups = computed(() => {
    const level = LEVEL[this.user()?.role ?? ''] ?? -1;
    return NAV.map((g) => ({ ...g, items: g.items.filter((i) => level >= LEVEL[i.minRole]) })).filter((g) => g.items.length);
  });

  readonly initials = computed(() =>
    (this.user()?.name ?? '?')
      .split(/\s+/)
      .map((p) => p[0])
      .join('')
      .slice(0, 2)
      .toUpperCase(),
  );

  readonly roleLabel = computed(() => ROLE_LABEL[this.user()?.role ?? ''] ?? '');

  readonly pageTitle = computed(() => {
    this.url();
    const path = this.router.url.split('?')[0];
    const item = NAV.flatMap((g) => g.items)
      .filter((i) => (i.exact ? path === i.link : path.startsWith(i.link)))
      .sort((a, b) => b.link.length - a.link.length)[0];
    return item?.label ?? 'Copakapana';
  });

  toggleCollapsed(): void {
    this.collapsed.update((c) => !c);
    try {
      localStorage.setItem('shell_collapsed', this.collapsed() ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  }

  async signOut(): Promise<void> {
    const ok = await this.ui.confirm({ title: 'Sign out?', message: 'You will need to sign in again to continue.', confirmText: 'Sign out' });
    if (ok) this.auth.logout();
  }

  private readCollapsed(): boolean {
    try {
      return localStorage.getItem('shell_collapsed') === '1';
    } catch {
      return false;
    }
  }
}
