import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService, UserRole, loginUrlForPath } from './auth.service';

/**
 * Route guards. Every page is covered by exactly one of these:
 *
 *  guestGuard        login pages      signed-in users are sent to their own home
 *  roleGuard(min)    staff pages      signed out → matching login page;
 *                                     wrong role / station screen → own home
 *  kitchenGuard      /kds             station screen accounts only
 *  landingRedirect   '' and '**'      home if signed in, else waiter login
 *
 * Guards return UrlTrees (not router.navigate) so the redirect replaces the
 * blocked navigation — pressing Back can't step into a page you may not see.
 */

const RoleLevel: Record<UserRole, number> = {
  kitchen: -1, // device account: never allowed on staff pages
  waiter: 0,
  cashier: 1,
  manager: 2,
  owner: 3,
};

/** Login pages: only for signed-out users. */
export const guestGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.isLoggedIn ? inject(Router).parseUrl(auth.homeUrl) : true;
};

/** Staff pages: signed in, and at least `minRole`. Station screens are always refused. */
export const roleGuard = (minRole: Exclude<UserRole, 'kitchen'>): CanActivateFn => {
  return (_route, state) => {
    const auth = inject(AuthService);
    const router = inject(Router);

    if (!auth.isLoggedIn) {
      // Clear any half-present session (e.g. profile without tokens)
      if (auth.currentUser) auth.logout({ redirect: false });
      return router.createUrlTree([loginUrlForPath(state.url)], {
        queryParams: state.url && state.url !== '/' ? { returnUrl: state.url } : undefined,
      });
    }

    const role = auth.currentUser!.role;
    if (role !== 'kitchen' && RoleLevel[role] >= RoleLevel[minRole]) return true;
    return router.parseUrl(auth.homeUrl);
  };
};

/** Back-compat alias: "any signed-in staff member". */
export const authGuard: CanActivateFn = roleGuard('waiter');

/** Station screen page: kitchen accounts only. */
export const kitchenGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.isLoggedIn) return router.parseUrl('/login/kitchen');
  const user = auth.currentUser!;
  if (user.role === 'kitchen' && user.station) return true;
  return router.parseUrl(auth.homeUrl);
};

/** For '' and unknown URLs: the user's home if signed in, otherwise the waiter login. */
export const landingRedirect = (): string => {
  const auth = inject(AuthService);
  return auth.isLoggedIn ? auth.homeUrl : '/login/waiter';
};
