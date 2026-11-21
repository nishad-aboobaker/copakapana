import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { IconComponent } from '../../shared/icon.component';
import { AuthFrameComponent } from './auth-frame.component';

/** Password sign-in for cashier, manager and owner on the counter PC. */
@Component({
  selector: 'app-login-pc',
  // Angular 22 defaults to OnPush; this page keeps plain-field state updated by HTTP/socket callbacks
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent, AuthFrameComponent],
  template: `
    <app-auth-frame heading="Sign in" subheading="Cashier, manager and owner accounts">
      <form class="stack" (ngSubmit)="onSubmit()" novalidate>
        <div class="field">
          <label for="username">Username</label>
          <div class="input-group">
            <app-icon name="user" />
            <input
              id="username"
              name="username"
              class="input"
              autocomplete="username"
              autocapitalize="none"
              spellcheck="false"
              placeholder="e.g. owner"
              [(ngModel)]="username"
              (ngModelChange)="error.set('')"
              autofocus
              required
            />
          </div>
        </div>

        <div class="field">
          <label for="password">Password</label>
          <div class="input-group">
            <app-icon name="lock" />
            <input
              id="password"
              name="password"
              class="input"
              [type]="showPassword() ? 'text' : 'password'"
              autocomplete="current-password"
              placeholder="Your password"
              [(ngModel)]="password"
              (ngModelChange)="error.set('')"
              required
            />
            <button
              type="button"
              class="btn btn-ghost btn-icon btn-sm input-suffix"
              (click)="showPassword.set(!showPassword())"
              [attr.aria-label]="showPassword() ? 'Hide password' : 'Show password'"
            >
              <app-icon [name]="showPassword() ? 'eye-off' : 'eye'" [size]="17" />
            </button>
          </div>
        </div>

        @if (error()) {
          <div class="alert" [class.alert-warning]="locked()" [class.alert-danger]="!locked()" role="alert">
            <app-icon [name]="locked() ? 'lock' : 'alert-circle'" />
            <div class="alert-body">{{ error() }}</div>
          </div>
        }

        <button type="submit" class="btn btn-primary btn-lg btn-block" [disabled]="busy() || !username.trim() || !password">
          @if (busy()) {
            <span class="spinner"></span> Signing in…
          } @else {
            Sign in <app-icon name="arrow-right" />
          }
        </button>
      </form>

      <ng-container auth-links>
        <a routerLink="/login/waiter"><app-icon name="utensils" [size]="15" /> Waiter sign-in</a>
        <a routerLink="/login/kitchen"><app-icon name="monitor" [size]="15" /> Kitchen station screen</a>
      </ng-container>
    </app-auth-frame>
  `,
  styles: [`a { display: inline-flex; align-items: center; gap: 0.35rem; } form { gap: 1rem; }`],
})
export class LoginPCComponent {
  private auth = inject(AuthService);
  private route = inject(ActivatedRoute);

  username = '';
  password = '';
  readonly showPassword = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly locked = signal(false);

  onSubmit(): void {
    if (!this.username.trim() || !this.password || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.auth.loginPC(this.username.trim(), this.password).subscribe({
      next: () => {
        this.busy.set(false);
        this.auth.goHome(this.route.snapshot.queryParamMap.get('returnUrl'));
      },
      error: (err) => {
        this.busy.set(false);
        this.password = '';
        this.locked.set(err.status === 423);
        if (err.status === 0) this.error.set("Can't reach the server. Check the network connection.");
        else if (err.status === 423) this.error.set(err.error?.message || 'Account locked after too many attempts. Try again in 5 minutes.');
        else if (err.error?.attemptsLeft !== undefined)
          this.error.set(`Wrong username or password. ${err.error.attemptsLeft} attempt${err.error.attemptsLeft === 1 ? '' : 's'} left.`);
        else this.error.set(err.error?.message || 'Wrong username or password.');
      },
    });
  }
}
