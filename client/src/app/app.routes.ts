import { Routes } from '@angular/router';
import { deliveryGuard, guestGuard, kitchenGuard, landingRedirect, roleGuard } from './core/auth/role.guard';

/**
 * Every route is guarded:
 *  - login pages: guestGuard (signed-in users go to their home)
 *  - staff pages: roleGuard(minimum role)
 *  - /kds: kitchenGuard (station screen accounts only)
 *  - '' and unknown URLs: redirect to home or login
 *
 * Back-office pages (billing desk, admin, reports) render inside the shared
 * ShellComponent (sidebar navigation). The waiter app and station screen are
 * full-screen apps of their own.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: landingRedirect },

  // ─── Sign-in ────────────────────────────────────────────────────────────
  {
    path: 'login/waiter',
    canActivate: [guestGuard],
    title: 'Waiter sign-in · Copakapana',
    loadComponent: () => import('./features/auth/login-waiter.component').then((m) => m.LoginWaiterComponent),
  },
  {
    path: 'login/pc',
    canActivate: [guestGuard],
    title: 'Counter sign-in · Copakapana',
    loadComponent: () => import('./features/auth/login-pc.component').then((m) => m.LoginPCComponent),
  },
  {
    path: 'login/kitchen',
    canActivate: [guestGuard],
    title: 'Station screen · Copakapana',
    loadComponent: () => import('./features/auth/login-kitchen.component').then((m) => m.LoginKitchenComponent),
  },

  // ─── Full-screen apps ───────────────────────────────────────────────────
  {
    path: 'waiter/tables',
    canActivate: [roleGuard('waiter')],
    title: 'Tables · Copakapana',
    loadComponent: () => import('./features/waiter/waiter-main.component').then((m) => m.WaiterMainComponent),
  },
  {
    // Kitchen station screen (KDS) — one screen per kitchen station
    path: 'kds',
    canActivate: [kitchenGuard],
    title: 'Station screen · Copakapana',
    loadComponent: () => import('./features/kds/kds-screen.component').then((m) => m.KdsScreenComponent),
  },
  {
    // Delivery staff app — what to deliver, where, and what to collect
    path: 'delivery',
    canActivate: [deliveryGuard],
    title: 'Deliveries · Copakapana',
    loadComponent: () => import('./features/delivery/delivery-app.component').then((m) => m.DeliveryAppComponent),
  },

  // ─── Back office (inside the shell) ─────────────────────────────────────
  {
    path: '',
    canActivate: [roleGuard('cashier')],
    loadComponent: () => import('./shared/shell.component').then((m) => m.ShellComponent),
    children: [
      {
        path: 'cashier/home',
        canActivate: [roleGuard('cashier')],
        title: 'Billing desk · Copakapana',
        loadComponent: () => import('./features/cashier/cashier-home.component').then((m) => m.CashierHomeComponent),
      },
      {
        path: 'customers',
        canActivate: [roleGuard('cashier')],
        title: 'Customers · Copakapana',
        loadComponent: () => import('./features/customers/customers.component').then((m) => m.CustomersComponent),
      },
      {
        path: 'accounts',
        canActivate: [roleGuard('cashier')],
        title: 'Accounts · Copakapana',
        loadComponent: () => import('./features/accounts/accounts.component').then((m) => m.AccountsComponent),
      },
      {
        path: 'admin',
        pathMatch: 'full',
        canActivate: [roleGuard('owner')],
        title: 'Overview · Copakapana',
        loadComponent: () => import('./features/admin/admin-dashboard.component').then((m) => m.AdminDashboardComponent),
      },
      { path: 'admin/dashboard', redirectTo: '/admin', pathMatch: 'full' },
      {
        path: 'admin/staff',
        canActivate: [roleGuard('owner')],
        title: 'Staff & screens · Copakapana',
        loadComponent: () => import('./features/admin/staff-admin.component').then((m) => m.StaffAdminComponent),
      },
      {
        path: 'admin/tables',
        canActivate: [roleGuard('owner')],
        title: 'Tables · Copakapana',
        loadComponent: () => import('./features/admin/tables-admin.component').then((m) => m.TablesAdminComponent),
      },
      {
        path: 'admin/menu',
        canActivate: [roleGuard('manager')],
        title: 'Menu · Copakapana',
        loadComponent: () => import('./features/admin/menu-admin.component').then((m) => m.MenuAdminComponent),
      },
      {
        path: 'admin/reports',
        canActivate: [roleGuard('manager')],
        title: 'Reports · Copakapana',
        loadComponent: () => import('./features/reports/reports-dashboard.component').then((m) => m.ReportsDashboardComponent),
      },
      {
        path: 'admin/settings',
        canActivate: [roleGuard('owner')],
        title: 'Settings · Copakapana',
        loadComponent: () => import('./features/admin/settings-admin.component').then((m) => m.SettingsAdminComponent),
      },
    ],
  },

  { path: '**', redirectTo: landingRedirect },
];
