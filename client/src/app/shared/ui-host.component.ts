import { Component, HostListener, effect, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from './icon.component';
import { UiService } from './ui.service';

const TOAST_ICON = { success: 'check-circle', error: 'alert-circle', warning: 'alert', info: 'info' } as const;

/** Renders toasts and the confirm dialog. Mounted once in the root component. */
@Component({
  selector: 'app-ui-host',
  standalone: true,
  imports: [IconComponent, FormsModule],
  template: `
    <div class="toast-host" aria-live="polite">
      @for (t of ui.toasts(); track t.id) {
        <div class="toast" [class]="'toast toast-' + t.kind" role="status">
          <app-icon [name]="icon(t.kind)" />
          <div class="toast-msg">
            @if (t.title) {
              <div class="toast-title">{{ t.title }}</div>
            }
            {{ t.message }}
          </div>
          <button type="button" (click)="ui.dismiss(t.id)" aria-label="Dismiss"><app-icon name="x" [size]="16" /></button>
        </div>
      }
    </div>

    @if (ui.confirmState(); as c) {
      <div class="modal-backdrop" (click)="cancel()">
        <div class="modal" role="alertdialog" aria-modal="true" [attr.aria-label]="c.title" (click)="$event.stopPropagation()">
          <div class="modal-header">
            <div class="confirm-head">
              <span class="confirm-icon" [class.danger]="c.danger"><app-icon [name]="c.danger ? 'alert' : 'info'" /></span>
              <div>
                <h3>{{ c.title }}</h3>
                @if (c.message) {
                  <p>{{ c.message }}</p>
                }
              </div>
            </div>
          </div>
          @if (c.reason) {
            <div class="modal-body">
              <div class="field">
                <label for="confirm-reason">{{ c.reason.label }}</label>
                <textarea
                  id="confirm-reason"
                  class="textarea"
                  rows="3"
                  [placeholder]="c.reason.placeholder || ''"
                  [(ngModel)]="reasonText"
                  autofocus
                ></textarea>
              </div>
            </div>
          }
          <div class="modal-footer">
            <button type="button" class="btn" (click)="cancel()">{{ c.cancelText || 'Cancel' }}</button>
            <button
              type="button"
              class="btn"
              [class.btn-danger]="c.danger"
              [class.btn-primary]="!c.danger"
              [disabled]="c.reason?.required !== false && !!c.reason && !reasonText.trim()"
              (click)="ok()"
            >
              {{ c.confirmText || 'Confirm' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .confirm-head { display: flex; gap: 0.85rem; align-items: flex-start; }
      .confirm-icon { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; flex-shrink: 0; background: var(--info-soft); color: var(--info); }
      .confirm-icon.danger { background: var(--danger-soft); color: var(--danger); }
      .modal-header { padding-bottom: 0.5rem; }
    `,
  ],
})
export class UiHostComponent {
  ui = inject(UiService);
  reasonText = '';

  constructor() {
    // Reset the reason box each time a dialog opens
    effect(() => {
      if (this.ui.confirmState()) this.reasonText = '';
    });
  }

  icon(kind: keyof typeof TOAST_ICON): string {
    return TOAST_ICON[kind];
  }

  ok(): void {
    const c = this.ui.confirmState();
    this.ui.settleConfirm(c?.reason ? this.reasonText.trim() : true);
  }

  cancel(): void {
    this.ui.settleConfirm(false);
  }

  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (this.ui.confirmState()) this.cancel();
  }
}
