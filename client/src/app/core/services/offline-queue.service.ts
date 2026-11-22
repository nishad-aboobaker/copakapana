import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject, firstValueFrom, fromEvent, merge, of } from 'rxjs';
import { map } from 'rxjs/operators';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';

export interface QueuedOrder {
  id: string;
  clientRequestId: string;
  type: 'create_order' | 'add_items';
  orderId?: string;
  payload: any;
  createdAt: number;
  retryCount: number;
}

const QUEUE_KEY = 'pos_offline_queue';
const LEGACY_QUEUE_KEY = 'kot_offline_queue';

@Injectable({
  providedIn: 'root',
})
export class OfflineQueueService {
  private isOnlineSubject = new BehaviorSubject<boolean>(navigator.onLine);
  public isOnline$ = this.isOnlineSubject.asObservable();

  private queueSubject = new BehaviorSubject<QueuedOrder[]>(this.getStoredQueue());
  public queue$ = this.queueSubject.asObservable();

  /** Queued requests the server rejected permanently (shown to the waiter). */
  private failedSubject = new Subject<{ item: QueuedOrder; message: string }>();
  public failed$ = this.failedSubject.asObservable();

  constructor(private http: HttpClient) {
    // Monitor online/offline state
    merge(
      of(navigator.onLine),
      fromEvent(window, 'online').pipe(map(() => true)),
      fromEvent(window, 'offline').pipe(map(() => false))
    ).subscribe((online) => {
      this.isOnlineSubject.next(online);
      if (online) {
        this.drainQueue();
      }
    });
  }

  public get isOnline(): boolean {
    return this.isOnlineSubject.value;
  }

  public get queue(): QueuedOrder[] {
    return this.queueSubject.value;
  }

  public enqueue(item: Omit<QueuedOrder, 'id' | 'createdAt' | 'retryCount'>): void {
    const queue = this.getStoredQueue();
    const queuedItem: QueuedOrder = {
      ...item,
      id: 'queue_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      createdAt: Date.now(),
      retryCount: 0,
    };

    queue.push(queuedItem);
    this.saveQueue(queue);
    console.log('📦 Order saved to offline queue:', queuedItem.clientRequestId);

    if (this.isOnline) {
      this.drainQueue();
    }
  }

  private draining = false;

  /**
   * Sends queued requests in order. Both create-order and add-items carry the
   * same clientRequestId on every retry, so the server never applies one twice.
   * - Network / 5xx errors: stop and retry on the next reconnect.
   * - 4xx errors (e.g. table taken, item unavailable): the request can never
   *   succeed, so it is dropped and reported via `failed$` instead of blocking
   *   every order queued behind it.
   */
  public async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const item of this.getStoredQueue()) {
        try {
          if (item.type === 'create_order') {
            await firstValueFrom(this.http.post(`${environment.apiUrl}/orders`, item.payload));
          } else if (item.type === 'add_items' && item.orderId) {
            await firstValueFrom(
              this.http.post(`${environment.apiUrl}/orders/${item.orderId}/items`, {
                ...item.payload,
                clientRequestId: item.payload?.clientRequestId ?? item.clientRequestId,
              }),
            );
          }
          this.remove(item.id);
          console.log(`✅ Offline queued item [${item.clientRequestId}] synchronized.`);
        } catch (err: any) {
          const status = err?.status ?? 0;
          if (status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429) {
            this.remove(item.id);
            this.failedSubject.next({ item, message: err.error?.message || `Request rejected (${status})` });
            console.warn(`⛔ Dropped queued item [${item.clientRequestId}]: ${status}`);
            continue;
          }
          // Re-read storage so items removed above are not written back
          this.saveQueue(
            this.getStoredQueue().map((q) => (q.id === item.id ? { ...q, retryCount: q.retryCount + 1 } : q)),
          );
          console.warn(`⚠️ Offline queue retry failed for [${item.clientRequestId}].`);
          break;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private remove(id: string): void {
    this.saveQueue(this.getStoredQueue().filter((q) => q.id !== id));
  }

  private getStoredQueue(): QueuedOrder[] {
    // Older versions stored the queue under 'kot_offline_queue'; keep reading it so no order is lost
    const data = localStorage.getItem(QUEUE_KEY) ?? localStorage.getItem(LEGACY_QUEUE_KEY);
    if (!data) return [];
    try {
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  private saveQueue(queue: QueuedOrder[]): void {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    localStorage.removeItem(LEGACY_QUEUE_KEY);
    this.queueSubject.next(queue);
  }
}
