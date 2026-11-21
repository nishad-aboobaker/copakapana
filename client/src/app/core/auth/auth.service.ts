import { Injectable, NgZone } from '@angular/core';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, tap } from 'rxjs';
import { environment } from '../../../environments/environment';

export type Station = 'fried_chicken' | 'juice' | 'main';
export type UserRole = 'waiter' | 'cashier' | 'manager' | 'owner' | 'kitchen';

export interface UserProfile {
  id: string;
  name: string;
  role: UserRole;
  /** Only for kitchen (station screen) accounts */
  station?: Station;
}

export const STATION_LABELS: Record<Station, string> = {
  fried_chicken: 'Fried Chicken',
  juice: 'Juice Counter',
  main: 'Main Kitchen',
};

/** Where each role lands after login (and where guards send them back to). */
export const HOME_BY_ROLE: Record<UserRole, string> = {
  kitchen: '/kds',
  waiter: '/waiter/tables',
  cashier: '/cashier/home',
  manager: '/cashier/home',
  owner: '/admin',
};

/** Which login page a role (or a protected URL) belongs to. */
export const loginUrlForRole = (role?: UserRole | null): string =>
  role === 'kitchen' ? '/login/kitchen' : role && role !== 'waiter' ? '/login/pc' : '/login/waiter';

export const loginUrlForPath = (url: string): string =>
  url.startsWith('/kds') ? '/login/kitchen' : /^\/(admin|cashier)/.test(url) ? '/login/pc' : '/login/waiter';

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: UserProfile;
}

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private readonly apiUrl = `${environment.apiUrl}/auth`;
  private currentUserSubject = new BehaviorSubject<UserProfile | null>(this.getStoredUser());
  public currentUser$ = this.currentUserSubject.asObservable();

  constructor(
    private http: HttpClient,
    private router: Router,
    private zone: NgZone,
  ) {
    // Keep tabs in sync: signing out (or in) in one tab applies to all tabs
    window.addEventListener('storage', (e) => {
      if (e.key !== 'user' && e.key !== null) return;
      const stored = this.getStoredUser();
      const current = this.currentUserSubject.value;
      if (stored?.id === current?.id) return;
      this.zone.run(() => {
        this.currentUserSubject.next(stored);
        this.router.navigateByUrl(stored ? this.homeUrl : loginUrlForRole(current?.role), { replaceUrl: true });
      });
    });
  }

  /** Signed in = profile + both tokens present. */
  public get isLoggedIn(): boolean {
    return !!this.currentUser && !!this.token && !!localStorage.getItem('refresh_token');
  }

  /** Landing page for the signed-in user (login page if signed out). */
  public get homeUrl(): string {
    const role = this.currentUser?.role;
    return role ? HOME_BY_ROLE[role] ?? '/login/waiter' : '/login/waiter';
  }

  /**
   * After login: go to `returnUrl` (the page that sent them to login) or their
   * home, replacing the login page in history so Back doesn't return to it.
   * Guards still check `returnUrl`, so a wrong-role link just lands on home.
   */
  public goHome(returnUrl?: string | null): void {
    const safe = returnUrl && returnUrl.startsWith('/') && !returnUrl.startsWith('//') && !returnUrl.startsWith('/login');
    this.router.navigateByUrl(safe ? returnUrl! : this.homeUrl, { replaceUrl: true });
  }

  public get currentUser(): UserProfile | null {
    return this.currentUserSubject.value;
  }

  public get token(): string | null {
    return localStorage.getItem('access_token');
  }

  public loginWaiter(name: string, pin: string): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${this.apiUrl}/login`, { name, pin }).pipe(
      tap((res) => this.handleAuthSuccess(res))
    );
  }

  /** Station screen (KDS) device login — PIN, same as waiters. */
  public loginKitchen(name: string, pin: string): Observable<AuthResponse> {
    return this.loginWaiter(name, pin);
  }

  public loginPC(name: string, password: string): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${this.apiUrl}/login`, { name, password }).pipe(
      tap((res) => this.handleAuthSuccess(res))
    );
  }

  /**
   * Clears the session and (by default) sends the user to their login page,
   * replacing the current history entry so Back can't return to a protected page.
   */
  public logout(options: { redirect?: boolean } = {}): void {
    const role = this.currentUser?.role;
    const token = this.token;
    if (token) {
      this.http.post(`${this.apiUrl}/logout`, {}).subscribe({
        error: () => {},
      });
    }
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    localStorage.removeItem('user');
    this.currentUserSubject.next(null);
    if (options.redirect !== false) {
      this.router.navigateByUrl(loginUrlForRole(role), { replaceUrl: true });
    }
  }

  public refreshToken(): Observable<{ accessToken: string }> {
    const refreshToken = localStorage.getItem('refresh_token');
    return this.http.post<{ accessToken: string }>(`${this.apiUrl}/refresh`, { refreshToken }).pipe(
      tap((res) => {
        localStorage.setItem('access_token', res.accessToken);
      })
    );
  }

  private handleAuthSuccess(res: AuthResponse): void {
    localStorage.setItem('access_token', res.accessToken);
    localStorage.setItem('refresh_token', res.refreshToken);
    localStorage.setItem('user', JSON.stringify(res.user));
    this.currentUserSubject.next(res.user);
  }

  private getStoredUser(): UserProfile | null {
    const data = localStorage.getItem('user');
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
}
