import { Component, OnInit, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { AuthService, STATION_LABELS, Station } from '../../core/auth/auth.service';
import { IconComponent } from '../../shared/icon.component';
import { environment } from '../../../environments/environment';
import { AuthFrameComponent } from './auth-frame.component';
import { PinPadComponent } from './pin-pad.component';

interface ScreenAccount {
  name: string;
  station: Station;
}

const STATION_ICON: Record<Station, string> = { fried_chicken: 'flame', juice: 'sparkles', main: 'utensils' };
const LAST_KEY = 'kds_last_account';

/**
 * Sign-in for a kitchen station screen. The owner creates one station screen
 * account per station; this page is opened once on the station's tablet and
 * then stays signed in.
 */
@Component({
  selector: 'app-login-kitchen',
  standalone: true,
  imports: [RouterLink, IconComponent, AuthFrameComponent, PinPadComponent],
  template: `
    <app-auth-frame
      heading="Station screen"
      [subheading]="selected() ? 'Enter the PIN for ' + label(selected()!.station) : 'Which station is this screen for?'"
      pitchTitle="Every order, on the right station."
      pitchText="New tickets appear instantly with a chime. Tap Start, Ready and Clear as you cook — waiters are notified automatically."
    >
      @if (loading()) {
        <div class="stations">
          @for (i of [1, 2, 3]; track i) {
            <div class="skeleton" style="height: 76px; border-radius: 12px"></div>
          }
        </div>
      } @else if (loadError()) {
        <div class="empty-state">
          <div class="empty-icon"><app-icon name="wifi-off" /></div>
          <h3>Can't reach the server</h3>
          <p>Check this screen's WiFi connection.</p>
          <button class="btn btn-primary" (click)="load()"><app-icon name="refresh" /> Try again</button>
        </div>
      } @else if (accounts().length === 0) {
        <div class="empty-state">
          <div class="empty-icon"><app-icon name="monitor" /></div>
          <h3>No station screens set up</h3>
          <p>The owner adds one under Staff &amp; screens → Add, role "Kitchen station screen".</p>
        </div>
      } @else {
        <div class="stations" role="radiogroup" aria-label="Station">
          @for (a of accounts(); track a.name) {
            <button type="button" class="station" role="radio" [attr.aria-checked]="selected()?.name === a.name" [class.sel]="selected()?.name === a.name" (click)="select(a)">
              <span class="st-icon"><app-icon [name]="icon(a.station)" /></span>
              <span class="st-text">
                <strong>{{ label(a.station) }}</strong>
                <small>{{ a.name }}</small>
              </span>
              <span class="check"><app-icon name="check" [size]="16" /></span>
            </button>
          }
        </div>

        @if (selected()) {
          <div class="pin-wrap">
            <app-pin-pad
              [(value)]="pin"
              [minLength]="4"
              [maxLength]="6"
              [busy]="busy()"
              [disabled]="busy()"
              [error]="!!error()"
              (submit)="submit()"
              (changed)="error.set('')"
            />
            <p class="error-line" role="alert">{{ error() }}</p>
          </div>
        }
      }

      <ng-container auth-links>
        <a routerLink="/login/waiter"><app-icon name="utensils" [size]="15" /> Waiter sign-in</a>
        <a routerLink="/login/pc"><app-icon name="receipt" [size]="15" /> Counter &amp; office sign-in</a>
      </ng-container>
    </app-auth-frame>
  `,
  styles: [
    `
      .stations { display: flex; flex-direction: column; gap: 0.5rem; }
      .station {
        display: flex; align-items: center; gap: 0.85rem; min-height: 64px; padding: 0.6rem 0.9rem; text-align: left;
        border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); transition: all 0.12s;
      }
      .station:hover { border-color: var(--border-strong); }
      .station.sel { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-ring); }
      .st-icon { width: 40px; height: 40px; border-radius: 10px; background: var(--primary-soft); color: var(--primary); display: grid; place-items: center; flex-shrink: 0; }
      .st-text { display: flex; flex-direction: column; flex: 1; line-height: 1.25; }
      .st-text strong { color: var(--text-strong); }
      .st-text small { color: var(--text-muted); font-size: var(--fs-xs); }
      .check { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--border-strong); display: grid; place-items: center; color: transparent; }
      .sel .check { background: var(--primary); border-color: var(--primary); color: #fff; }
      .pin-wrap { margin-top: 1.25rem; padding-top: 1.25rem; border-top: 1px solid var(--border); }
      .error-line { min-height: 1.4em; text-align: center; color: var(--danger); font-size: var(--fs-sm); font-weight: 600; margin-top: 0.75rem; }
      a { display: inline-flex; align-items: center; gap: 0.35rem; }
    `,
  ],
})
export class LoginKitchenComponent implements OnInit {
  private http = inject(HttpClient);
  private auth = inject(AuthService);

  readonly accounts = signal<ScreenAccount[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal(false);
  readonly selected = signal<ScreenAccount | null>(null);
  readonly pin = signal('');
  readonly error = signal('');
  readonly busy = signal(false);

  ngOnInit(): void {
    // Signed-in users never reach this page — guestGuard sends them home.
    this.load();
  }

  label(s: Station): string {
    return STATION_LABELS[s] ?? s;
  }

  icon(s: Station): string {
    return STATION_ICON[s] ?? 'utensils';
  }

  load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.http.get<{ users: any[] }>(`${environment.apiUrl}/users?role=kitchen`).subscribe({
      next: (res) => {
        this.accounts.set((res.users || []).map((u) => ({ name: u.name, station: u.station })));
        this.loading.set(false);
        // Remember the last station used on this device
        const match = this.accounts().find((a) => a.name === localStorage.getItem(LAST_KEY));
        if (match) this.selected.set(match);
      },
      error: () => {
        this.loading.set(false);
        this.loadError.set(true);
      },
    });
  }

  select(a: ScreenAccount): void {
    this.selected.set(a);
    this.pin.set('');
    this.error.set('');
  }

  submit(): void {
    const acc = this.selected();
    if (!acc || this.pin().length < 4 || this.busy()) return;
    this.busy.set(true);
    this.auth.loginKitchen(acc.name, this.pin()).subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.user.role !== 'kitchen') {
          this.auth.logout({ redirect: false });
          this.error.set('That account is not a station screen');
          this.pin.set('');
          return;
        }
        localStorage.setItem(LAST_KEY, acc.name);
        this.auth.goHome();
      },
      error: (err) => {
        this.busy.set(false);
        this.pin.set('');
        this.error.set(err.status === 0 ? "Can't reach the server" : err.error?.message || 'Wrong PIN');
      },
    });
  }
}
