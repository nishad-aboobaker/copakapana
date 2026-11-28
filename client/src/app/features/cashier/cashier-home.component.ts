import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../../environments/environment';
import { SocketService } from '../../core/socket/socket.service';
import { AuthService } from '../../core/auth/auth.service';
import { IconComponent } from '../../shared/icon.component';
import { UiService } from '../../shared/ui.service';

interface OrderSummary {
  _id: string;
  number: number;
  type: 'dine_in' | 'takeaway' | 'delivery';
  status: 'open' | 'billed' | 'paid' | 'cancelled';
  tableId?: { _id: string; name?: string; number: string | number; floor: string; status?: string };
  waiterId?: { name: string };
  customerSnapshot?: { name: string; phone: string; address?: string };
  items: any[];
  createdAt: string;
  /** Delivery orders: rider progress and what the rider collected */
  delivery?: {
    status: 'waiting' | 'out' | 'delivered';
    riderName?: string;
    outAt?: string;
    deliveredAt?: string;
    collectedMode?: 'cash' | 'upi' | 'prepaid';
    collectedAmount?: number;
  };
}

interface DaySummary {
  bills: number;
  total: number;
  cash: number;
  upi: number;
  discount: number;
  openOrders: number;
}

interface BusinessDayInfo {
  date: string;
  open: boolean;
  summary: DaySummary;
  lastClosed: { date: string; closedByName?: string } | null;
}

interface BillData {
  _id: string;
  number: number;
  orderId: string | any;
  subtotal: number;
  discountAmount: number;
  discount?: { type: string; value: number; reason: string; appliedBy?: string };
  gst: number;
  serviceCharge: number;
  total: number;
  payments: any[];
  status: 'open' | 'paid' | 'void';
  itemsSnapshot: any[];
  paidAt?: string;
}

type PayMode = 'cash' | 'upi' | 'split';
type TypeFilter = 'all' | 'dine_in' | 'takeaway' | 'delivery';

const STATION_NAMES: Record<string, string> = { fried_chicken: 'Fried Chicken', juice: 'Juice', main: 'Main Kitchen' };

/**
 * Billing desk: open orders on the left, the selected order's bill in the
 * middle, payment on the right. Kitchen screen / printer health on top.
 */
@Component({
  selector: 'app-cashier-home',
  // Angular 22 defaults to OnPush; this page keeps plain-field state updated by HTTP/socket callbacks
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: true,
  imports: [FormsModule, IconComponent],
  template: `
    <div class="desk">
      <!-- ─── Header ─── -->
      <header class="desk-head">
        <div>
          <h1 class="page-title">Billing desk</h1>
          <div class="devices">
            @for (st of stationKeys; track st) {
              <span class="device" [class.off]="!stationStatus[st]?.online" [attr.title]="stationStatus[st]?.online ? 'Station screen online' : 'Station screen offline'">
                <app-icon name="monitor" [size]="14" /> {{ stationNames[st] }}
              </span>
            }
            <span class="device" [class.off]="!agentOnline" [attr.title]="agentOnline ? 'Bill printer agent online' : 'Bill printer agent offline'">
              <app-icon name="printer" [size]="14" /> Printer
            </span>
          </div>
        </div>
        <div class="page-actions">
          @if (businessDay) {
            <span class="day-chip" title="Sales are saved under this date until you close the counter">
              <app-icon name="calendar" [size]="14" /> {{ dayLabel(businessDay.date) }}
            </span>
          }
          <button class="btn" (click)="openCloseCounter()"><app-icon name="lock" /> Close counter</button>
          <button class="btn" (click)="openLookup()"><app-icon name="search" /> Find order or bill</button>
          <button class="btn btn-ghost btn-icon" (click)="refreshAll()" title="Refresh" aria-label="Refresh"><app-icon name="refresh" /></button>
        </div>
      </header>

      <!-- ─── Alerts ─── -->
      @if (offlineStations.length || undeliveredTickets.length || failedJobs.length) {
        <div class="alerts">
          @if (offlineStations.length) {
            <div class="alert alert-danger">
              <app-icon name="monitor" />
              <div class="alert-body">
                <span class="alert-title">Station screen offline: {{ offlineStationNames }}.</span>
                New tickets are saved and appear when it reconnects — tell the kitchen if it's urgent.
              </div>
            </div>
          }
          @if (undeliveredTickets.length) {
            <div class="alert alert-warning">
              <app-icon name="alert" />
              <div class="alert-body">
                <div class="alert-line">
                  <span class="alert-title">{{ undeliveredTickets.length }} ticket{{ undeliveredTickets.length === 1 ? '' : 's' }} not shown on a kitchen screen</span>
                  <span class="spacer"></span>
                  <button class="btn btn-sm btn-ghost" (click)="showUndelivered = !showUndelivered">{{ showUndelivered ? 'Hide' : 'Details' }}</button>
                  <button class="btn btn-sm" (click)="resendAll()"><app-icon name="send" /> Resend all</button>
                </div>
                @if (showUndelivered) {
                  <div class="alert-items">
                    @for (k of undeliveredTickets.slice(0, 8); track k._id) {
                      <span class="alert-item">
                        {{ stationNames[k.station] || k.station }} · #{{ k.number }} · Order {{ k.context?.orderNumber }}{{ k.context?.tableLabel ? ' · ' + tableLabel(k.context.tableLabel) : '' }}
                        <button class="btn btn-sm" (click)="resendTicketById(k._id)"><app-icon name="send" /> Resend</button>
                      </span>
                    }
                    @if (undeliveredTickets.length > 8) { <span class="text-sm">+{{ undeliveredTickets.length - 8 }} more</span> }
                  </div>
                }
              </div>
            </div>
          }
          @if (failedJobs.length) {
            <div class="alert alert-danger">
              <app-icon name="printer" />
              <div class="alert-body">
                <span class="alert-title">{{ failedJobs.length }} bill print{{ failedJobs.length === 1 ? '' : 's' }} failed — check the counter printer's paper and power.</span>
                <div class="alert-items">
                  @for (j of failedJobs; track j._id) {
                    <span class="alert-item">
                      {{ j.type === 'test' ? 'Test print' : 'Bill #' + (j.payload?.number ?? '') }} · {{ j.lastError }}
                      <button class="btn btn-sm" (click)="retryPrintJob(j._id)"><app-icon name="printer" /> Print again</button>
                    </span>
                  }
                </div>
              </div>
            </div>
          }
        </div>
      }

      <!-- ─── Workspace ─── -->
      <div class="work" [class.has-selection]="!!selectedOrder">
        <!-- Orders -->
        <aside class="orders card">
          <div class="orders-tools">
            <div class="input-group">
              <app-icon name="search" />
              <input class="input" type="search" placeholder="Order #, table or customer" [(ngModel)]="query" />
            </div>
            <div class="segmented filter">
              @for (f of typeFilters; track f.key) {
                <button [class.active]="selectedType === f.key" (click)="selectedType = f.key">
                  {{ f.label }} <span class="fcount">{{ countType(f.key) }}</span>
                </button>
              }
            </div>
          </div>

          <div class="orders-list">
            @if (ordersLoading) {
              @for (i of [1, 2, 3, 4]; track i) {
                <div class="skeleton" style="height: 74px; margin: 0.5rem"></div>
              }
            } @else if (filteredOrders.length === 0) {
              <div class="empty-state">
                <div class="empty-icon"><app-icon name="receipt" /></div>
                <h3>{{ query.trim() ? 'No matching orders' : 'No open orders' }}</h3>
                <p>{{ query.trim() ? 'Try another order number, table or name.' : 'New orders from waiters appear here instantly.' }}</p>
              </div>
            } @else {
              @for (ord of filteredOrders; track ord._id) {
                <button class="ord" [class.sel]="selectedOrder?._id === ord._id" (click)="selectOrder(ord)">
                  <span class="ord-badge" [class]="'ord-badge ' + ord.type">
                    @if (ord.type === 'dine_in') {
                      {{ ord.tableId?.name || ord.tableId?.number }}
                    } @else {
                      <app-icon [name]="ord.type === 'delivery' ? 'bike' : 'bag'" [size]="18" />
                    }
                  </span>
                  <span class="ord-main">
                    <span class="ord-title">
                      <strong class="truncate">{{ orderLabel(ord) }}</strong>
                      @if (statusOf(ord); as st) {
                        <span class="badge" [class]="'badge ' + st.cls">{{ st.label }}</span>
                      }
                    </span>
                    <small>#{{ ord.number }} · {{ ord.waiterId?.name || '—' }} · {{ elapsed(ord.createdAt) }}</small>
                  </span>
                  <span class="ord-amt num">₹{{ orderTotal(ord) }}</span>
                </button>
              }
            }
          </div>
        </aside>

        <!-- Bill -->
        <section class="bill card">
          @if (!selectedOrder) {
            <div class="empty-state big">
              <div class="empty-icon"><app-icon name="receipt" /></div>
              <h3>Select an order</h3>
              <p>Pick an order on the left to review it, generate the bill and take payment.</p>
              @if (lastClosed) {
                <div class="last-closed">
                  <app-icon name="check-circle" class="text-success" />
                  <span>Bill #{{ lastClosed.number }} paid · <strong class="num">₹{{ lastClosed.total }}</strong>
                    @if (lastClosed.change > 0) { · change <strong class="num">₹{{ lastClosed.change }}</strong> }
                  </span>
                  <button class="btn btn-sm" (click)="reprintBillById(lastClosed.id)"><app-icon name="printer" /> Reprint</button>
                </div>
              }
            </div>
          } @else {
            <div class="bill-head">
              <button class="btn btn-ghost btn-icon back" (click)="clearSelection()" aria-label="Back to orders"><app-icon name="arrow-left" /></button>
              <div class="bh-main">
                <h2>{{ orderLabel(selectedOrder) }}</h2>
                <div class="bh-meta">
                  <span>Order #{{ selectedOrder.number }}</span>
                  <span>{{ typeLabel(selectedOrder.type) }}</span>
                  <span><app-icon name="user" [size]="13" /> {{ selectedOrder.waiterId?.name || '—' }}</span>
                  <span><app-icon name="clock" [size]="13" /> {{ elapsed(selectedOrder.createdAt) }}</span>
                </div>
                @if (selectedOrder.customerSnapshot?.phone) {
                  <div class="bh-cust">
                    <app-icon name="phone" [size]="13" /> {{ selectedOrder.customerSnapshot!.name }} · {{ selectedOrder.customerSnapshot!.phone }}
                    @if (selectedOrder.customerSnapshot!.address) {
                      <span><app-icon name="pin" [size]="13" /> {{ selectedOrder.customerSnapshot!.address }}</span>
                    }
                  </div>
                }
              </div>
              @if (activeBill) {
                <span class="badge badge-dark">Bill #{{ activeBill.number }}</span>
              }
            </div>

            <div class="lines">
              <table class="table">
                <thead>
                  <tr><th>Item</th><th class="text-right">Qty</th><th class="text-right">Rate</th><th class="text-right">Amount</th></tr>
                </thead>
                <tbody>
                  @for (it of billLines; track $index) {
                    <tr [class.cancelled]="it.status === 'cancelled'">
                      <td>
                        <span class="text-strong">{{ it.name }}</span>
                        @if (it.portion) { <span class="text-muted"> · {{ it.portion }}</span> }
                        @if (it.status === 'cancelled') { <span class="badge badge-danger">Cancelled</span> }
                      </td>
                      <td class="text-right num">{{ it.qty }}</td>
                      <td class="text-right num">₹{{ it.price }}</td>
                      <td class="text-right num text-strong">₹{{ it.price * it.qty }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>

            <div class="totals">
              <div class="t-row"><span>Subtotal</span><span class="num">₹{{ activeBill ? activeBill.subtotal : orderTotal(selectedOrder) }}</span></div>
              @if (activeBill) {
                @if (activeBill.discountAmount > 0) {
                  <div class="t-row discount">
                    <span>Discount <small>· {{ activeBill.discount?.reason }}</small></span>
                    <span class="num">−₹{{ activeBill.discountAmount }}</span>
                  </div>
                } @else if (activeBill.status === 'open') {
                  <div class="t-row">
                    <button class="btn btn-ghost btn-sm add-disc" (click)="openDiscount()"><app-icon name="percent" /> Add discount</button>
                    <span></span>
                  </div>
                }
                @if (activeBill.gst > 0) {
                  <div class="t-row"><span>GST</span><span class="num">₹{{ activeBill.gst }}</span></div>
                }
                @if (activeBill.serviceCharge > 0) {
                  <div class="t-row"><span>Service charge</span><span class="num">₹{{ activeBill.serviceCharge }}</span></div>
                }
              }
              <div class="t-row grand"><span>Total</span><span class="num">₹{{ activeBill ? activeBill.total : orderTotal(selectedOrder) }}</span></div>
            </div>
          }
        </section>

        <!-- Payment -->
        @if (selectedOrder) {
          <section class="pay card">
            @if (!activeBill && !hasBillableItems(selectedOrder)) {
              <!-- Every item was cancelled: nothing to bill, just close it -->
              <div class="pay-cta">
                <div class="alert alert-warning">
                  <app-icon name="info" />
                  <div class="alert-body">
                    <span class="alert-title">Nothing to bill.</span>
                    Every item on this order was cancelled. Close the order to free {{ selectedOrder.tableId ? 'the table' : 'it from the list' }}.
                  </div>
                </div>
                <button class="btn btn-primary btn-xl btn-block" [disabled]="busy" (click)="closeEmptyOrder()">
                  @if (busy) { <span class="spinner"></span> } @else { <app-icon name="check" /> }
                  Close order{{ selectedOrder.tableId ? ' & free table' : '' }}
                </button>
              </div>
            } @else if (!activeBill) {
              <div class="pay-cta">
                <div class="pay-due">
                  <span>Amount</span>
                  <strong class="num">₹{{ orderTotal(selectedOrder) }}</strong>
                </div>
                <p class="text-muted text-sm">Generating the bill prints it, locks the items and marks the table as billing. Payment is saved later with <strong>Settle &amp; save</strong>.</p>
                <button class="btn btn-primary btn-xl btn-block" [disabled]="busy" (click)="generateBillForOrder()">
                  @if (busy) { <span class="spinner"></span> } @else { <app-icon name="receipt" /> } Generate &amp; print bill
                </button>
                <button class="btn btn-ghost btn-block cancel-order" [disabled]="busy" (click)="cancelWholeOrder()">
                  <app-icon name="ban" /> Cancel order
                </button>
              </div>
            } @else if (activeBill.status === 'open') {
              <div class="pay-due">
                <span>Amount due</span>
                <strong class="num">₹{{ activeBill.total }}</strong>
              </div>

              @if (selectedOrder.type !== 'delivery') {
                <button class="btn btn-block print-open" (click)="reprintBillById(activeBill._id)">
                  <app-icon name="printer" /> Print bill again
                </button>
              }

              @if (selectedOrder.type === 'delivery') {
                <div class="delivery-slip">
                  <button class="btn btn-lg btn-block" [disabled]="printingSlip" (click)="printDeliveryBill(activeBill._id)">
                    @if (printingSlip) { <span class="spinner"></span> } @else { <app-icon name="bike" /> } Print delivery bill again
                  </button>
                  <p class="text-muted text-sm">The delivery bill printed when you generated the bill. Send it with the rider — it shows the address and the amount to collect. Settle below when the money comes back.</p>
                </div>
                @if (riderCollection) {
                  <div class="rider-collected">
                    <app-icon name="check-circle" />
                    <div><strong>Delivered — rider collected {{ riderCollection }}</strong><span>Check the money, then settle.</span></div>
                  </div>
                } @else if (selectedOrder.delivery?.status === 'out') {
                  <div class="rider-collected out"><app-icon name="bike" /><div><strong>On the way</strong><span>{{ selectedOrder.delivery?.riderName }} picked it up.</span></div></div>
                }
              }

              <div class="segmented full">
                <button [class.active]="payMode === 'cash'" (click)="setPayMode('cash')"><app-icon name="cash" /> Cash</button>
                <button [class.active]="payMode === 'upi'" (click)="setPayMode('upi')"><app-icon name="qr" /> UPI</button>
                <button [class.active]="payMode === 'split'" (click)="setPayMode('split')"><app-icon name="layers" /> Split</button>
              </div>

              @if (payMode === 'cash') {
                <div class="field">
                  <label for="tendered">Cash received</label>
                  <div class="input-group">
                    <span class="input-prefix-text">₹</span>
                    <input id="tendered" class="input input-lg num" type="number" min="0" inputmode="numeric" [(ngModel)]="cashTendered" (ngModelChange)="calculateChange()" />
                  </div>
                </div>
                <div class="quick-amts">
                  @for (a of quickAmounts; track a) {
                    <button class="btn btn-sm" [class.btn-soft]="cashTendered === a" (click)="cashTendered = a; calculateChange()">
                      {{ a === activeBill.total ? 'Exact' : '₹' + a }}
                    </button>
                  }
                </div>
                <div class="change" [class.short]="cashTendered < activeBill.total">
                  <span>{{ cashTendered < activeBill.total ? 'Still due' : 'Change to return' }}</span>
                  <strong class="num">₹{{ cashTendered < activeBill.total ? activeBill.total - (cashTendered || 0) : cashChange }}</strong>
                </div>
              }

              @if (payMode === 'upi') {
                <div class="upi-note">
                  <app-icon name="qr" [size]="28" />
                  <div>
                    <strong>Collect ₹{{ activeBill.total }} by UPI</strong>
                    <span class="text-muted text-sm">Confirm the payment on your UPI app before settling.</span>
                  </div>
                </div>
              }

              @if (payMode === 'split') {
                <div class="grid-2">
                  <div class="field">
                    <label for="split-cash">Cash</label>
                    <div class="input-group">
                      <span class="input-prefix-text">₹</span>
                      <input id="split-cash" class="input num" type="number" min="0" [(ngModel)]="cashAmount" (ngModelChange)="onSplitCash()" />
                    </div>
                  </div>
                  <div class="field">
                    <label for="split-upi">UPI</label>
                    <div class="input-group">
                      <span class="input-prefix-text">₹</span>
                      <input id="split-upi" class="input num" type="number" min="0" [(ngModel)]="upiAmount" />
                    </div>
                  </div>
                </div>
                <div class="change" [class.short]="!isPaymentSufficient">
                  <span>{{ isPaymentSufficient ? 'Covered' : 'Remaining' }}</span>
                  <strong class="num">₹{{ isPaymentSufficient ? (cashAmount || 0) + (upiAmount || 0) : activeBill.total - (cashAmount || 0) - (upiAmount || 0) }}</strong>
                </div>
              }

              <button class="btn btn-success btn-xl btn-block settle" [disabled]="isClosing || !isPaymentSufficient" (click)="settleAndCloseBill()">
                @if (isClosing) {
                  <span class="spinner"></span> Settling…
                } @else {
                  <app-icon name="check" /> Settle &amp; save · ₹{{ activeBill.total }}
                }
              </button>
            } @else {
              <div class="pay-cta">
                <span class="badge" [class.badge-success]="activeBill.status === 'paid'" [class.badge-danger]="activeBill.status === 'void'">
                  {{ activeBill.status === 'paid' ? 'Paid' : 'Void' }}
                </span>
                <button class="btn btn-block" (click)="reprintBillById(activeBill._id)"><app-icon name="printer" /> Reprint bill</button>
                @if (selectedOrder.type === 'delivery' && activeBill.status === 'paid') {
                  <button class="btn btn-block" [disabled]="printingSlip" (click)="printDeliveryBill(activeBill._id)"><app-icon name="bike" /> Print delivery bill</button>
                }
              </div>
            }
          </section>
        }
      </div>

      <!-- ─── Discount dialog ─── -->
      @if (showDiscountModal && activeBill) {
        <div class="modal-backdrop" (click)="showDiscountModal = false">
          <div class="modal" role="dialog" aria-modal="true" aria-label="Add discount" (click)="$event.stopPropagation()">
            <div class="modal-header">
              <div>
                <h3>Add discount</h3>
                <p>Logged with your name and the reason.</p>
              </div>
              <button class="btn btn-ghost btn-icon modal-close" (click)="showDiscountModal = false" aria-label="Close"><app-icon name="x" /></button>
            </div>
            <div class="modal-body">
              <div class="segmented full">
                <button [class.active]="discountType === 'percent'" (click)="discountType = 'percent'"><app-icon name="percent" /> Percent</button>
                <button [class.active]="discountType === 'flat'" (click)="discountType = 'flat'"><app-icon name="cash" /> Amount</button>
              </div>
              <div class="field">
                <label for="disc-value">{{ discountType === 'percent' ? 'Discount %' : 'Discount amount' }}</label>
                <div class="input-group">
                  <span class="input-prefix-text">{{ discountType === 'percent' ? '%' : '₹' }}</span>
                  <input id="disc-value" class="input num" type="number" min="0" [max]="discountType === 'percent' ? 100 : activeBill.subtotal" [(ngModel)]="discountValue" autofocus />
                </div>
                <div class="chips">
                  @for (v of discountType === 'percent' ? [5, 10, 15, 20] : [20, 50, 100]; track v) {
                    <button type="button" class="chip" [class.active]="discountValue === v" (click)="discountValue = v">{{ discountType === 'percent' ? v + '%' : '₹' + v }}</button>
                  }
                </div>
              </div>
              <div class="field">
                <label for="disc-reason">Reason</label>
                <input id="disc-reason" class="input" [(ngModel)]="discountReason" placeholder="Required" />
                <div class="chips">
                  @for (r of discountReasons; track r) {
                    <button type="button" class="chip" [class.active]="discountReason === r" (click)="discountReason = r">{{ r }}</button>
                  }
                </div>
              </div>
              <div class="disc-preview">
                <span>New total</span>
                <strong class="num">₹{{ discountPreview }}</strong>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn" (click)="showDiscountModal = false">Cancel</button>
              <button class="btn btn-primary" [disabled]="!discountValue || discountValue <= 0 || !discountReason.trim()" (click)="submitDiscount()">Apply discount</button>
            </div>
          </div>
        </div>
      }

      <!-- ─── Close counter dialog ─── -->
      @if (showCloseModal && businessDay) {
        <div class="modal-backdrop" (click)="closeCloseModal()">
          <div class="modal" role="dialog" aria-modal="true" aria-label="Close counter" (click)="$event.stopPropagation()">
            <div class="modal-header">
              <div>
                @if (closedDay) {
                  <h3>Counter closed · {{ dayLabel(closedDay.date) }}</h3>
                  <p>New sales now go to {{ dayLabel(nextDate) }}.</p>
                } @else {
                  <h3>Close counter for {{ dayLabel(businessDay.date) }}?</h3>
                  <p>Everything settled since the counter opened is saved under {{ dayLabel(businessDay.date) }}, even after midnight.</p>
                }
              </div>
              <button class="btn btn-ghost btn-icon modal-close" (click)="closeCloseModal()" aria-label="Close"><app-icon name="x" /></button>
            </div>
            <div class="modal-body">
              @let sum = closedDay?.summary ?? businessDay.summary;
              <div class="day-sum">
                <div><span>Bills</span><strong class="num">{{ sum.bills }}</strong></div>
                <div class="big"><span>Total sales</span><strong class="num">₹{{ sum.total }}</strong></div>
                <div><span>Cash</span><strong class="num">₹{{ sum.cash }}</strong></div>
                <div><span>UPI</span><strong class="num">₹{{ sum.upi }}</strong></div>
                @if (sum.discount) { <div><span>Discounts</span><strong class="num">₹{{ sum.discount }}</strong></div> }
              </div>
              @if (!closedDay && closeOpenOrders.length) {
                <div class="alert alert-warning">
                  <app-icon name="alert" />
                  <div class="alert-body">
                    <span class="alert-title">{{ closeOpenOrders.length }} order{{ closeOpenOrders.length === 1 ? ' is' : 's are' }} still open:</span>
                    {{ openOrderNumbers }}. If you close now, they go into the next day when they're paid.
                  </div>
                </div>
              }
              @if (!closedDay) {
                <p class="text-muted text-sm">After closing, any new sale is saved under the next day. If nobody closes the counter, the day ends on its own at 6 am.</p>
                @if (canReopen) {
                  <p class="text-sm reopen-line">
                    Closed {{ dayLabel(businessDay.lastClosed!.date) }} by mistake?
                    <button class="btn btn-sm btn-ghost" [disabled]="closingDay" (click)="reopenDay()"><app-icon name="undo" /> Reopen {{ dayLabel(businessDay.lastClosed!.date) }}</button>
                  </p>
                }
              }
            </div>
            <div class="modal-footer">
              @if (closedDay) {
                <button class="btn btn-ghost" [disabled]="closingDay" (click)="reopenDay()"><app-icon name="undo" /> Undo close</button>
                <button class="btn btn-primary" (click)="closeCloseModal()">Done</button>
              } @else {
                <button class="btn" (click)="closeCloseModal()">Cancel</button>
                <button class="btn btn-primary" [disabled]="closingDay" (click)="confirmCloseCounter()">
                  @if (closingDay) { <span class="spinner"></span> } @else { <app-icon name="lock" /> }
                  {{ closeOpenOrders.length ? 'Close anyway' : 'Close counter' }}
                </button>
              }
            </div>
          </div>
        </div>
      }

      <!-- ─── Find order / bill dialog ─── -->
      @if (showReprintModal) {
        <div class="modal-backdrop" (click)="showReprintModal = false">
          <div class="modal modal-lg" role="dialog" aria-modal="true" aria-label="Find order or bill" (click)="$event.stopPropagation()">
            <div class="modal-header">
              <div>
                <h3>Find order or bill</h3>
                <p>Reprint a bill, resend a ticket to a kitchen screen{{ userRole === 'owner' ? ' or void a paid bill' : '' }}.</p>
              </div>
              <button class="btn btn-ghost btn-icon modal-close" (click)="showReprintModal = false" aria-label="Close"><app-icon name="x" /></button>
            </div>
            <div class="modal-body">
              <form class="row" (ngSubmit)="searchForReprint()">
                <div class="input-group" style="flex: 1">
                  <app-icon name="search" />
                  <input class="input" name="q" inputmode="numeric" placeholder="Order number (today's orders first)" [(ngModel)]="reprintSearchQuery" autofocus />
                </div>
                <button class="btn btn-primary" type="submit">Search</button>
              </form>

              @if (reprintResult) {
                <div class="lookup">
                  <div class="lookup-head">
                    <div>
                      <strong>{{ orderLabel(reprintResult) }}</strong>
                      <small class="text-muted">Order #{{ reprintResult.number }} · {{ typeLabel(reprintResult.type) }} · {{ reprintResult.status }}</small>
                    </div>
                  </div>

                  <div class="section-title">Bill</div>
                  @if (reprintBillData) {
                    <div class="lookup-row">
                      <span>
                        Bill #{{ reprintBillData.number }} · <strong class="num">₹{{ reprintBillData.total }}</strong>
                        <span class="badge" [class.badge-success]="reprintBillData.status === 'paid'" [class.badge-danger]="reprintBillData.status === 'void'" [class.badge-info]="reprintBillData.status === 'open'">{{ reprintBillData.status }}</span>
                      </span>
                      <span class="row">
                        <button class="btn btn-sm" (click)="reprintBillById(reprintBillData._id)"><app-icon name="printer" /> Reprint</button>
                        @if (userRole === 'owner' && reprintBillData.status === 'paid') {
                          <button class="btn btn-sm btn-danger-soft" (click)="voidBill(reprintBillData)"><app-icon name="ban" /> Void</button>
                        }
                      </span>
                    </div>
                  } @else {
                    <p class="text-muted text-sm">No bill generated yet.</p>
                  }

                  <div class="section-title">Kitchen tickets</div>
                  @for (ticket of reprintResult.tickets; track ticket._id) {
                    <div class="lookup-row">
                      <span>
                        {{ stationNames[ticket.station] || ticket.station }} · #{{ ticket.number }}
                        <span class="badge">{{ ticket.status }}</span>
                        @if (ticket.isEdited) { <span class="badge badge-danger">Edit</span> }
                      </span>
                      <button class="btn btn-sm" (click)="resendTicketById(ticket._id)"><app-icon name="send" /> Resend to screen</button>
                    </div>
                  } @empty {
                    <p class="text-muted text-sm">No tickets.</p>
                  }
                </div>
              }
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .desk { display: flex; flex-direction: column; gap: 1rem; padding: 1.25rem 1.5rem; height: 100vh; min-height: 640px; }
      .desk-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
      .reopen-line { display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; color: var(--text-muted); }
      .day-chip { display: inline-flex; align-items: center; gap: 0.35rem; height: 36px; padding: 0 0.75rem; border-radius: var(--radius-full); background: var(--gray-100); color: var(--text-strong); font-size: var(--fs-sm); font-weight: 650; white-space: nowrap; }
      .day-sum { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.6rem; }
      .day-sum > div { display: flex; flex-direction: column; gap: 0.15rem; padding: 0.7rem 0.85rem; border: 1px solid var(--border); border-radius: var(--radius-sm); }
      .day-sum > div.big { background: var(--primary-soft); border-color: transparent; }
      .day-sum span { font-size: var(--fs-xs); color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
      .day-sum strong { font-size: var(--fs-lg); color: var(--text-strong); }
      .devices { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-top: 0.4rem; }
      .device { display: inline-flex; align-items: center; gap: 0.3rem; height: 24px; padding: 0 0.55rem; border-radius: var(--radius-full); font-size: var(--fs-xs); font-weight: 600; background: var(--success-soft); color: var(--success); }
      .device.off { background: var(--danger-soft); color: var(--danger); }

      .alerts { display: flex; flex-direction: column; gap: 0.5rem; }
      .alert-items { display: flex; flex-direction: column; gap: 0.35rem; margin-top: 0.4rem; }
      .alert-item { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
      .alert-line { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }

      .work { flex: 1; min-height: 0; display: grid; grid-template-columns: 330px minmax(0, 1fr) 340px; gap: 1rem; }
      .card { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }

      .orders-tools { padding: 0.75rem; display: flex; flex-direction: column; gap: 0.6rem; border-bottom: 1px solid var(--border); }
      .filter { display: flex; }
      .filter button { flex: 1; justify-content: center; padding: 0 0.4rem; font-size: var(--fs-xs); }
      .fcount { color: var(--text-subtle); font-weight: 700; }
      .orders-list { flex: 1; overflow-y: auto; padding: 0.4rem; }
      .ord { width: 100%; display: flex; align-items: center; gap: 0.7rem; padding: 0.65rem; border-radius: 10px; border: 1px solid transparent; background: none; text-align: left; }
      .ord:hover { background: var(--gray-50); }
      .ord.sel { background: var(--primary-soft); border-color: #f6c4b2; }
      .ord-badge { width: 44px; height: 44px; border-radius: 10px; display: grid; place-items: center; flex-shrink: 0; font-weight: 800; font-size: 1rem; background: var(--gray-100); color: var(--text-strong); }
      .ord-badge.takeaway { background: #efeafd; color: #5b3fd6; }
      .ord-badge.delivery { background: #e6f3f0; color: #23705f; }
      .ord-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.1rem; }
      .ord-title { display: flex; align-items: center; gap: 0.4rem; min-width: 0; }
      .ord-title strong { color: var(--text-strong); font-size: var(--fs-sm); }
      .ord-main small { font-size: var(--fs-xs); color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ord-amt { font-weight: 700; color: var(--text-strong); font-size: var(--fs-sm); }

      .bill { overflow-y: auto; }
      .empty-state.big { flex: 1; }
      .last-closed { margin-top: 1rem; display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 0.8rem; border-radius: 10px; background: var(--success-soft); color: var(--text); font-size: var(--fs-sm); }
      .bill-head { display: flex; align-items: flex-start; gap: 0.75rem; padding: 1.1rem 1.25rem; border-bottom: 1px solid var(--border); }
      .back { display: none; }
      .bh-main { flex: 1; min-width: 0; }
      .bh-main h2 { font-size: var(--fs-lg); }
      .bh-meta, .bh-cust { display: flex; flex-wrap: wrap; gap: 0.35rem 0.9rem; margin-top: 0.3rem; font-size: var(--fs-sm); color: var(--text-muted); }
      .bh-meta span, .bh-cust, .bh-cust span { display: inline-flex; align-items: center; gap: 0.3rem; }
      .lines { padding: 0 0.25rem; }
      .lines .table th { background: transparent; }
      .lines .table th, .lines .table td { padding-left: 1rem; padding-right: 1rem; }
      .lines .table td:first-child { min-width: 160px; }
      .lines tr.cancelled td { color: var(--text-subtle); text-decoration: line-through; }
      .lines tr.cancelled .badge { text-decoration: none; margin-left: 0.4rem; }
      .totals { margin-top: auto; padding: 1rem 1.25rem 1.25rem; border-top: 1px solid var(--border); background: var(--surface-muted); display: flex; flex-direction: column; gap: 0.4rem; }
      .t-row { display: flex; justify-content: space-between; align-items: center; font-size: var(--fs-sm); color: var(--text); min-height: 28px; }
      .t-row small { color: var(--text-muted); }
      .t-row.discount { color: var(--success); }
      .t-row.grand { margin-top: 0.3rem; padding-top: 0.6rem; border-top: 1px dashed var(--border-strong); font-size: var(--fs-lg); font-weight: 800; color: var(--text-strong); }
      .add-disc { margin-left: -0.6rem; color: var(--primary); }

      .pay { padding: 1.25rem; gap: 1rem; overflow-y: auto; }
      .pay-cta { display: flex; flex-direction: column; gap: 1rem; }
      .cancel-order { color: var(--danger); }
      .cancel-order:hover:not(:disabled) { background: var(--danger-soft); }
      .pay-due { display: flex; flex-direction: column; gap: 0.1rem; }
      .delivery-slip { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.75rem; border: 1px dashed var(--info); border-radius: var(--radius); background: var(--info-soft); }
      .delivery-slip .btn { background: var(--surface); border-color: var(--info); color: var(--info); font-weight: 700; }
      .delivery-slip p { margin: 0; }
      .rider-collected { display: flex; gap: 0.6rem; align-items: flex-start; padding: 0.7rem 0.8rem; border-radius: var(--radius); background: var(--success-soft); color: var(--success); }
      .rider-collected.out { background: var(--info-soft); color: var(--info); }
      .rider-collected div { display: flex; flex-direction: column; gap: 0.1rem; }
      .rider-collected strong { color: var(--text-strong); font-size: var(--fs-sm); }
      .rider-collected span { font-size: var(--fs-xs); color: var(--text-muted); }
      .pay-due span { font-size: var(--fs-xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
      .pay-due strong { font-size: 2.4rem; font-weight: 800; color: var(--text-strong); letter-spacing: -0.03em; line-height: 1.1; }
      .segmented.full { display: flex; }
      .segmented.full button { flex: 1; justify-content: center; }
      .input-lg { min-height: 52px; font-size: var(--fs-lg); font-weight: 700; }
      .quick-amts { display: flex; flex-wrap: wrap; gap: 0.4rem; }
      .change { display: flex; justify-content: space-between; align-items: center; padding: 0.85rem 1rem; border-radius: 10px; background: var(--success-soft); color: var(--success); font-weight: 600; }
      .change strong { font-size: var(--fs-xl); }
      .change.short { background: var(--warning-soft); color: var(--warning); }
      .upi-note { display: flex; gap: 0.8rem; align-items: center; padding: 1rem; border-radius: 10px; background: var(--info-soft); color: var(--info); }
      .upi-note div { display: flex; flex-direction: column; }
      .upi-note strong { color: var(--text-strong); }
      .settle { margin-top: auto; }
      .print-open { margin-bottom: 12px; }

      .disc-preview { display: flex; justify-content: space-between; align-items: center; padding: 0.8rem 1rem; border-radius: 10px; background: var(--surface-muted); border: 1px solid var(--border); }
      .disc-preview strong { font-size: var(--fs-lg); color: var(--text-strong); }

      .lookup { display: flex; flex-direction: column; gap: 0.6rem; border-top: 1px solid var(--border); padding-top: 1rem; }
      .lookup-head small { display: block; }
      .lookup-row { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; padding: 0.6rem 0.75rem; border: 1px solid var(--border); border-radius: 10px; font-size: var(--fs-sm); flex-wrap: wrap; }
      .lookup-row .badge { margin-left: 0.35rem; }

      @media (max-width: 1439px) {
        /* Order list pinned on the left; bill and payment stack on the right at natural height */
        .desk { height: auto; min-height: 100vh; }
        .work { grid-template-columns: 320px minmax(0, 1fr); align-items: start; }
        .orders { position: sticky; top: 1rem; max-height: calc(100vh - 2rem); grid-row: 1 / span 2; }
        .bill, .pay { grid-column: 2; overflow: visible; }
        .bill { min-height: 360px; }
        .totals { margin-top: 0; }
      }
      @media (max-width: 860px) {
        .desk { padding: 1rem; }
        .work { grid-template-columns: 1fr; }
        .pay { grid-column: 1; }
        .work.has-selection .orders { display: none; }
        .work:not(.has-selection) .bill { display: none; }
        .back { display: inline-flex; margin: -0.4rem 0 0 -0.5rem; }
        .orders { position: static; max-height: none; grid-row: auto; }
        .bill, .pay { grid-column: 1; }
      }
    `,
  ],
})
export class CashierHomeComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private authService = inject(AuthService);
  private socketService = inject(SocketService);
  private ui = inject(UiService);
  private subs: Subscription[] = [];

  readonly typeFilters: { key: TypeFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'dine_in', label: 'Dine-in' },
    { key: 'takeaway', label: 'Takeaway' },
    { key: 'delivery', label: 'Delivery' },
  ];
  readonly discountReasons = ['Regular customer', 'Staff meal', 'Complaint', 'Promotion'];
  readonly stationKeys = ['fried_chicken', 'juice', 'main'];
  readonly stationNames = STATION_NAMES;

  userRole = '';
  openOrders: OrderSummary[] = [];
  ordersLoading = true;
  selectedOrder: OrderSummary | null = null;
  activeBill: BillData | null = null;
  printingSlip = false;
  selectedType: TypeFilter = 'all';
  query = '';
  busy = false;
  lastClosed: { id: string; number: number; total: number; change: number } | null = null;

  // Devices & alerts
  failedJobs: any[] = [];
  stationStatus: Record<string, { online: boolean; screens: number }> = {};
  undeliveredTickets: any[] = [];
  showUndelivered = false;
  agentOnline = false;

  // Payment
  payMode: PayMode = 'cash';
  cashAmount = 0;
  cashTendered = 0;
  cashChange = 0;
  upiAmount = 0;
  isClosing = false;

  // Discount
  showDiscountModal = false;
  discountType: 'flat' | 'percent' = 'percent';
  discountValue = 0;
  discountReason = '';

  // Lookup
  showReprintModal = false;

  // Business day / close counter
  businessDay: BusinessDayInfo | null = null;
  showCloseModal = false;
  closingDay = false;
  closeOpenOrders: { number: number; type: string }[] = [];
  closedDay: { date: string; summary: DaySummary } | null = null;
  nextDate = '';
  reprintSearchQuery = '';
  reprintResult: any = null;
  reprintBillData: any = null;

  ngOnInit(): void {
    this.userRole = this.authService.currentUser?.role || 'cashier';
    this.refreshAll();

    this.subs.push(
      this.socketService.fromEvent<any>('order:updated').subscribe((o) => {
        this.fetchOpenOrders();
        if (this.selectedOrder && o?._id === this.selectedOrder._id && !this.activeBill) this.reloadSelected();
      }),
      this.socketService.reconnect$.subscribe(() => this.refreshAll()),
      this.socketService.fromEvent<any>('day:closed').subscribe(() => this.fetchBusinessDay()),
      this.socketService.fromEvent<any>('kds:status').subscribe((s) => (this.stationStatus = s || {})),
      this.socketService.fromEvent<any[]>('ticket:undelivered').subscribe((list) => (this.undeliveredTickets = list || [])),
      this.socketService.fromEvent<any>('agent:status').subscribe((a) => (this.agentOnline = !!a?.online)),
      this.socketService.fromEvent<any>('print:failed').subscribe(() => this.fetchFailedJobs()),
      this.socketService.fromEvent<any>('table:updated').subscribe(() => this.fetchOpenOrders()),
      this.socketService.fromEvent<any>('bill:requested').subscribe((r) => {
        this.ui.info(`Table ${r?.tableName ?? ''} is asking for the bill`, 'Bill requested');
        this.fetchOpenOrders();
      }),
      this.socketService.fromEvent<any>('ticket:updated').subscribe((k) => {
        const list = this.reprintResult?.tickets as any[] | undefined;
        const idx = list?.findIndex((x) => x._id === k._id) ?? -1;
        if (list && idx !== -1) list[idx] = k;
      }),
    );
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  // ─── Business day / close counter ───────────────────────────────────────
  fetchBusinessDay(): void {
    this.http.get<BusinessDayInfo>(`${environment.apiUrl}/business-day`).subscribe({
      next: (d) => (this.businessDay = d),
      error: () => undefined,
    });
  }

  openCloseCounter(): void {
    this.closedDay = null;
    this.closeOpenOrders = [];
    this.showCloseModal = true;
    this.http.get<BusinessDayInfo>(`${environment.apiUrl}/business-day`).subscribe({ next: (d) => (this.businessDay = d) });
    this.http.get<{ orders: any[] }>(`${environment.apiUrl}/orders`, { params: { status: 'open,billed' } }).subscribe({
      next: (r) => (this.closeOpenOrders = (r.orders ?? []).filter((o) => o.status === 'open' || o.status === 'billed')),
      error: () => undefined,
    });
  }

  get openOrderNumbers(): string {
    const list = this.closeOpenOrders.map((o) => '#' + o.number);
    return list.length > 8 ? list.slice(0, 8).join(', ') + ` and ${list.length - 8} more` : list.join(', ');
  }

  confirmCloseCounter(): void {
    if (this.closingDay) return;
    this.closingDay = true;
    this.http
      .post<{ day: { date: string; summary: DaySummary }; nextDate: string }>(`${environment.apiUrl}/business-day/close`, { force: true })
      .subscribe({
        next: (r) => {
          this.closingDay = false;
          this.closedDay = r.day;
          this.nextDate = r.nextDate;
          this.fetchBusinessDay();
        },
        error: (err) => {
          this.closingDay = false;
          this.ui.apiError(err, 'Could not close the counter');
        },
      });
  }

  /** Reopen the last closed day — offered only while the new day has no sales yet. */
  get canReopen(): boolean {
    const d = this.businessDay;
    return !!d?.lastClosed && d.lastClosed.closedByName !== 'Automatic' && d.summary.bills === 0;
  }

  reopenDay(): void {
    if (this.closingDay) return;
    this.closingDay = true;
    this.http.post<{ date: string }>(`${environment.apiUrl}/business-day/reopen`, {}).subscribe({
      next: (r) => {
        this.closingDay = false;
        this.showCloseModal = false;
        this.closedDay = null;
        this.ui.success(`Sales go to ${this.dayLabel(r.date)} again`, 'Counter reopened');
        this.fetchBusinessDay();
      },
      error: (err) => {
        this.closingDay = false;
        this.ui.apiError(err, 'Could not reopen the day');
      },
    });
  }

  closeCloseModal(): void {
    this.showCloseModal = false;
    this.closedDay = null;
  }

  /** '2026-11-27' → 'Fri, 27 Nov' */
  dayLabel(ymd: string): string {
    if (!ymd) return '';
    return new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  refreshAll(): void {
    this.fetchBusinessDay();
    this.fetchOpenOrders();
    this.fetchFailedJobs();
    this.fetchKdsStatus();
  }

  // ─── Derived ────────────────────────────────────────────────────────────
  get offlineStations(): string[] {
    if (Object.keys(this.stationStatus).length === 0) return [];
    return this.stationKeys.filter((s) => !this.stationStatus[s]?.online);
  }

  get offlineStationNames(): string {
    return this.offlineStations.map((s) => this.stationNames[s]).join(', ');
  }

  get filteredOrders(): OrderSummary[] {
    const q = this.query.trim().toLowerCase();
    return this.openOrders
      .filter((o) => this.selectedType === 'all' || o.type === this.selectedType)
      .filter(
        (o) =>
          !q ||
          String(o.number) === q.replace('#', '') ||
          String(o.tableId?.name ?? o.tableId?.number ?? '').toLowerCase() === q.replace(/^t/, '') ||
          (o.customerSnapshot?.name ?? '').toLowerCase().includes(q) ||
          (o.customerSnapshot?.phone ?? '').includes(q),
      )
      .sort((a, b) => this.priority(a) - this.priority(b) || +new Date(a.createdAt) - +new Date(b.createdAt));
  }

  /** Bill asked / billed first, then oldest. */
  private priority(o: OrderSummary): number {
    if (o.delivery?.status === 'delivered') return 0; // rider is back with the money
    if (o.status === 'billed') return 0;
    if (o.tableId?.status === 'billing') return 1;
    return 2;
  }

  countType(t: TypeFilter): number {
    return t === 'all' ? this.openOrders.length : this.openOrders.filter((o) => o.type === t).length;
  }

  statusOf(o: OrderSummary): { label: string; cls: string } | null {
    if (o.status === 'open' && !this.hasBillableItems(o)) return { label: 'All cancelled', cls: 'badge-danger' };
    if (o.delivery?.status === 'delivered') return { label: 'Delivered', cls: 'badge-success' };
    if (o.delivery?.status === 'out') return { label: 'On the way', cls: 'badge-info' };
    if (o.status === 'billed') return { label: 'Billed', cls: 'badge-info' };
    if (o.tableId?.status === 'billing') return { label: 'Bill asked', cls: 'badge-warning' };
    return null;
  }

  get billLines(): any[] {
    return this.activeBill ? this.activeBill.itemsSnapshot : this.selectedOrder?.items ?? [];
  }

  get isPaymentSufficient(): boolean {
    if (!this.activeBill) return false;
    if (this.payMode === 'upi') return true;
    if (this.payMode === 'cash') return (this.cashTendered || 0) >= this.activeBill.total;
    return (this.cashAmount || 0) + (this.upiAmount || 0) >= this.activeBill.total;
  }

  /** Exact + next round notes above the total. */
  get quickAmounts(): number[] {
    const t = this.activeBill?.total ?? 0;
    const set = new Set<number>([t]);
    for (const step of [50, 100, 500]) set.add(Math.ceil((t + 1) / step) * step);
    if (t < 2000) set.add(2000);
    return [...set].filter((v) => v >= t).sort((a, b) => a - b).slice(0, 5);
  }

  get discountPreview(): number {
    if (!this.activeBill) return 0;
    const sub = this.activeBill.subtotal;
    const disc =
      this.discountType === 'percent'
        ? Math.min(sub, Math.round((sub * (this.discountValue || 0)) / 100))
        : Math.min(sub, this.discountValue || 0);
    return Math.max(0, sub - disc + this.activeBill.gst + this.activeBill.serviceCharge);
  }

  orderTotal(o: any): number {
    return (o?.items || []).filter((i: any) => i.status !== 'cancelled').reduce((s: number, i: any) => s + i.price * i.qty, 0);
  }

  orderLabel(o: any): string {
    if (o.type === 'dine_in') return `Table ${o.tableId?.name || o.tableId?.number || ''}`;
    return o.customerSnapshot?.name ? `${o.customerSnapshot.name}` : this.typeLabel(o.type);
  }

  typeLabel(t: string): string {
    return t === 'dine_in' ? 'Dine-in' : t === 'takeaway' ? 'Takeaway' : 'Delivery';
  }

  elapsed(iso: string): string {
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }

  // ─── Loading ────────────────────────────────────────────────────────────
  fetchOpenOrders(): void {
    this.http.get<{ orders: OrderSummary[] }>(`${environment.apiUrl}/orders?status=open,billed`).subscribe({
      next: (res) => {
        this.openOrders = res.orders || [];
        this.ordersLoading = false;
        // Keep the selected order's data fresh (or clear it if it was closed elsewhere)
        if (this.selectedOrder) {
          const fresh = this.openOrders.find((o) => o._id === this.selectedOrder!._id);
          if (fresh) {
            this.selectedOrder = fresh;
            this.applyRiderCollection();
          }
        }
      },
      error: () => (this.ordersLoading = false),
    });
  }

  fetchFailedJobs(): void {
    this.http.get<{ jobs: any[] }>(`${environment.apiUrl}/settings/failed-jobs`).subscribe({
      next: (res) => (this.failedJobs = res.jobs || []),
      error: () => {},
    });
  }

  fetchKdsStatus(): void {
    this.http.get<{ stations: any; undelivered: any[] }>(`${environment.apiUrl}/kds/status`).subscribe({
      next: (res) => {
        this.stationStatus = res.stations || {};
        this.undeliveredTickets = res.undelivered || [];
      },
      error: () => {},
    });
  }

  // ─── Selecting & billing ────────────────────────────────────────────────
  /** Read-only: shows the order and its existing open bill (never creates one). */
  selectOrder(order: OrderSummary): void {
    this.selectedOrder = order;
    this.activeBill = null;
    this.resetPayment();
    this.reloadSelected();
  }

  private reloadSelected(): void {
    const id = this.selectedOrder?._id;
    if (!id) return;
    this.http.get<{ order: any; bill: BillData | null }>(`${environment.apiUrl}/orders/${id}`).subscribe({
      next: (res) => {
        if (this.selectedOrder?._id !== id) return;
        const bill = res.bill && res.bill.status !== 'void' ? res.bill : null;
        this.activeBill = bill;
        if (bill) this.resetPayment();
      },
    });
  }

  clearSelection(): void {
    this.selectedOrder = null;
    this.activeBill = null;
  }

  hasBillableItems(o: OrderSummary | null): boolean {
    return !!o?.items?.some((i: any) => i.status !== 'cancelled');
  }

  /** All items were cancelled — close the order and free the table. */
  async closeEmptyOrder(): Promise<void> {
    const o = this.selectedOrder;
    if (!o || this.busy) return;
    const ok = await this.ui.confirm({
      title: `Close ${this.orderLabel(o)}?`,
      message: 'Nothing is billed. The order is marked cancelled' + (o.tableId ? ' and the table becomes free.' : '.'),
      confirmText: 'Close order',
    });
    if (ok) this.postCancel(o);
  }

  /** Cancel an order that still has items (customer left, wrong order…). */
  async cancelWholeOrder(): Promise<void> {
    const o = this.selectedOrder;
    if (!o || this.busy) return;
    const reason = await this.ui.confirm({
      title: `Cancel ${this.orderLabel(o)}?`,
      message: `All ${o.items.filter((i: any) => i.status !== 'cancelled').length} remaining item(s) are cancelled and the kitchen screens are told. Nothing is billed. This is logged.`,
      confirmText: 'Cancel order',
      cancelText: 'Keep order',
      danger: true,
      reason: { label: 'Reason', placeholder: 'e.g. customer left before food was served', required: true },
    });
    if (typeof reason === 'string' && reason) this.postCancel(o, reason);
  }

  private postCancel(o: OrderSummary, reason?: string): void {
    this.busy = true;
    this.http.post<{ message: string }>(`${environment.apiUrl}/orders/${o._id}/cancel`, reason ? { reason } : {}).subscribe({
      next: (res) => {
        this.busy = false;
        this.ui.success(res.message || 'Order closed');
        this.clearSelection();
        this.fetchOpenOrders();
      },
      error: (err) => {
        this.busy = false;
        this.ui.apiError(err, 'Could not close the order');
      },
    });
  }

  generateBillForOrder(): void {
    if (!this.selectedOrder || this.busy) return;
    this.busy = true;
    this.http.post<{ bill: BillData }>(`${environment.apiUrl}/orders/${this.selectedOrder._id}/bill`, {}).subscribe({
      next: (res) => {
        this.busy = false;
        this.activeBill = res.bill;
        this.ui.success('Bill sent to the printer', `Bill #${res.bill.number}`);
        this.resetPayment();
        this.fetchOpenOrders();
      },
      error: (err) => {
        this.busy = false;
        this.ui.apiError(err, 'Could not generate the bill');
      },
    });
  }

  private resetPayment(): void {
    const total = this.activeBill?.total ?? 0;
    this.payMode = 'cash';
    this.cashAmount = total;
    this.cashTendered = total;
    this.upiAmount = 0;
    this.cashChange = 0;
    this.appliedCollection = '';
    this.applyRiderCollection();
  }

  /** What the delivery rider recorded, if anything: "₹290 cash · Faisal · 3:10 pm". */
  get riderCollection(): string {
    const d = this.selectedOrder?.delivery;
    if (d?.status !== 'delivered' || !d.collectedMode || d.collectedMode === 'prepaid') return '';
    const at = d.deliveredAt
      ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }).format(new Date(d.deliveredAt))
      : '';
    return `₹${d.collectedAmount ?? 0} ${d.collectedMode === 'upi' ? 'by UPI' : 'cash'}${d.riderName ? ' · ' + d.riderName : ''}${at ? ' · ' + at : ''}`;
  }

  private appliedCollection = '';

  /** Pre-fill the payment with what the rider collected (once per recorded collection). */
  private applyRiderCollection(): void {
    const d = this.selectedOrder?.delivery;
    if (!this.activeBill || this.activeBill.status !== 'open' || d?.status !== 'delivered' || !d.collectedMode) return;
    const key = `${this.selectedOrder!._id}:${d.collectedMode}:${d.collectedAmount}`;
    if (key === this.appliedCollection || d.collectedMode === 'prepaid') return;
    this.appliedCollection = key;
    if (d.collectedMode === 'upi') {
      this.payMode = 'upi';
    } else {
      this.payMode = 'cash';
      this.cashTendered = d.collectedAmount ?? this.activeBill.total;
      this.calculateChange();
    }
  }

  setPayMode(mode: PayMode): void {
    this.payMode = mode;
    const total = this.activeBill?.total ?? 0;
    if (mode === 'split') {
      this.cashAmount = 0;
      this.upiAmount = total;
    }
    if (mode === 'cash') {
      this.cashTendered = total;
      this.calculateChange();
    }
  }

  onSplitCash(): void {
    const total = this.activeBill?.total ?? 0;
    this.upiAmount = Math.max(0, total - (this.cashAmount || 0));
  }

  calculateChange(): void {
    this.cashChange = Math.max(0, (this.cashTendered || 0) - (this.activeBill?.total ?? 0));
  }

  openDiscount(): void {
    this.discountType = 'percent';
    this.discountValue = 0;
    this.discountReason = '';
    this.showDiscountModal = true;
  }

  submitDiscount(): void {
    if (!this.activeBill || !this.discountValue || !this.discountReason.trim()) return;
    this.http
      .post<{ bill: BillData }>(`${environment.apiUrl}/bills/${this.activeBill._id}/discount`, {
        type: this.discountType,
        value: this.discountValue,
        reason: this.discountReason.trim(),
      })
      .subscribe({
        next: (res) => {
          this.activeBill = res.bill;
          this.resetPayment();
          this.showDiscountModal = false;
          this.ui.success(`New total ₹${res.bill.total}. Print the bill again for the customer.`, "Discount applied");
        },
        error: (err) => this.ui.apiError(err, 'Could not apply the discount'),
      });
  }

  settleAndCloseBill(): void {
    const bill = this.activeBill;
    if (!bill || !this.isPaymentSufficient || this.isClosing) return;
    this.isClosing = true;

    const payments: any[] = [];
    let change = 0;
    if (this.payMode === 'cash') {
      payments.push({ mode: 'cash', amount: bill.total, tendered: this.cashTendered });
      change = Math.max(0, this.cashTendered - bill.total);
    } else if (this.payMode === 'upi') {
      payments.push({ mode: 'upi', amount: bill.total });
    } else {
      // Never record more than the bill total across the two modes
      const cash = Math.min(this.cashAmount || 0, bill.total);
      const upi = Math.max(0, bill.total - cash);
      if (cash > 0) payments.push({ mode: 'cash', amount: cash, tendered: cash });
      if (upi > 0) payments.push({ mode: 'upi', amount: upi });
    }

    this.http.post(`${environment.apiUrl}/bills/${bill._id}/payments`, { payments }).subscribe({
      next: () => {
        this.http.post(`${environment.apiUrl}/bills/${bill._id}/close`, {}).subscribe({
          next: () => {
            this.isClosing = false;
            this.lastClosed = { id: bill._id, number: bill.number, total: bill.total, change };
            this.fetchBusinessDay();
            this.ui.success(change > 0 ? `Give back ₹${change} change` : 'Payment saved', `Bill #${bill.number} settled`);
            this.clearSelection();
            this.fetchOpenOrders();
          },
          error: (err) => {
            this.isClosing = false;
            this.ui.apiError(err, 'Could not close the bill');
          },
        });
      },
      error: (err) => {
        this.isClosing = false;
        this.ui.apiError(err, 'Could not record the payment');
      },
    });
  }

  /** Slip for the delivery rider: address + amount to collect (or PAID). */
  printDeliveryBill(billId: string): void {
    if (this.printingSlip) return;
    this.printingSlip = true;
    this.http.post<{ amountDue: number }>(`${environment.apiUrl}/bills/${billId}/delivery-bill`, {}).subscribe({
      next: (res) => {
        this.printingSlip = false;
        this.ui.success(res.amountDue > 0 ? `Rider collects ₹${res.amountDue}` : 'Marked as paid on the slip', 'Delivery bill printing');
      },
      error: (err) => {
        this.printingSlip = false;
        this.ui.apiError(err, 'Could not print the delivery bill');
      },
    });
  }

  reprintBillById(billId: string): void {
    this.http.post(`${environment.apiUrl}/bills/${billId}/reprint`, {}).subscribe({
      next: () => this.ui.success('Bill sent to the printer'),
      error: (err) => this.ui.apiError(err, 'Could not reprint'),
    });
  }

  resendTicketById(ticketId: string): void {
    this.http.post<{ message: string }>(`${environment.apiUrl}/tickets/${ticketId}/resend`, {}).subscribe({
      next: (res) => {
        this.undeliveredTickets = this.undeliveredTickets.filter((k) => k._id !== ticketId);
        this.ui.success(res.message);
      },
      error: (err) => this.ui.apiError(err, 'Resend failed'),
    });
  }

  /** "T7" stays "T7"; a bare number becomes "T7". */
  tableLabel(label: string | number): string {
    return /^\d+$/.test(String(label)) ? `T${label}` : String(label);
  }

  resendAll(): void {
    const ids = this.undeliveredTickets.map((k) => k._id);
    ids.forEach((id) => this.http.post(`${environment.apiUrl}/tickets/${id}/resend`, {}).subscribe({ error: () => {} }));
    this.undeliveredTickets = [];
    this.ui.success(`${ids.length} ticket${ids.length === 1 ? '' : 's'} resent to the kitchen screens`);
  }

  retryPrintJob(jobId: string): void {
    this.http.post(`${environment.apiUrl}/settings/jobs/${jobId}/retry`, {}).subscribe({
      next: () => {
        this.failedJobs = this.failedJobs.filter((j) => j._id !== jobId);
        this.ui.success('Sent to the printer again');
      },
      error: (err) => this.ui.apiError(err, 'Retry failed'),
    });
  }

  async voidBill(bill: any): Promise<void> {
    const reason = await this.ui.confirm({
      title: `Void bill #${bill.number}?`,
      message: `₹${bill.total} will be removed from sales and the order reopened for correction. This is permanently logged.`,
      confirmText: 'Void bill',
      danger: true,
      reason: { label: 'Reason', placeholder: 'e.g. wrong payment mode recorded', required: true },
    });
    if (!reason || typeof reason !== 'string') return;
    this.http.post(`${environment.apiUrl}/bills/${bill._id}/void`, { voidReason: reason }).subscribe({
      next: () => {
        this.ui.warning('The order is open again for correction', `Bill #${bill.number} voided`);
        this.showReprintModal = false;
        this.fetchOpenOrders();
      },
      error: (err) => this.ui.apiError(err, 'Void failed'),
    });
  }

  // ─── Lookup ─────────────────────────────────────────────────────────────
  openLookup(): void {
    this.reprintSearchQuery = '';
    this.reprintResult = null;
    this.reprintBillData = null;
    this.showReprintModal = true;
  }

  searchForReprint(): void {
    const q = this.reprintSearchQuery.trim().replace('#', '');
    if (!q) return;
    this.reprintResult = null;
    this.reprintBillData = null;
    this.http.get<{ orders: OrderSummary[] }>(`${environment.apiUrl}/orders`).subscribe({
      next: (res) => {
        // Orders are newest first, so a daily number resolves to today's order
        const found = res.orders.find((o) => o.number.toString() === q);
        if (!found) {
          this.ui.warning(`No order #${q} found`);
          return;
        }
        this.http.get<{ order: any; tickets: any[]; bill: any }>(`${environment.apiUrl}/orders/${found._id}`).subscribe({
          next: (o) => {
            this.reprintResult = { ...found, tickets: o.tickets || [] };
            this.reprintBillData = o.bill || null;
          },
          error: () => (this.reprintResult = { ...found, tickets: [] }),
        });
      },
      error: (err) => this.ui.apiError(err),
    });
  }
}
