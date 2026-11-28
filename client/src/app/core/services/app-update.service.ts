import { Injectable, NgZone, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { filter } from 'rxjs';

/** How often an open screen asks the server whether a new version of the app is out. */
const CHECK_EVERY_MS = 5 * 60_000;

/**
 * Keeps every device on the latest version without anyone reloading by hand.
 * The app caches itself (so it works offline), which means a screen that is never
 * reloaded — a station tablet — would otherwise keep running an old version.
 *
 * - Station screens (/kds) switch to the new version on their own.
 * - Other screens show a "new version" bar, so nobody is interrupted mid-bill.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  private sw = inject(SwUpdate);
  private router = inject(Router);
  private zone = inject(NgZone);

  readonly updateReady = signal(false);

  start(): void {
    if (!this.sw.isEnabled) return;

    this.sw.versionUpdates.pipe(filter((e) => e.type === 'VERSION_READY')).subscribe(() => {
      if (this.router.url.startsWith('/kds')) this.reloadNow();
      else this.updateReady.set(true);
    });
    // The cached version is broken (e.g. files removed from the server): load fresh
    this.sw.unrecoverable.subscribe(() => this.reloadNow());

    const check = () => this.sw.checkForUpdate().catch(() => undefined);
    this.zone.runOutsideAngular(() => {
      setInterval(check, CHECK_EVERY_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    });
  }

  reloadNow(): void {
    document.location.reload();
  }
}
