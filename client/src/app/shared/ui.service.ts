import { Injectable, signal } from '@angular/core';

export type ToastKind = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  title?: string;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  /** Red confirm button for destructive actions */
  danger?: boolean;
  /** Ask for a typed reason (returned instead of `true`) */
  reason?: { label: string; placeholder?: string; required?: boolean };
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean | string) => void;
}

/**
 * App-wide feedback: toasts and confirm dialogs, rendered once by
 * <app-ui-host> in the root component. Replaces per-page toast code and
 * window.confirm().
 */
@Injectable({ providedIn: 'root' })
export class UiService {
  readonly toasts = signal<Toast[]>([]);
  readonly confirmState = signal<PendingConfirm | null>(null);
  private seq = 0;

  toast(message: string, kind: ToastKind = 'info', title?: string, ms = 3800): void {
    const id = ++this.seq;
    this.toasts.update((list) => [...list.slice(-3), { id, kind, message, title }]);
    setTimeout(() => this.dismiss(id), ms);
  }

  success(message: string, title?: string): void {
    this.toast(message, 'success', title);
  }

  error(message: string, title?: string): void {
    this.toast(message, 'error', title, 5500);
  }

  warning(message: string, title?: string): void {
    this.toast(message, 'warning', title, 5000);
  }

  info(message: string, title?: string): void {
    this.toast(message, 'info', title);
  }

  /** Pulls the server's `{ message }` out of an HttpErrorResponse. */
  apiError(err: any, fallback = 'Something went wrong'): void {
    const msg = err?.status === 0 ? 'Cannot reach the server — check the connection' : err?.error?.message || fallback;
    this.error(msg);
  }

  dismiss(id: number): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }

  /** Resolves true/false, or the typed reason when `reason` is set (false if cancelled). */
  confirm(options: ConfirmOptions): Promise<boolean | string> {
    return new Promise((resolve) => this.confirmState.set({ ...options, resolve }));
  }

  /** Called by the host. */
  settleConfirm(value: boolean | string): void {
    const pending = this.confirmState();
    this.confirmState.set(null);
    pending?.resolve(value);
  }
}
