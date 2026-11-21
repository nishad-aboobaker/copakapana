import { Component, HostListener, computed, input, model, output } from '@angular/core';
import { IconComponent } from '../../shared/icon.component';

/**
 * PIN entry: dots + large keypad. Also accepts the physical keyboard
 * (digits, Backspace, Enter) for tablets with keyboards and PCs.
 */
@Component({
  selector: 'app-pin-pad',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div class="pin-dots" [class.shake]="error()" [attr.aria-label]="value().length + ' of ' + maxLength() + ' digits entered'">
      @for (i of slots(); track i) {
        <span class="dot" [class.filled]="value().length > i" [class.optional]="i >= minLength()"></span>
      }
    </div>

    <div class="keypad" role="group" aria-label="PIN keypad">
      @for (d of digits; track d) {
        <button type="button" class="key" [disabled]="disabled()" (click)="press(d)">{{ d }}</button>
      }
      <button type="button" class="key key-muted" [disabled]="disabled() || !value().length" (click)="back()" aria-label="Delete digit">
        <app-icon name="backspace" [size]="22" />
      </button>
      <button type="button" class="key" [disabled]="disabled()" (click)="press('0')">0</button>
      <button
        type="button"
        class="key key-go"
        [disabled]="disabled() || value().length < minLength()"
        (click)="submit.emit(value())"
        aria-label="Sign in"
      >
        @if (busy()) {
          <span class="spinner"></span>
        } @else {
          <app-icon name="arrow-right" [size]="22" />
        }
      </button>
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .pin-dots { display: flex; justify-content: center; gap: 0.85rem; height: 20px; margin: 0.25rem 0 1.25rem; }
      .dot { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--gray-300); transition: all 0.12s var(--ease); }
      .dot.filled { background: var(--primary); border-color: var(--primary); transform: scale(1.1); }
      .dot.optional:not(.filled) { border-style: dashed; opacity: 0.6; }
      .shake { animation: shake 0.35s; }
      .shake .dot { border-color: var(--danger); }
      @keyframes shake { 20%, 60% { transform: translateX(-7px); } 40%, 80% { transform: translateX(7px); } }
      .keypad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.6rem; }
      .key {
        height: 60px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface-muted);
        font-size: 1.4rem; font-weight: 600; color: var(--text-strong); display: grid; place-items: center;
        transition: background 0.1s, transform 0.05s;
      }
      .key:hover:not(:disabled) { background: var(--gray-100); }
      .key:active:not(:disabled) { transform: scale(0.97); background: var(--gray-200); }
      .key:disabled { opacity: 0.45; cursor: not-allowed; }
      .key-muted { color: var(--text-muted); }
      .key-go { background: var(--primary); border-color: var(--primary); color: #fff; }
      .key-go:hover:not(:disabled) { background: var(--primary-hover); }
      .key-go .spinner { width: 22px; height: 22px; }
    `,
  ],
})
export class PinPadComponent {
  readonly digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

  value = model<string>('');
  minLength = input(4);
  maxLength = input(4);
  /** Submit automatically once this many digits are entered (0 = never) */
  autoSubmitAt = input(0);
  disabled = input(false);
  busy = input(false);
  error = input(false);
  submit = output<string>();
  changed = output<void>();

  slots = computed(() => Array.from({ length: this.maxLength() }, (_, i) => i));

  press(d: string): void {
    if (this.disabled() || this.value().length >= this.maxLength()) return;
    this.value.set(this.value() + d);
    this.changed.emit();
    if (this.autoSubmitAt() && this.value().length === this.autoSubmitAt()) this.submit.emit(this.value());
  }

  back(): void {
    this.value.set(this.value().slice(0, -1));
    this.changed.emit();
  }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    if (/^[0-9]$/.test(e.key)) {
      this.press(e.key);
      e.preventDefault();
    } else if (e.key === 'Backspace') {
      this.back();
      e.preventDefault();
    } else if (e.key === 'Enter' && this.value().length >= this.minLength() && !this.disabled()) {
      this.submit.emit(this.value());
    }
  }
}
