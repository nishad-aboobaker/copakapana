import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../../environments/environment';
import { SocketService } from '../../core/socket/socket.service';
import { AuthService } from '../../core/auth/auth.service';
import { OfflineQueueService } from '../../core/services/offline-queue.service';
import { IconComponent } from '../../shared/icon.component';
import { UiService } from '../../shared/ui.service';

interface TableItem {
  _id: string;
  name?: string;
  number: string | number;
  floor: 'ground' | 'first';
  capacity: number;
  status: 'free' | 'occupied' | 'billing';
  active: boolean;
}

interface MenuItem {
  _id: string;
  name: string;
  categoryId: string;
  price: number;
  station: 'fried_chicken' | 'juice' | 'main';
  isVeg: boolean;
  description?: string;
  portions?: { label: string; price: number }[];
  available: boolean;
}

interface CartItem {
  menuItemId: string;
  name: string;
  price: number;
  qty: number;
  portion?: string;
  note?: string;
  station: string;
}

type Tab = 'tables' | 'orders' | 'ready';
type OrderPane = 'menu' | 'cart' | 'sent';

const STATION_NAMES: Record<string, string> = { fried_chicken: 'Fried Chicken', juice: 'Juice', main: 'Main Kitchen' };
const TICKET_STATUS: Record<string, string> = { new: 'Sent', preparing: 'Preparing', ready: 'Ready', served: 'Served' };

/**
 * Waiter app (phones). Bottom tabs: Tables · My orders · Ready.
 * Opening a table / takeaway / delivery enters the order workspace:
 * Menu → Cart → Send, and "Sent" shows items with live kitchen status.
 */
@Component({
  selector: 'app-waiter-main',
  // Angular 22 defaults to OnPush; this page keeps plain-field state updated by HTTP/socket callbacks
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: true,
  imports: [FormsModule, IconComponent],
  template: `
    <div class="app">
      <!-- ═══════════ Top bar ═══════════ -->
      <header class="topbar">
        @if (inOrder) {
          <button class="btn btn-ghost btn-icon" (click)="leaveOrder()" aria-label="Back to tables"><app-icon name="arrow-left" /></button>
          <div class="ctx">
            <strong class="truncate">{{ contextTitle }}</strong>
            <span class="truncate">{{ contextSubtitle }}</span>
          </div>
        } @else {
          <div class="me">
            <span class="avatar">{{ initials }}</span>
            <div class="ctx">
              <strong class="truncate">{{ currentWaiterName }}</strong>
              <span>{{ greeting }}</span>
            </div>
          </div>
        }
        <span class="spacer"></span>
        @if (!isOnline) {
          <span class="badge badge-danger"><app-icon name="wifi-off" /> Offline</span>
        }
        @if (queuedCount > 0) {
          <span class="badge badge-warning" title="Will send automatically when back online"><app-icon name="clock" /> {{ queuedCount }} queued</span>
        }
        @if (!inOrder) {
          <button class="btn btn-ghost btn-icon" (click)="logout()" aria-label="Sign out"><app-icon name="logout" /></button>
        }
      </header>

      <!-- ═══════════ TABLES ═══════════ -->
      @if (!inOrder && tab === 'tables') {
        <main class="content">
          <div class="quick">
            <button class="quick-card" (click)="startTakeawayOrder()">
              <span class="q-icon takeaway"><app-icon name="bag" /></span>
              <span><strong>Takeaway</strong><small>Pick-up order</small></span>
            </button>
            <button class="quick-card" (click)="startDeliveryOrder()">
              <span class="q-icon delivery"><app-icon name="bike" /></span>
              <span><strong>Delivery</strong><small>Home delivery</small></span>
            </button>
          </div>

          <div class="row floor-row">
            <div class="segmented">
              <button [class.active]="selectedFloor === 'ground'" (click)="selectedFloor = 'ground'">Ground · {{ groundTables.length }}</button>
              <button [class.active]="selectedFloor === 'first'" (click)="selectedFloor = 'first'">First · {{ firstTables.length }}</button>
            </div>
            <span class="spacer"></span>
            <div class="legend">
              <span><i class="legend-dot free"></i>{{ countBy('free') }}</span>
              <span><i class="legend-dot occupied"></i>{{ countBy('occupied') }}</span>
              <span><i class="legend-dot billing"></i>{{ countBy('billing') }}</span>
            </div>
          </div>

          @if (tablesLoading) {
            <div class="tables">
              @for (i of [1, 2, 3, 4, 5, 6, 7, 8]; track i) {
                <div class="skeleton" style="height: 96px; border-radius: 14px"></div>
              }
            </div>
          } @else if (activeFloorTables.length === 0) {
            <div class="empty-state">
              <div class="empty-icon"><app-icon name="table" /></div>
              <h3>No tables on this floor</h3>
              <p>The owner can add tables under Setup → Tables.</p>
            </div>
          } @else {
            <div class="tables">
              @for (t of activeFloorTables; track t._id) {
                <button class="tile" [class]="'tile ' + t.status" (click)="onTableClick(t)">
                  <span class="tile-top">
                    <span class="t-name">{{ t.name || t.number }}</span>
                    <span class="t-seats"><app-icon name="users" [size]="13" /> {{ t.capacity }}</span>
                  </span>
                  <span class="t-status">{{ tableStatusLabel(t.status) }}</span>
                </button>
              }
            </div>
          }
        </main>
      }

      <!-- ═══════════ MY ORDERS ═══════════ -->
      @if (!inOrder && tab === 'orders') {
        <main class="content">
          <h2 class="screen-title">My open orders</h2>
          @if (myOrders.length === 0) {
            <div class="empty-state">
              <div class="empty-icon"><app-icon name="orders" /></div>
              <h3>No open orders</h3>
              <p>Orders you take appear here until they're paid.</p>
            </div>
          } @else {
            <div class="list">
              @for (o of myOrders; track o._id) {
                <button class="list-row" (click)="openOrder(o)">
                  <span class="lr-icon" [class]="'lr-icon ' + o.type"><app-icon [name]="typeIcon(o.type)" /></span>
                  <span class="lr-main">
                    <strong>{{ orderTitle(o) }}</strong>
                    <small>Order #{{ o.number }} · {{ activeItemCount(o) }} items · {{ timeAgo(o.createdAt) }}</small>
                  </span>
                  <span class="lr-amt num">₹{{ orderTotal(o) }}</span>
                  <app-icon name="chevron-right" class="text-subtle" />
                </button>
              }
            </div>
          }
        </main>
      }

      <!-- ═══════════ READY ═══════════ -->
      @if (!inOrder && tab === 'ready') {
        <main class="content">
          <h2 class="screen-title">Ready to serve</h2>
          @if (readyTickets.length === 0) {
            <div class="empty-state">
              <div class="empty-icon"><app-icon name="bell" /></div>
              <h3>Nothing ready yet</h3>
              <p>When the kitchen marks your food ready, it shows up here and your phone vibrates.</p>
            </div>
          } @else {
            <div class="list">
              @for (k of readyTickets; track k._id) {
                <div class="list-row ready-row">
                  <span class="lr-icon ready"><app-icon name="bell" /></span>
                  <span class="lr-main">
                    <strong>{{ ticketHeader(k) }}</strong>
                    <small>{{ stationLabel(k.station) }} · {{ ticketItemsSummary(k) }}</small>
                  </span>
                  <button class="btn btn-success" (click)="markServed(k)"><app-icon name="check" /> Served</button>
                </div>
              }
            </div>
          }
        </main>
      }

      <!-- ═══════════ ORDER WORKSPACE ═══════════ -->
      @if (inOrder) {
        <div class="pane-switch">
          <div class="segmented full">
            <button [class.active]="pane === 'menu'" (click)="pane = 'menu'"><app-icon name="utensils" /> Menu</button>
            <button [class.active]="pane === 'cart'" (click)="pane = 'cart'">
              <app-icon name="cart" /> New items @if (cartTotalCount) { <span class="count">{{ cartTotalCount }}</span> }
            </button>
            @if (currentOpenOrder) {
              <button [class.active]="pane === 'sent'" (click)="pane = 'sent'">
                <app-icon name="send" /> Sent
                @if (readyForThisOrder) { <span class="count ready">{{ readyForThisOrder }}</span> }
              </button>
            }
          </div>
        </div>

        <!-- Menu -->
        @if (pane === 'menu') {
          <main class="content menu-content">
            <div class="menu-tools">
              <div class="input-group">
                <app-icon name="search" />
                <input class="input" type="search" placeholder="Search dishes" [(ngModel)]="searchQuery" />
              </div>
              @if (!searchQuery.trim()) {
                <div class="chips">
                  @for (cat of categories; track cat) {
                    <button class="chip" [class.active]="selectedCategory === cat" (click)="selectedCategory = cat">{{ cat }}</button>
                  }
                </div>
              }
            </div>

            @if (displayedItems.length === 0) {
              <div class="empty-state">
                <div class="empty-icon"><app-icon name="search" /></div>
                <h3>{{ searchQuery.trim() ? 'No dishes match "' + searchQuery.trim() + '"' : 'No dishes in this category' }}</h3>
              </div>
            } @else {
              <div class="dishes">
                @for (item of displayedItems; track item._id) {
                  <div class="dish" [class.out]="!item.available" (click)="openItemSheet(item)" [attr.aria-disabled]="!item.available">
                    <span class="diet" [class.veg]="item.isVeg" [attr.title]="item.isVeg ? 'Veg' : 'Non-veg'"><i></i></span>
                    <div class="dish-main">
                      <strong>{{ item.name }}</strong>
                      <small class="num">
                        ₹{{ item.price }}{{ item.portions?.length ? ' · ' + item.portions!.length + ' sizes' : '' }}
                      </small>
                    </div>
                    @if (!item.available) {
                      <span class="badge badge-danger out-badge"><app-icon name="ban" /> Out of stock</span>
                    } @else {
                      @if (qtyInCart(item._id); as q) {
                        <span class="in-cart">{{ q }}</span>
                      }
                      <button class="add-btn" (click)="quickAdd(item, $event)" [attr.aria-label]="'Add ' + item.name">
                        <app-icon name="plus" [size]="18" />
                      </button>
                    }
                  </div>
                }
              </div>
            }
          </main>
        }

        <!-- Cart -->
        @if (pane === 'cart') {
          <main class="content">
            @if (cart.length === 0) {
              <div class="empty-state">
                <div class="empty-icon"><app-icon name="cart" /></div>
                <h3>No new items yet</h3>
                <p>Add dishes from the menu, then send them to the kitchen.</p>
                <button class="btn btn-primary" (click)="pane = 'menu'"><app-icon name="utensils" /> Browse menu</button>
              </div>
            } @else {
              <div class="card cart-card">
                @for (c of cart; track $index; let idx = $index) {
                  <div class="cart-line">
                    <div class="cl-main">
                      <strong>{{ c.name }}{{ c.portion ? ' · ' + c.portion : '' }}</strong>
                      @if (c.note) {
                        <small class="note"><app-icon name="pencil" [size]="12" /> {{ c.note }}</small>
                      }
                      <small class="num">₹{{ c.price }} each</small>
                    </div>
                    <div class="stepper">
                      <button (click)="changeQty(c, -1)" [attr.aria-label]="c.qty === 1 ? 'Remove' : 'Decrease'">
                        <app-icon [name]="c.qty === 1 ? 'trash' : 'minus'" [size]="16" />
                      </button>
                      <span class="num">{{ c.qty }}</span>
                      <button (click)="changeQty(c, 1)" aria-label="Increase"><app-icon name="plus" [size]="16" /></button>
                    </div>
                    <span class="cl-amt num">₹{{ c.price * c.qty }}</span>
                  </div>
                }
                <div class="cart-total">
                  <span>{{ cartTotalCount }} item{{ cartTotalCount === 1 ? '' : 's' }}</span>
                  <strong class="num">₹{{ cartTotalPrice }}</strong>
                </div>
              </div>
              <button class="btn btn-ghost btn-block" (click)="pane = 'menu'"><app-icon name="plus" /> Add more dishes</button>
            }
          </main>
        }

        <!-- Sent items + kitchen status -->
        @if (pane === 'sent' && currentOpenOrder) {
          <main class="content">
            @if (currentOpenOrder.customerSnapshot?.phone) {
              <div class="card cust">
                <app-icon name="user" class="text-muted" />
                <div>
                  <strong>{{ currentOpenOrder.customerSnapshot.name }}</strong>
                  <small>{{ currentOpenOrder.customerSnapshot.phone }}{{ currentOpenOrder.customerSnapshot.address ? ' · ' + currentOpenOrder.customerSnapshot.address : '' }}</small>
                </div>
              </div>
            }

            @if (orderTickets.length) {
              <div class="section-title">Kitchen</div>
              <div class="card tickets">
                @for (k of orderTickets; track k._id) {
                  <div class="ticket">
                    <div class="ticket-main">
                      <strong>
                        {{ stationLabel(k.station) }}
                        @if (k.isEdited) { <span class="badge badge-danger">Edit</span> }
                      </strong>
                      <small>{{ ticketItemsSummary(k) }}</small>
                    </div>
                    <span class="badge badge-dot" [class]="'badge badge-dot ' + ticketBadge(k.status)">{{ ticketStatusLabel(k.status) }}</span>
                    @if (k.status === 'ready') {
                      <button class="btn btn-success btn-sm" (click)="markServed(k)">Served</button>
                    }
                  </div>
                }
              </div>
            }

            <div class="section-title">Items</div>
            <div class="card">
              @for (item of currentOpenOrder.items; track item._id) {
                <div class="sent-line" [class.cancelled]="item.status === 'cancelled'">
                  <span class="qty num">{{ item.qty }}×</span>
                  <div class="cl-main">
                    <strong>{{ item.name }}{{ item.portion ? ' · ' + item.portion : '' }}</strong>
                    @if (item.note) {
                      <small class="note">{{ item.note }}</small>
                    }
                    @if (item.status === 'cancelled') {
                      <small class="text-danger">Cancelled</small>
                    }
                  </div>
                  <span class="num cl-amt">₹{{ item.price * item.qty }}</span>
                  @if (item.status === 'active' && currentOpenOrder.status === 'open') {
                    <button class="btn btn-ghost btn-icon btn-sm" (click)="cancelItem(item)" [attr.aria-label]="'Cancel ' + item.name">
                      <app-icon name="x" [size]="16" />
                    </button>
                  }
                </div>
              }
              <div class="cart-total">
                <span>Order total</span>
                <strong class="num">₹{{ orderTotal(currentOpenOrder) }}</strong>
              </div>
            </div>

            @if (currentOpenOrder.status === 'open' && !hasActiveItems) {
              <div class="alert alert-warning">
                <app-icon name="info" />
                <div class="alert-body">Every item was cancelled — there's nothing to bill. Add new items, or close the order.</div>
              </div>
              <button class="btn btn-lg btn-block bill-btn" (click)="closeEmptyOrder()">
                <app-icon name="check" /> Close order{{ currentOpenOrder.type === 'dine_in' ? ' & free table' : '' }}
              </button>
            } @else if (currentOpenOrder.type === 'dine_in') {
              <button
                class="btn btn-lg btn-block bill-btn"
                [disabled]="billRequested"
                (click)="requestBill()"
              >
                <app-icon name="receipt" /> {{ billRequested ? 'Bill requested' : 'Request bill' }}
              </button>
            }
          </main>
        }

        <!-- Sticky action bar -->
        @if (cart.length > 0 && pane !== 'sent') {
          <div class="action-bar">
            @if (pane === 'menu') {
              <button class="btn btn-primary btn-xl btn-block cart-bar" (click)="pane = 'cart'">
                <span class="cb-count">{{ cartTotalCount }}</span>
                <span>Review items</span>
                <span class="spacer"></span>
                <span class="num">₹{{ cartTotalPrice }}</span>
              </button>
            } @else {
              <button class="btn btn-primary btn-xl btn-block" [disabled]="isSubmitting" (click)="sendOrder()">
                @if (isSubmitting) {
                  <span class="spinner"></span> Sending…
                } @else {
                  <app-icon name="send" /> Send to kitchen · ₹{{ cartTotalPrice }}
                }
              </button>
            }
          </div>
        }
      }

      <!-- ═══════════ Bottom navigation ═══════════ -->
      @if (!inOrder) {
        <nav class="bottom-nav" aria-label="Sections">
          <button [class.active]="tab === 'tables'" (click)="tab = 'tables'">
            <app-icon name="grid" /><span>Tables</span>
          </button>
          <button [class.active]="tab === 'orders'" (click)="showOrders()">
            <app-icon name="orders" /><span>My orders</span>
            @if (myOrders.length) { <i class="nav-count">{{ myOrders.length }}</i> }
          </button>
          <button [class.active]="tab === 'ready'" (click)="tab = 'ready'">
            <app-icon name="bell" /><span>Ready</span>
            @if (readyTickets.length) { <i class="nav-count pulse">{{ readyTickets.length }}</i> }
          </button>
        </nav>
      }

      <!-- ═══════════ Dish sheet ═══════════ -->
      @if (selectedDishSheet) {
        <div class="sheet-backdrop" (click)="selectedDishSheet = null">
          <div class="sheet" role="dialog" aria-modal="true" [attr.aria-label]="selectedDishSheet.name" (click)="$event.stopPropagation()">
            <div class="sheet-handle"></div>
            <div class="modal-header">
              <div>
                <h3 class="row" style="gap: 0.5rem">
                  <span class="diet" [class.veg]="selectedDishSheet.isVeg"><i></i></span>{{ selectedDishSheet.name }}
                </h3>
                @if (selectedDishSheet.description) {
                  <p>{{ selectedDishSheet.description }}</p>
                }
              </div>
              <button class="btn btn-ghost btn-icon modal-close" (click)="selectedDishSheet = null" aria-label="Close"><app-icon name="x" /></button>
            </div>
            <div class="modal-body">
              @if (selectedDishSheet.portions?.length) {
                <div class="field">
                  <span class="label">Size</span>
                  <div class="portions">
                    @for (p of selectedDishSheet.portions; track p.label) {
                      <button type="button" class="portion" [class.sel]="sheetSelectedPortion?.label === p.label" (click)="sheetSelectedPortion = p">
                        <strong>{{ p.label }}</strong><span class="num">₹{{ p.price }}</span>
                      </button>
                    }
                  </div>
                </div>
              }
              <div class="field">
                <span class="label">Quantity</span>
                <div class="stepper lg">
                  <button (click)="sheetQty = sheetQty > 1 ? sheetQty - 1 : 1" aria-label="Decrease"><app-icon name="minus" /></button>
                  <span class="num">{{ sheetQty }}</span>
                  <button (click)="sheetQty = sheetQty + 1" aria-label="Increase"><app-icon name="plus" /></button>
                </div>
              </div>
              <div class="field">
                <label for="dish-note">Note for the kitchen</label>
                <input id="dish-note" class="input" [(ngModel)]="sheetNote" placeholder="e.g. less spicy, no onion" />
                <div class="chips">
                  @for (n of quickNotes; track n) {
                    <button type="button" class="chip" (click)="appendNote(n)">{{ n }}</button>
                  }
                </div>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-primary btn-xl btn-block" (click)="addSheetItemToCart()">
                Add {{ sheetQty }} · ₹{{ getSheetPrice() }}
              </button>
            </div>
          </div>
        </div>
      }

      <!-- ═══════════ Customer sheet (takeaway / delivery) ═══════════ -->
      @if (showCustomerModal) {
        <div class="sheet-backdrop" (click)="showCustomerModal = false">
          <div class="sheet" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
            <div class="sheet-handle"></div>
            <div class="modal-header">
              <div>
                <h3>{{ orderType === 'takeaway' ? 'Takeaway order' : 'Delivery order' }}</h3>
                <p>Returning customers are filled in from their phone number.</p>
              </div>
              <button class="btn btn-ghost btn-icon modal-close" (click)="showCustomerModal = false" aria-label="Close"><app-icon name="x" /></button>
            </div>
            <div class="modal-body">
              <div class="field">
                <label for="cust-phone">Mobile number</label>
                <div class="input-group">
                  <app-icon name="phone" />
                  <input
                    id="cust-phone"
                    class="input num"
                    type="tel"
                    inputmode="numeric"
                    maxlength="10"
                    placeholder="10-digit number"
                    [(ngModel)]="customerPhone"
                    (input)="onPhoneChange()"
                    autofocus
                  />
                  @if (lookupLoading) {
                    <span class="input-suffix spinner text-muted"></span>
                  }
                </div>
                @if (isReturningCustomer) {
                  <span class="hint text-success"><app-icon name="check-circle" [size]="13" class="inline" /> Returning customer — details filled in</span>
                }
              </div>
              <div class="field">
                <label for="cust-name">Customer name</label>
                <input id="cust-name" class="input" [(ngModel)]="customerName" placeholder="Name" autocomplete="off" />
              </div>
              @if (orderType === 'delivery') {
                <div class="field">
                  <label for="cust-addr">Delivery address</label>
                  @if (savedAddresses.length) {
                    <div class="chips wrap">
                      @for (addr of savedAddresses; track addr.text) {
                        <button type="button" class="chip" [class.active]="customerAddress === addr.text" (click)="customerAddress = addr.text">
                          <app-icon name="pin" [size]="14" /> {{ addr.text.length > 28 ? addr.text.slice(0, 28) + '…' : addr.text }}
                        </button>
                      }
                    </div>
                  }
                  <textarea id="cust-addr" class="textarea" rows="3" [(ngModel)]="customerAddress" placeholder="House / flat, street, landmark"></textarea>
                </div>
              }
            </div>
            <div class="modal-footer">
              <button class="btn btn-primary btn-xl btn-block" [disabled]="!isCustomerValid" (click)="confirmCustomerAndOpenMenu()">
                Continue to menu <app-icon name="arrow-right" />
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .app { min-height: 100vh; min-height: 100dvh; max-width: 720px; margin: 0 auto; background: var(--bg); display: flex; flex-direction: column; }
      @media (min-width: 721px) { .app { border-inline: 1px solid var(--border); } }

      .topbar {
        position: sticky; top: 0; z-index: 50; display: flex; align-items: center; gap: 0.5rem; min-height: 60px;
        padding: calc(env(safe-area-inset-top) + 0.4rem) 0.75rem 0.4rem; background: rgba(255, 255, 255, 0.94); backdrop-filter: blur(10px); border-bottom: 1px solid var(--border);
      }
      .me { display: flex; align-items: center; gap: 0.6rem; min-width: 0; }
      .avatar { width: 38px; height: 38px; border-radius: 50%; background: var(--gray-900); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 0.85rem; flex-shrink: 0; }
      .ctx { display: flex; flex-direction: column; min-width: 0; line-height: 1.2; }
      .ctx strong { color: var(--text-strong); font-size: var(--fs-md); text-transform: capitalize; }
      .ctx span { font-size: var(--fs-xs); color: var(--text-muted); }

      .content { flex: 1; padding: 1rem 1rem 6.5rem; display: flex; flex-direction: column; gap: 1rem; }
      .screen-title { font-size: var(--fs-lg); }

      .quick { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
      .quick-card { display: flex; align-items: center; gap: 0.7rem; padding: 0.8rem; min-height: 64px; text-align: left; border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface); box-shadow: var(--shadow-xs); }
      .quick-card:active { transform: scale(0.98); }
      .quick-card strong { display: block; color: var(--text-strong); font-size: var(--fs-sm); }
      .quick-card small { color: var(--text-muted); font-size: var(--fs-xs); }
      .q-icon { width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; flex-shrink: 0; }
      .q-icon.takeaway { background: #efeafd; color: #5b3fd6; }
      .q-icon.delivery { background: #e6f3f0; color: #23705f; }

      .floor-row { flex-wrap: wrap; gap: 0.5rem; }
      .legend { display: flex; gap: 0.75rem; font-size: var(--fs-xs); font-weight: 600; color: var(--text-muted); }
      .legend span { display: inline-flex; align-items: center; gap: 0.3rem; }
      .legend-dot { width: 9px; height: 9px; border-radius: 3px; display: inline-block; }
      .legend-dot.free { background: var(--free); }
      .legend-dot.occupied { background: var(--occupied); }
      .legend-dot.billing { background: var(--billing); }

      .tables { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 0.6rem; }
      .tile {
        position: relative; display: flex; flex-direction: column; justify-content: space-between; min-height: 96px; padding: 0.7rem;
        border-radius: 14px; border: 1.5px solid var(--border); background: var(--surface); text-align: left; transition: transform 0.08s;
      }
      .tile:active { transform: scale(0.97); }
      .tile-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 0.25rem; }
      .t-name { font-size: 1.35rem; font-weight: 800; color: var(--text-strong); letter-spacing: -0.02em; line-height: 1.1; }
      .t-seats { display: inline-flex; align-items: center; gap: 0.15rem; font-size: var(--fs-xs); color: var(--text-muted); font-weight: 600; }
      .t-status { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
      .tile.free .t-status { color: var(--free); }
      .tile.occupied { background: var(--occupied-soft); border-color: #efc982; }
      .tile.occupied .t-status { color: var(--occupied); }
      .tile.billing { background: var(--billing-soft); border-color: #f0a9a9; }
      .tile.billing .t-status { color: var(--billing); }

      .list { display: flex; flex-direction: column; gap: 0.5rem; }
      .list-row { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem; min-height: 64px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface); text-align: left; width: 100%; }
      .lr-icon { width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; flex-shrink: 0; background: var(--gray-100); color: var(--gray-600); }
      .lr-icon.takeaway { background: #efeafd; color: #5b3fd6; }
      .lr-icon.delivery { background: #e6f3f0; color: #23705f; }
      .lr-icon.dine_in { background: var(--primary-soft); color: var(--primary); }
      .lr-icon.ready { background: var(--success-soft); color: var(--success); }
      .lr-main { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.3; }
      .lr-main strong { color: var(--text-strong); }
      .lr-main small { color: var(--text-muted); font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .lr-amt { font-weight: 700; color: var(--text-strong); }
      .ready-row { border-color: #bfe5cc; background: #f6fcf8; }

      .pane-switch { position: sticky; top: 60px; z-index: 40; padding: 0.6rem 1rem; background: var(--bg); border-bottom: 1px solid var(--border); }
      .segmented.full { display: flex; width: 100%; }
      .segmented.full button { flex: 1; justify-content: center; min-height: 38px; }
      .count { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: var(--primary); color: #fff; font-size: 0.7rem; display: inline-grid; place-items: center; }
      .count.ready { background: var(--success); }

      .menu-content { gap: 0.75rem; }
      .menu-tools { display: flex; flex-direction: column; gap: 0.6rem; }
      .dishes { display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
      .dish { display: flex; align-items: center; gap: 0.75rem; padding: 0.7rem 0.75rem; min-height: 64px; border-bottom: 1px solid var(--gray-100); cursor: pointer; }
      .dish:last-child { border-bottom: 0; }
      .dish:active { background: var(--gray-50); }
      .dish-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .dish-main strong { color: var(--text-strong); font-weight: 600; }
      .dish-main small { color: var(--text-muted); font-size: var(--fs-sm); }
      .diet { width: 16px; height: 16px; border: 1.5px solid #b3261e; border-radius: 3px; display: inline-grid; place-items: center; flex-shrink: 0; }
      .diet i { width: 7px; height: 7px; border-radius: 50%; background: #b3261e; }
      .diet.veg { border-color: #1e8a3c; }
      .diet.veg i { background: #1e8a3c; }
      .in-cart { min-width: 26px; height: 26px; padding: 0 7px; border-radius: 13px; background: var(--primary-soft); color: var(--primary-active); font-weight: 700; font-size: var(--fs-sm); display: grid; place-items: center; }
      .add-btn { width: 44px; height: 44px; border-radius: 12px; border: 1px solid var(--primary); background: var(--surface); color: var(--primary); display: grid; place-items: center; flex-shrink: 0; }
      .add-btn:active { background: var(--primary); color: #fff; }
      .dish.out { cursor: not-allowed; background: var(--gray-25); }
      .dish.out .dish-main strong { color: var(--text-muted); text-decoration: line-through; text-decoration-color: var(--gray-400); }
      .dish.out .diet { opacity: 0.45; }
      .out-badge { flex-shrink: 0; }

      .cart-card, .card { overflow: hidden; }
      .cart-line, .sent-line { display: flex; align-items: center; gap: 0.75rem; padding: 0.8rem 1rem; border-bottom: 1px solid var(--gray-100); }
      .cl-main { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.35; }
      .cl-main strong { color: var(--text-strong); font-weight: 600; }
      .cl-main small { color: var(--text-muted); font-size: var(--fs-xs); }
      .note { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--warning) !important; font-style: italic; }
      .cl-amt { font-weight: 700; color: var(--text-strong); min-width: 56px; text-align: right; }
      .sent-line .qty { font-weight: 700; color: var(--text-muted); min-width: 28px; }
      .sent-line.cancelled strong { text-decoration: line-through; color: var(--text-muted); }
      .sent-line.cancelled .cl-amt { text-decoration: line-through; color: var(--text-subtle); }
      .cart-total { display: flex; justify-content: space-between; align-items: center; padding: 0.9rem 1rem; background: var(--surface-muted); }
      .cart-total strong { font-size: var(--fs-lg); color: var(--text-strong); }
      .stepper { display: inline-flex; align-items: center; align-self: flex-start; flex-shrink: 0; border: 1px solid var(--border-strong); border-radius: 10px; overflow: hidden; }
      .stepper button { width: 38px; height: 38px; border: 0; background: var(--surface); display: grid; place-items: center; color: var(--text-strong); }
      .stepper button:active { background: var(--gray-100); }
      .stepper span { min-width: 28px; text-align: center; font-weight: 700; }
      .stepper.lg button { width: 52px; height: 48px; }
      .stepper.lg span { min-width: 44px; font-size: var(--fs-lg); }

      .cust { display: flex; align-items: center; gap: 0.75rem; padding: 0.8rem 1rem; }
      .cust div { display: flex; flex-direction: column; min-width: 0; }
      .cust small { color: var(--text-muted); font-size: var(--fs-xs); }
      .tickets { display: flex; flex-direction: column; }
      .ticket { display: flex; align-items: center; gap: 0.6rem; padding: 0.75rem 1rem; border-bottom: 1px solid var(--gray-100); }
      .ticket:last-child { border-bottom: 0; }
      .ticket-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .ticket-main strong { display: flex; align-items: center; gap: 0.4rem; font-size: var(--fs-sm); color: var(--text-strong); }
      .ticket-main small { color: var(--text-muted); font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .section-title { margin-bottom: -0.5rem; }
      .bill-btn { border-color: var(--border-strong); }

      .portions { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 0.5rem; }
      .portion { display: flex; flex-direction: column; align-items: flex-start; gap: 0.1rem; padding: 0.65rem 0.8rem; border-radius: 10px; border: 1.5px solid var(--border-strong); background: var(--surface); }
      .portion.sel { border-color: var(--primary); background: var(--primary-soft); }
      .portion span { font-size: var(--fs-sm); color: var(--text-muted); }
      .chips.wrap { flex-wrap: wrap; overflow: visible; }

      .action-bar { position: sticky; bottom: 0; z-index: 45; padding: 0.75rem 1rem calc(0.75rem + env(safe-area-inset-bottom)); background: linear-gradient(to top, var(--bg) 70%, transparent); }
      .cart-bar { justify-content: flex-start; }
      .cb-count { min-width: 28px; height: 28px; border-radius: 8px; background: rgba(255, 255, 255, 0.22); display: grid; place-items: center; font-size: var(--fs-sm); }

      .bottom-nav {
        position: sticky; bottom: 0; z-index: 50; display: grid; grid-template-columns: repeat(3, 1fr);
        background: rgba(255, 255, 255, 0.96); backdrop-filter: blur(10px); border-top: 1px solid var(--border); padding-bottom: env(safe-area-inset-bottom);
      }
      .bottom-nav button { position: relative; display: flex; flex-direction: column; align-items: center; gap: 0.15rem; min-height: 60px; justify-content: center; border: 0; background: none; color: var(--text-muted); font-size: 0.7rem; font-weight: 600; }
      .bottom-nav button.active { color: var(--primary); }
      .nav-count { position: absolute; top: 6px; left: calc(50% + 6px); min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--primary); color: #fff; font-size: 0.65rem; font-style: normal; display: grid; place-items: center; }
      .nav-count.pulse { background: var(--success); animation: pulse 1.6s infinite; }
      @keyframes pulse { 50% { box-shadow: 0 0 0 5px rgba(21, 128, 61, 0.25); } }
      .inline { display: inline-flex; vertical-align: -2px; }
    `,
  ],
})
export class WaiterMainComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private authService = inject(AuthService);
  private socketService = inject(SocketService);
  private offlineQueue = inject(OfflineQueueService);
  private ui = inject(UiService);
  private cdr = inject(ChangeDetectorRef);
  private subs: Subscription[] = [];

  readonly quickNotes = ['Less spicy', 'Extra spicy', 'No onion', 'No ice', 'Parcel'];

  currentWaiterName = '';
  tab: Tab = 'tables';
  inOrder = false;
  pane: OrderPane = 'menu';
  isOnline = navigator.onLine;
  queuedCount = 0;

  // Tables
  tables: TableItem[] = [];
  tablesLoading = true;
  selectedFloor: 'ground' | 'first' = 'ground';
  activeTable: TableItem | null = null;

  // Customer & order type
  orderType: 'dine_in' | 'takeaway' | 'delivery' = 'dine_in';
  showCustomerModal = false;
  customerPhone = '';
  customerName = '';
  customerAddress = '';
  savedAddresses: { label?: string; text: string; isDefault: boolean }[] = [];
  isReturningCustomer = false;
  lookupLoading = false;

  // Menu
  menuCategoriesRaw: { category: { name: string }; items: MenuItem[] }[] = [];
  categories: string[] = [];
  selectedCategory = '';
  searchQuery = '';

  // Cart
  cart: CartItem[] = [];
  isSubmitting = false;

  // My open orders (all types)
  myOrders: any[] = [];

  // Open order — setting it (re)loads its ticket statuses from the station screens
  private _currentOpenOrder: any = null;
  get currentOpenOrder(): any {
    return this._currentOpenOrder;
  }
  set currentOpenOrder(order: any) {
    const changed = order?._id !== this._currentOpenOrder?._id;
    this._currentOpenOrder = order;
    if (!order) this.orderTickets = [];
    else if (changed) this.loadOrderTickets();
  }

  // Kitchen (station screen) status
  orderTickets: any[] = [];
  readyTickets: any[] = [];

  // Dish sheet
  selectedDishSheet: MenuItem | null = null;
  sheetSelectedPortion: { label: string; price: number } | null = null;
  sheetQty = 1;
  sheetNote = '';

  ngOnInit(): void {
    this.currentWaiterName = this.authService.currentUser?.name || 'Waiter';

    this.subs.push(
      this.offlineQueue.isOnline$.subscribe((online) => (this.isOnline = online)),
      this.offlineQueue.queue$.subscribe((q) => (this.queuedCount = q.length)),
      this.offlineQueue.failed$.subscribe((f) => this.ui.error(f.message, 'Queued order not sent')),

      this.socketService.fromEvent<TableItem>('table:updated').subscribe((updated) => {
        const idx = this.tables.findIndex((t) => t._id === updated._id);
        if (idx !== -1) this.tables[idx] = updated;
        else this.tables.push(updated);
        if (this.activeTable?._id === updated._id) this.activeTable = updated;
        this.cdr.markForCheck();
      }),

      this.socketService.fromEvent<any>('order:updated').subscribe((updatedOrder) => {
        if (this.currentOpenOrder && this.currentOpenOrder._id === updatedOrder._id) {
          this.currentOpenOrder = updatedOrder;
          this.loadOrderTickets();
        }
        this.fetchMyOrders();
      }),

      this.socketService.reconnect$.subscribe(() => {
        this.fetchReadyTickets();
        this.fetchTables();
        this.fetchMyOrders();
      }),
      this.socketService.fromEvent<any>('ticket:updated').subscribe((ticket) => this.onTicketUpdated(ticket)),

      // Live menu availability changes
      this.socketService.fromEvent<any>('menu:updated').subscribe((updatedItem) => {
        if (!updatedItem) return;
        const targetId = String(updatedItem._id);
        for (const group of this.menuCategoriesRaw) {
          const idx = group.items.findIndex((i) => String(i._id) === targetId);
          if (idx !== -1) {
            // Deleted dishes disappear; out-of-stock ones stay visible but greyed out
            if (!updatedItem.active) group.items.splice(idx, 1);
            else group.items[idx] = { ...group.items[idx], ...updatedItem };
            break;
          }
        }
        if (!updatedItem.available || !updatedItem.active) {
          const had = this.cart.some((c) => String(c.menuItemId) === targetId);
          this.cart = this.cart.filter((c) => String(c.menuItemId) !== targetId);
          if (had) this.ui.warning(`${updatedItem.name} just went out of stock and was removed from the cart`);
          if (this.selectedDishSheet && String(this.selectedDishSheet._id) === targetId) {
            this.selectedDishSheet = null;
            this.ui.warning(`${updatedItem.name} just went out of stock`);
          }
        }
        this.fetchMenu();
      }),
    );

    this.fetchTables();
    this.fetchMenu();
    this.fetchMyOrders();
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  // ─── Derived view data ───────────────────────────────────────────────────
  get initials(): string {
    return this.currentWaiterName
      .split(/\s+/)
      .map((p) => p[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  get greeting(): string {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  }

  get groundTables(): TableItem[] {
    return this.tables.filter((t) => t.floor === 'ground');
  }

  get firstTables(): TableItem[] {
    return this.tables.filter((t) => t.floor === 'first');
  }

  get activeFloorTables(): TableItem[] {
    return this.selectedFloor === 'ground' ? this.groundTables : this.firstTables;
  }

  countBy(status: TableItem['status']): number {
    return this.activeFloorTables.filter((t) => t.status === status).length;
  }

  tableStatusLabel(s: TableItem['status']): string {
    return s === 'free' ? 'Free' : s === 'occupied' ? 'Occupied' : 'Bill asked';
  }

  get contextTitle(): string {
    if (this.activeTable) return `Table ${this.activeTable.name || this.activeTable.number}`;
    const name = this.currentOpenOrder?.customerSnapshot?.name || this.customerName;
    return `${this.orderType === 'delivery' ? 'Delivery' : 'Takeaway'}${name ? ' · ' + name : ''}`;
  }

  get contextSubtitle(): string {
    const parts: string[] = [];
    if (this.activeTable) parts.push(this.activeTable.floor === 'ground' ? 'Ground floor' : 'First floor');
    if (this.currentOpenOrder) parts.push(`Order #${this.currentOpenOrder.number}`);
    else parts.push('New order');
    return parts.join(' · ');
  }

  get billRequested(): boolean {
    return this.currentOpenOrder?.status === 'billed' || this.activeTable?.status === 'billing';
  }

  get readyForThisOrder(): number {
    return this.orderTickets.filter((k) => k.status === 'ready').length;
  }

  get displayedItems(): MenuItem[] {
    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase().trim();
      return this.inStockFirst(this.menuCategoriesRaw.flatMap((m) => m.items).filter((i) => i.name.toLowerCase().includes(q)));
    }
    const match = this.menuCategoriesRaw.find((m) => m.category.name === this.selectedCategory);
    return this.inStockFirst(match ? match.items : this.menuCategoriesRaw.flatMap((m) => m.items));
  }

  /** Out-of-stock dishes stay listed (so waiters can tell guests) but sink to the bottom. */
  private inStockFirst(items: MenuItem[]): MenuItem[] {
    return [...items].sort((a, b) => Number(b.available !== false) - Number(a.available !== false));
  }

  get cartTotalCount(): number {
    return this.cart.reduce((sum, item) => sum + item.qty, 0);
  }

  get cartTotalPrice(): number {
    return this.cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  }

  qtyInCart(menuItemId: string): number {
    return this.cart.filter((c) => c.menuItemId === menuItemId).reduce((s, c) => s + c.qty, 0);
  }

  activeItemCount(o: any): number {
    return (o.items || []).filter((i: any) => i.status === 'active').reduce((s: number, i: any) => s + i.qty, 0);
  }

  orderTotal(o: any): number {
    return (o?.items || []).filter((i: any) => i.status === 'active').reduce((s: number, i: any) => s + i.price * i.qty, 0);
  }

  orderTitle(o: any): string {
    if (o.type === 'dine_in') return `Table ${o.tableId?.name || o.tableId?.number || ''}`;
    return `${o.type === 'delivery' ? 'Delivery' : 'Takeaway'} · ${o.customerSnapshot?.name || ''}`;
  }

  typeIcon(type: string): string {
    return type === 'delivery' ? 'bike' : type === 'takeaway' ? 'bag' : 'table';
  }

  timeAgo(iso: string): string {
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    return mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)} h ${mins % 60} min ago`;
  }

  // ─── Data loading ────────────────────────────────────────────────────────
  fetchTables(): void {
    this.http.get<{ tables: TableItem[] }>(`${environment.apiUrl}/tables`).subscribe({
      next: (res) => {
        this.tables = res.tables || [];
        this.tablesLoading = false;
      },
      error: () => (this.tablesLoading = false),
    });
  }

  fetchMenu(): void {
    this.http.get<{ menu: { category: { name: string }; items: MenuItem[] }[] }>(`${environment.apiUrl}/menu`).subscribe({
      next: (res) => {
        this.menuCategoriesRaw = res.menu || [];
        this.categories = this.menuCategoriesRaw.map((m) => m.category.name);
        if (this.categories.length && !this.categories.includes(this.selectedCategory)) this.selectedCategory = this.categories[0];
      },
    });
  }

  fetchMyOrders(): void {
    this.http.get<{ orders: any[] }>(`${environment.apiUrl}/orders?status=open`).subscribe({
      next: (res) => (this.myOrders = res.orders || []),
      error: () => {},
    });
  }

  showOrders(): void {
    this.tab = 'orders';
    this.fetchMyOrders();
  }

  // ─── Entering / leaving an order ─────────────────────────────────────────
  private enterOrder(pane: OrderPane): void {
    this.inOrder = true;
    this.pane = pane;
    this.searchQuery = '';
    window.scrollTo({ top: 0 });
  }

  async leaveOrder(): Promise<void> {
    if (this.cart.length) {
      const ok = await this.ui.confirm({
        title: 'Discard unsent items?',
        message: `${this.cartTotalCount} item(s) haven't been sent to the kitchen yet.`,
        confirmText: 'Discard',
        cancelText: 'Keep editing',
        danger: true,
      });
      if (!ok) return;
    }
    this.cart = [];
    this.inOrder = false;
    this.currentOpenOrder = null;
    this.activeTable = null;
    this.fetchMyOrders();
  }

  onTableClick(table: TableItem): void {
    this.activeTable = table;
    this.orderType = 'dine_in';
    this.cart = [];

    if (table.status === 'free') {
      this.currentOpenOrder = null;
      this.enterOrder('menu');
      return;
    }
    this.http.get<{ orders: any[] }>(`${environment.apiUrl}/orders?tableId=${table._id}&status=open`).subscribe({
      next: (res) => {
        if (res.orders.length > 0) {
          this.currentOpenOrder = res.orders[0];
          this.enterOrder('sent');
        } else {
          // Waiters only see their own orders — the table belongs to someone else
          this.activeTable = null;
          this.ui.info(
            table.status === 'billing' ? 'This table is waiting for the bill.' : 'Another waiter is serving this table.',
            `Table ${table.name || table.number}`,
          );
        }
      },
      error: (err) => this.ui.apiError(err, 'Could not open the table'),
    });
  }

  openOrder(o: any): void {
    this.cart = [];
    this.orderType = o.type;
    this.activeTable = o.type === 'dine_in' ? this.tables.find((t) => t._id === (o.tableId?._id ?? o.tableId)) ?? null : null;
    this.customerName = o.customerSnapshot?.name ?? '';
    this.currentOpenOrder = o;
    this.enterOrder('sent');
  }

  // ─── Customer (takeaway / delivery) ──────────────────────────────────────
  get isCustomerValid(): boolean {
    if (!this.customerPhone || this.customerPhone.trim().length < 10) return false;
    if (!this.customerName || !this.customerName.trim()) return false;
    if (this.orderType === 'delivery' && !this.customerAddress?.trim()) return false;
    return true;
  }

  onPhoneChange(): void {
    this.customerPhone = this.customerPhone.replace(/\D/g, '').slice(0, 10);
    const cleaned = this.customerPhone;
    if (cleaned.length !== 10) {
      this.isReturningCustomer = false;
      return;
    }
    this.lookupLoading = true;
    this.http.get<{ found: boolean; customer?: any }>(`${environment.apiUrl}/customers/lookup?phone=${cleaned}`).subscribe({
      next: (res) => {
        this.lookupLoading = false;
        if (res.found && res.customer) {
          this.isReturningCustomer = true;
          this.customerName = res.customer.name;
          this.savedAddresses = res.customer.addresses || [];
          const def = this.savedAddresses.find((a) => a.isDefault) ?? this.savedAddresses[0];
          if (def) this.customerAddress = def.text;
        } else {
          this.isReturningCustomer = false;
        }
      },
      error: () => {
        this.lookupLoading = false;
        this.isReturningCustomer = false;
      },
    });
  }

  private startCustomerOrder(type: 'takeaway' | 'delivery'): void {
    this.activeTable = null;
    this.currentOpenOrder = null;
    this.orderType = type;
    this.customerPhone = '';
    this.customerName = '';
    this.customerAddress = '';
    this.savedAddresses = [];
    this.isReturningCustomer = false;
    this.showCustomerModal = true;
  }

  startTakeawayOrder(): void {
    this.startCustomerOrder('takeaway');
  }

  startDeliveryOrder(): void {
    this.startCustomerOrder('delivery');
  }

  confirmCustomerAndOpenMenu(): void {
    this.showCustomerModal = false;
    this.cart = [];
    this.enterOrder('menu');
  }

  // ─── Dishes & cart ───────────────────────────────────────────────────────
  openItemSheet(item: MenuItem): void {
    if (!item.available) {
      this.ui.info('The kitchen has marked this dish out of stock.', item.name);
      return;
    }
    this.selectedDishSheet = item;
    this.sheetSelectedPortion = item.portions?.length ? item.portions[0] : null;
    this.sheetQty = 1;
    this.sheetNote = '';
  }

  /** "+" adds instantly when there's nothing to choose; otherwise opens the sheet. */
  quickAdd(item: MenuItem, event: Event): void {
    event.stopPropagation();
    if (!item.available) return;
    if (item.portions?.length) {
      this.openItemSheet(item);
      return;
    }
    this.addToCart({ menuItemId: item._id, name: item.name, price: item.price, qty: 1, station: item.station });
    navigator.vibrate?.(15);
  }

  appendNote(n: string): void {
    const cur = this.sheetNote.trim();
    if (cur.toLowerCase().includes(n.toLowerCase())) return;
    this.sheetNote = cur ? `${cur}, ${n.toLowerCase()}` : n;
  }

  getSheetPrice(): number {
    if (!this.selectedDishSheet) return 0;
    return (this.sheetSelectedPortion?.price ?? this.selectedDishSheet.price) * this.sheetQty;
  }

  addSheetItemToCart(): void {
    const dish = this.selectedDishSheet;
    if (!dish) return;
    this.addToCart({
      menuItemId: dish._id,
      name: dish.name,
      price: this.sheetSelectedPortion?.price ?? dish.price,
      qty: this.sheetQty,
      portion: this.sheetSelectedPortion?.label,
      note: this.sheetNote.trim() || undefined,
      station: dish.station,
    });
    this.selectedDishSheet = null;
  }

  /** Same dish + size + note merges into one line. */
  private addToCart(line: CartItem): void {
    const existing = this.cart.find((c) => c.menuItemId === line.menuItemId && c.portion === line.portion && c.note === line.note);
    if (existing) existing.qty += line.qty;
    else this.cart.push(line);
    this.cart = [...this.cart];
  }

  changeQty(item: CartItem, delta: number): void {
    item.qty += delta;
    if (item.qty <= 0) this.cart = this.cart.filter((c) => c !== item);
  }

  removeFromCart(index: number): void {
    this.cart.splice(index, 1);
  }

  // ─── Sending ─────────────────────────────────────────────────────────────
  sendOrder(): void {
    if (this.cart.length === 0 || this.isSubmitting) return;
    this.isSubmitting = true;
    const clientRequestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const items = this.cart.map(({ menuItemId, qty, portion, note }) => ({ menuItemId, qty, portion, note }));

    if (this.currentOpenOrder) {
      const orderId = this.currentOpenOrder._id;
      if (!this.isOnline) {
        this.offlineQueue.enqueue({ clientRequestId, type: 'add_items', orderId, payload: { items, clientRequestId } });
        this.afterSend(true);
        return;
      }
      this.http.post<any>(`${environment.apiUrl}/orders/${orderId}/items`, { items, clientRequestId }).subscribe({
        next: (res) => {
          this.currentOpenOrder = res.order;
          this.loadOrderTickets();
          this.afterSend(false);
        },
        error: (err) => this.sendFailed(err),
      });
      return;
    }

    const payload: any = { clientRequestId, items };
    if (this.activeTable) {
      payload.type = 'dine_in';
      payload.tableId = this.activeTable._id;
    } else {
      payload.type = this.orderType;
      payload.customerSnapshot = {
        name: this.customerName.trim(),
        phone: this.customerPhone.trim(),
        ...(this.orderType === 'delivery' ? { address: this.customerAddress.trim() } : {}),
      };
    }

    if (!this.isOnline) {
      this.offlineQueue.enqueue({ clientRequestId, type: 'create_order', payload });
      this.cart = [];
      this.isSubmitting = false;
      this.inOrder = false;
      this.activeTable = null;
      this.ui.warning("You're offline — the order will send automatically when you reconnect.", 'Order queued');
      return;
    }

    this.http.post<any>(`${environment.apiUrl}/orders`, payload).subscribe({
      next: (res) => {
        this.currentOpenOrder = res.order;
        this.fetchTables();
        this.fetchMyOrders();
        this.afterSend(false);
      },
      error: (err) => this.sendFailed(err),
    });
  }

  private afterSend(queued: boolean): void {
    const count = this.cartTotalCount;
    this.cart = [];
    this.isSubmitting = false;
    this.pane = 'sent';
    if (queued) this.ui.warning("You're offline — these items will send automatically when you reconnect.", 'Queued');
    else this.ui.success(`${count} item${count === 1 ? '' : 's'} sent to the kitchen`);
  }

  private sendFailed(err: any): void {
    this.isSubmitting = false;
    this.ui.apiError(err, 'Could not send the order');
  }

  async cancelItem(item: any): Promise<void> {
    if (!this.currentOpenOrder) return;
    const ok = await this.ui.confirm({
      title: `Cancel ${item.qty}× ${item.name}?`,
      message: 'The kitchen screen will show this as a cancellation. This is logged.',
      confirmText: 'Cancel item',
      cancelText: 'Keep',
      danger: true,
    });
    if (!ok) return;
    this.http.patch<any>(`${environment.apiUrl}/orders/${this.currentOpenOrder._id}/items/${item._id}/cancel`, {}).subscribe({
      next: async (res) => {
        this.currentOpenOrder = res.order;
        this.loadOrderTickets();
        this.ui.success(`${item.name} cancelled`);
        // Last item gone: offer to close the order instead of leaving an empty table occupied
        if (!this.hasActiveItems) {
          const close = await this.ui.confirm({
            title: 'That was the last item',
            message: `Close the order${res.order.type === 'dine_in' ? ' and free the table' : ''}? Choose "Keep open" to add something else.`,
            confirmText: 'Close order',
            cancelText: 'Keep open',
          });
          if (close) this.closeEmptyOrder(true);
        }
      },
      error: (err) => this.ui.apiError(err, 'Could not cancel the item'),
    });
  }

  get hasActiveItems(): boolean {
    return !!this.currentOpenOrder?.items?.some((i: any) => i.status === 'active');
  }

  /** Close an order whose items were all cancelled (frees the table). */
  async closeEmptyOrder(confirmed = false): Promise<void> {
    const o = this.currentOpenOrder;
    if (!o) return;
    if (!confirmed) {
      const ok = await this.ui.confirm({
        title: 'Close this order?',
        message: `Nothing is billed${o.type === 'dine_in' ? ' and the table becomes free' : ''}.`,
        confirmText: 'Close order',
      });
      if (!ok) return;
    }
    this.http.post<{ message: string }>(`${environment.apiUrl}/orders/${o._id}/cancel`, {}).subscribe({
      next: (res) => {
        this.ui.success(res.message || 'Order closed');
        this.cart = [];
        this.inOrder = false;
        this.currentOpenOrder = null;
        this.activeTable = null;
        this.fetchTables();
        this.fetchMyOrders();
      },
      error: (err) => this.ui.apiError(err, 'Could not close the order'),
    });
  }

  requestBill(): void {
    if (!this.currentOpenOrder || !this.activeTable) return;
    this.http.post<{ table: TableItem }>(`${environment.apiUrl}/tables/${this.activeTable._id}/request-bill`, {}).subscribe({
      next: (res) => {
        this.activeTable = res.table;
        this.ui.success('The cashier has been notified', 'Bill requested');
      },
      error: (err) => this.ui.apiError(err, 'Could not request the bill'),
    });
  }

  // ─── Kitchen status (station screens) ────────────────────────────────────
  stationLabel(station: string): string {
    return STATION_NAMES[station] || station;
  }

  ticketStatusLabel(status: string): string {
    return TICKET_STATUS[status] || status;
  }

  ticketBadge(status: string): string {
    return status === 'ready' ? 'badge-success' : status === 'preparing' ? 'badge-warning' : status === 'new' ? 'badge-info' : '';
  }

  ticketItemsSummary(k: any): string {
    const items = k.isEdited ? k.addedItems || [] : k.items || [];
    const add = items.map((i: any) => `${i.qty}× ${i.name}`).join(', ');
    const cancel = (k.isEdited ? k.cancelledItems || [] : []).map((i: any) => `−${i.qty}× ${i.name}`).join(', ');
    return [add, cancel].filter(Boolean).join(' · ');
  }

  ticketHeader(k: any): string {
    const c = k.context || {};
    if (c.orderType === 'dine_in') return `Table ${c.tableLabel ?? ''}`.replace(/^Table (\d+)$/, 'Table T$1');
    if (c.orderType === 'takeaway') return `Takeaway · ${c.customerName ?? ''}`;
    return `Delivery · ${c.customerName ?? ''}`;
  }

  loadOrderTickets(): void {
    const id = this.currentOpenOrder?._id;
    if (!id) return;
    this.http.get<{ tickets: any[] }>(`${environment.apiUrl}/orders/${id}/tickets`).subscribe({
      next: (res) => {
        if (this.currentOpenOrder?._id === id) this.orderTickets = res.tickets || [];
      },
      error: () => {},
    });
  }

  private fetchReadyTickets(): void {
    this.http.get<{ tickets: any[] }>(`${environment.apiUrl}/tickets?status=ready`).subscribe({
      next: (res) => (this.readyTickets = res.tickets || []),
      error: () => {},
    });
  }

  private onTicketUpdated(ticket: any): void {
    const idx = this.orderTickets.findIndex((k) => k._id === ticket._id);
    if (idx !== -1) this.orderTickets[idx] = ticket;
    else if (ticket.orderId === this.currentOpenOrder?._id) this.orderTickets.push(ticket);
    this.orderTickets = [...this.orderTickets];

    const wasReady = this.readyTickets.some((k) => k._id === ticket._id);
    this.readyTickets = this.readyTickets.filter((k) => k._id !== ticket._id);
    if (ticket.status === 'ready') {
      this.readyTickets = [...this.readyTickets, ticket];
      if (!wasReady) {
        navigator.vibrate?.([200, 100, 200]);
        this.ui.success(`${this.stationLabel(ticket.station)}: ${this.ticketItemsSummary(ticket)}`, `${this.ticketHeader(ticket)} is ready`);
      }
    }
  }

  markServed(k: any): void {
    this.http.post<{ ticket: any }>(`${environment.apiUrl}/tickets/${k._id}/served`, {}).subscribe({
      next: (res) => this.onTicketUpdated(res.ticket),
      error: (err) => this.ui.apiError(err, 'Could not mark as served'),
    });
  }

  async logout(): Promise<void> {
    const ok = await this.ui.confirm({ title: 'Sign out?', message: 'Unsent items on this phone will be lost.', confirmText: 'Sign out' });
    if (ok) this.authService.logout();
  }
}
