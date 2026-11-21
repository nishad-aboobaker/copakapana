import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { IconComponent } from '../../shared/icon.component';
import { environment } from '../../../environments/environment';
import { AuthFrameComponent } from './auth-frame.component';
import { PinPadComponent } from './pin-pad.component';

interface WaiterOption {
  id: string;
  name: string;
}

const LAST_WAITER_KEY = 'waiter_last_name';

/** Waiter sign-in: tap your name, then enter your 4-digit PIN. */
@Component({
  selector: 'app-login-waiter',
  standalone: true,
  imports: [RouterLink, IconComponent, AuthFrameComponent, PinPadComponent],
  template: `
    <app-auth-frame
      [heading]="selected() ? 'Hi, ' + selected()!.name : 'Who is serving?'"
      [subheading]="selected() ? 'Enter your 4-digit PIN' : 'Tap your name to sign in'"
      pitchTitle="Take orders right at the table."
      pitchText="Send orders to the kitchen screens, see when food is ready and request the bill — all from your phone."
    >
      @if (!selected()) {
        @if (loading()) {
          <div class="people">
            @for (i of [1, 2, 3, 4, 5, 6]; track i) {
              <div class="skeleton" style="height: 92px; border-radius: 12px"></div>
            }
          </div>
        } @else if (loadError()) {
          <div class="empty-state">
            <div class="empty-icon"><app-icon name="wifi-off" /></div>
            <h3>Can't reach the server</h3>
            <p>Check that this phone is on the restaurant WiFi.</p>
            <button class="btn btn-primary" (click)="load()"><app-icon name="refresh" /> Try again</button>
          </div>
        } @else if (waiters().length === 0) {
          <div class="empty-state">
            <div class="empty-icon"><app-icon name="users" /></div>
            <h3>No waiters yet</h3>
            <p>Ask the owner to add waiter accounts under Staff &amp; screens.</p>
          </div>
        } @else {
          @if (waiters().length > 9) {
            <div class="input-group search">
              <app-icon name="search" />
              <input class="input" placeholder="Find your name" [value]="query()" (input)="query.set($any($event.target).value)" />
            </div>
          }
          <div class="people">
            @for (w of filtered(); track w.id) {
              <button type="button" class="person" [class.last]="w.name === lastName" (click)="choose(w)">
                <span class="avatar" [style.background]="color(w.name)">{{ initials(w.name) }}</span>
                <span class="name truncate">{{ w.name }}</span>
              </button>
            }
          </div>
        }
      } @else {
        <app-pin-pad
          [(value)]="pin"
          [autoSubmitAt]="4"
          [busy]="busy()"
          [disabled]="busy()"
          [error]="!!error()"
          (submit)="submit()"
          (changed)="error.set('')"
        />
        <p class="error-line" role="alert">{{ error() }}</p>
        <button type="button" class="btn btn-ghost btn-block" (click)="reset()">
          <app-icon name="arrow-left" /> Not {{ selected()!.name }}?
        </button>
      }

      <ng-container auth-links>
        <a routerLink="/login/pc"><app-icon name="receipt" [size]="15" /> Counter &amp; office sign-in</a>
        <a routerLink="/login/kitchen"><app-icon name="monitor" [size]="15" /> Kitchen station screen</a>
      </ng-container>
    </app-auth-frame>
  `,
  styles: [
    `
      .people { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.6rem; }
      .person {
        display: flex; flex-direction: column; align-items: center; gap: 0.5rem; padding: 0.9rem 0.4rem; min-height: 92px;
        border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); transition: all 0.12s;
      }
      .person:hover { border-color: var(--border-strong); background: var(--surface-muted); }
      .person:active { transform: scale(0.98); }
      .person.last { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-ring); }
      .avatar { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 0.95rem; }
      .name { font-size: var(--fs-sm); font-weight: 600; color: var(--text-strong); max-width: 100%; text-transform: capitalize; }
      .search { margin-bottom: 0.75rem; }
      .error-line { min-height: 1.4em; text-align: center; color: var(--danger); font-size: var(--fs-sm); font-weight: 600; margin: 0.75rem 0 0.25rem; }
      a { display: inline-flex; align-items: center; gap: 0.35rem; }
      @media (max-width: 360px) { .people { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    `,
  ],
})
export class LoginWaiterComponent implements OnInit {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private route = inject(ActivatedRoute);

  readonly waiters = signal<WaiterOption[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal(false);
  readonly query = signal('');
  readonly selected = signal<WaiterOption | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly pin = signal('');
  readonly lastName = localStorage.getItem(LAST_WAITER_KEY) ?? '';

  readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const list = q ? this.waiters().filter((w) => w.name.toLowerCase().includes(q)) : this.waiters();
    // The last person to sign in on this phone comes first
    return [...list].sort((a, b) => Number(b.name === this.lastName) - Number(a.name === this.lastName));
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.http.get<{ users: any[] }>(`${environment.apiUrl}/users?role=waiter`).subscribe({
      next: (res) => {
        this.waiters.set((res.users || []).map((u) => ({ id: u._id, name: u.name })));
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.loadError.set(true);
      },
    });
  }

  choose(w: WaiterOption): void {
    this.selected.set(w);
    this.pin.set('');
    this.error.set('');
  }

  reset(): void {
    this.selected.set(null);
    this.pin.set('');
    this.error.set('');
  }

  submit(): void {
    const w = this.selected();
    if (!w || this.pin().length < 4 || this.busy()) return;
    this.busy.set(true);
    this.auth.loginWaiter(w.name, this.pin()).subscribe({
      next: () => {
        this.busy.set(false);
        localStorage.setItem(LAST_WAITER_KEY, w.name);
        this.auth.goHome(this.route.snapshot.queryParamMap.get('returnUrl'));
      },
      error: (err) => {
        this.busy.set(false);
        this.pin.set('');
        const left = err.error?.attemptsLeft;
        this.error.set(
          err.status === 0
            ? "Can't reach the server"
            : err.status === 423
              ? err.error?.message || 'Too many attempts — locked for 5 minutes'
              : left !== undefined
                ? `Wrong PIN · ${left} attempt${left === 1 ? '' : 's'} left`
                : err.error?.message || 'Wrong PIN, try again',
        );
      },
    });
  }

  initials(name: string): string {
    return name
      .split(/\s+/)
      .map((p) => p[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  /** Stable colour per name so people recognise their own tile. */
  color(name: string): string {
    const palette = ['#e4572e', '#2f7d6d', '#5b5bd6', '#c2780a', '#b4417a', '#3f7cc4', '#7a5c3e', '#4f8a3a'];
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return palette[h % palette.length];
  }
}
