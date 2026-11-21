import { Injectable, ApplicationRef } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';
import { AuthService } from '../auth/auth.service';

/**
 * One Socket.IO connection per signed-in user (waiter phone, cashier PC or
 * kitchen station screen).
 *
 * - `auth` is a function, so every reconnect sends the *current* access token
 *   (station screens stay connected all day across 15-minute token expiry).
 * - An auth rejection triggers a token refresh and reconnect.
 * - `fromEvent` works even if called before the socket exists: listeners are
 *   kept and re-attached whenever a new socket is created.
 */
@Injectable({
  providedIn: 'root',
})
export class SocketService {
  private socket: Socket | null = null;
  private listeners = new Map<string, Set<(data: any) => void>>();
  private refreshing = false;

  private connectedSubject = new BehaviorSubject<boolean>(false);
  public connected$ = this.connectedSubject.asObservable();

  /** Fires after every successful (re)connect — use it to resync state. */
  private reconnectSubject = new BehaviorSubject<number>(0);
  public reconnect$ = this.reconnectSubject.asObservable();

  constructor(
    private authService: AuthService,
    private appRef: ApplicationRef,
  ) {
    this.authService.currentUser$.subscribe((user) => {
      if (user && this.authService.token) {
        this.connect();
      } else {
        this.disconnect();
      }
    });
  }

  public get isConnected(): boolean {
    return this.connectedSubject.value;
  }

  public connect(): void {
    if (this.socket) return;

    const socket = io(environment.wsUrl, {
      auth: (cb) => cb({ token: this.authService.token }),
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    this.socket = socket;

    // Re-attach every registered listener to the new socket
    for (const [event, handlers] of this.listeners.entries()) {
      for (const h of handlers) socket.on(event, h);
    }

    socket.on('connect', () => {
      this.connectedSubject.next(true);
      this.reconnectSubject.next(this.reconnectSubject.value + 1);
      this.tick();
    });

    socket.on('disconnect', (reason) => {
      this.connectedSubject.next(false);
      this.tick();
      // Server-initiated disconnects are not retried automatically by socket.io
      if (reason === 'io server disconnect') socket.connect();
    });

    socket.on('connect_error', (err) => {
      this.connectedSubject.next(false);
      this.tick();
      if (/token/i.test(err.message) && !this.refreshing) {
        // Access token expired while offline — refresh, then reconnect
        this.refreshing = true;
        this.authService.refreshToken().subscribe({
          next: () => {
            this.refreshing = false;
            socket.connect();
          },
          error: () => {
            this.refreshing = false;
            this.authService.logout();
          },
        });
      }
    });
  }

  public disconnect(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.connectedSubject.next(false);
  }

  /** Emit with an optional acknowledgement callback. */
  public emit(event: string, data: unknown, ack?: (...args: any[]) => void): void {
    if (!this.socket) return;
    if (ack) this.socket.emit(event, data, ack);
    else this.socket.emit(event, data);
  }

  public fromEvent<T>(eventName: string): Observable<T> {
    return new Observable<T>((observer) => {
      const handler = (data: T) => {
        observer.next(data);
        this.tick();
      };

      let set = this.listeners.get(eventName);
      if (!set) {
        set = new Set();
        this.listeners.set(eventName, set);
      }
      set.add(handler);
      this.socket?.on(eventName, handler);

      return () => {
        this.listeners.get(eventName)?.delete(handler);
        this.socket?.off(eventName, handler);
      };
    });
  }

  private tick(): void {
    queueMicrotask(() => {
      try {
        this.appRef.tick();
      } catch {
        // already ticking
      }
    });
  }
}
