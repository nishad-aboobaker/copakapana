import { Component, input } from '@angular/core';
import { IconComponent } from '../../shared/icon.component';

/**
 * Shared layout for the three sign-in screens: brand panel on wide screens,
 * a single centred card on phones.
 */
@Component({
  selector: 'app-auth-frame',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div class="auth">
      <aside class="auth-brand">
        <div class="brand-row">
          <div class="mark"><app-icon name="flame" [size]="22" /></div>
          <div>
            <strong>Copakapana</strong>
            <span>Restaurant POS</span>
          </div>
        </div>
        <div class="pitch">
          <h2>{{ pitchTitle() }}</h2>
          <p>{{ pitchText() }}</p>
        </div>
        <ul class="features">
          <li><app-icon name="send" [size]="16" /> Orders reach the kitchen screens in seconds</li>
          <li><app-icon name="wifi-off" [size]="16" /> Keeps working through WiFi drops</li>
          <li><app-icon name="receipt" [size]="16" /> Bills closed in under 30 seconds</li>
        </ul>
      </aside>

      <main class="auth-main">
        <div class="auth-card">
          <div class="mobile-brand">
            <div class="mark"><app-icon name="flame" [size]="18" /></div>
            <strong>Copakapana</strong>
          </div>
          <header class="auth-head">
            <h1>{{ heading() }}</h1>
            @if (subheading()) {
              <p>{{ subheading() }}</p>
            }
          </header>
          <ng-content />
        </div>
        <nav class="auth-switch">
          <ng-content select="[auth-links]" />
        </nav>
      </main>
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .auth { min-height: 100vh; min-height: 100dvh; display: grid; grid-template-columns: minmax(360px, 44%) 1fr; background: var(--bg); }
      .auth-brand {
        position: relative; overflow: hidden; color: #f3efe9; padding: 2.5rem 3rem; display: flex; flex-direction: column; justify-content: space-between;
        background:
          radial-gradient(circle at 15% 110%, rgba(228, 87, 46, 0.55), transparent 45%),
          radial-gradient(circle at 110% -10%, rgba(242, 166, 90, 0.35), transparent 40%),
          var(--gray-900);
      }
      .brand-row { display: flex; align-items: center; gap: 0.8rem; }
      .brand-row strong { display: block; font-size: 1.15rem; color: #fff; }
      .brand-row span { font-size: 0.8rem; color: #a39e97; }
      .mark { width: 42px; height: 42px; border-radius: 12px; background: var(--primary); color: #fff; display: grid; place-items: center; box-shadow: 0 8px 20px rgba(228, 87, 46, 0.4); }
      .pitch h2 { color: #fff; font-size: 2.1rem; line-height: 1.15; letter-spacing: -0.02em; max-width: 14ch; }
      .pitch p { margin-top: 0.9rem; color: #c8c3bc; max-width: 40ch; font-size: 1rem; }
      .features { list-style: none; display: flex; flex-direction: column; gap: 0.7rem; color: #c8c3bc; font-size: var(--fs-sm); }
      .features li { display: flex; align-items: center; gap: 0.65rem; }
      .features app-icon { color: #ffb59b; }

      .auth-main { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem 1.25rem; gap: 1.25rem; }
      .auth-card { width: 100%; max-width: 420px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-xl); box-shadow: var(--shadow); padding: 2rem; }
      .auth-head { margin-bottom: 1.5rem; }
      .auth-head h1 { font-size: 1.45rem; }
      .auth-head p { color: var(--text-muted); margin-top: 0.3rem; font-size: var(--fs-sm); }
      .mobile-brand { display: none; align-items: center; gap: 0.6rem; margin-bottom: 1.5rem; }
      .mobile-brand .mark { width: 34px; height: 34px; border-radius: 10px; box-shadow: none; }
      .auth-switch { display: flex; gap: 1.25rem; flex-wrap: wrap; justify-content: center; font-size: var(--fs-sm); }

      @media (max-width: 900px) {
        .auth { grid-template-columns: 1fr; }
        .auth-brand { display: none; }
        .mobile-brand { display: flex; }
      }
      @media (max-width: 480px) {
        .auth-main { justify-content: flex-start; padding: 1.25rem 1rem; }
        .auth-card { padding: 1.5rem 1.25rem; border-radius: var(--radius-lg); }
      }
    `,
  ],
})
export class AuthFrameComponent {
  heading = input.required<string>();
  subheading = input<string>('');
  pitchTitle = input<string>('Run the floor, the kitchen and the counter from one place.');
  pitchText = input<string>('Take orders at the table, send them straight to each kitchen station and settle bills in seconds.');
}
