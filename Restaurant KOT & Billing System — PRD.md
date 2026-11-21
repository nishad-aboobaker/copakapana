# Restaurant KOT & Billing System — PRD

Nov 19, 2026 · @nishad · **Revised Nov 21, 2026: kitchen station screens (KDS) replace KOT printers**

> **What changed in this revision.** The three station KOT printers are replaced by one screen per kitchen station (a kitchen display system, KDS). KOTs now appear on the station's screen in real time instead of printing. The cashier bill printer stays, so the print agent remains but handles bills only. Station screens add a cook workflow (New → Preparing → Ready), a live "ready" signal to waiters and the cashier, and kitchen timing data.

## Overview and goals

This system lets one family-dining restaurant take orders on waiter phones, show kitchen order tickets (KOTs) on a screen at each of the three kitchen stations, and bill dine-in, takeaway and in-house delivery orders from a cashier PC. It is a single-restaurant prototype with no table booking, built on an Angular PWA, Node/Express and MongoDB.

**Goals**

- A waiter sends an order from a phone and the KOT appears on the right station screen within 2 seconds on normal connectivity.
- No order is lost: a dropped connection queues the order on the phone and sends it on reconnect; a station screen that drops off catches up with every open KOT when it reconnects.
- The kitchen marks each KOT Preparing and Ready on the screen; the waiter's phone and the cashier panel show it as ready to serve.
- The cashier closes a bill in under 30 seconds.
- Edits after a KOT is sent reach the kitchen as a clearly flagged "EDITED" KOT on the station screen.
- The owner gets daily sales, item-wise sales, cash vs UPI totals, order-type split, waiter-wise sales and kitchen preparation times.
- The owner manages staff, station screens, menu, tables and the bill printer without a developer.

**Success criteria for the prototype**

- A full day of simulated service (dine-in, takeaway, delivery) runs end to end with correct KOTs on screens, bills and reports.
- Every KOT, status change, edit, cancellation and discount is traceable to a user and a time.

## Scope and decisions made

The restaurant has two floors: 3 tables on the ground floor and 13 on the first floor. Seat capacity is a plain editable field and is not a design concern.

| Area | Decision |
| --- | --- |
| Tenancy | Single restaurant, no multi-tenant, no `restaurantId` on documents |
| Order types | Dine-in, takeaway, in-house delivery. No Zomato/Swiggy integration |
| Table booking | None. Walk-in only, so tables only need free/occupied/billing status |
| Kitchen stations | Three: fried chicken, juice counter, main (all other food) |
| **KOT output** | **One screen per station (touch tablet or touch monitor running the web app). No KOT printers** |
| KOT workflow | New → Preparing → Ready (on the station screen) → Served (waiter or station) |
| Bill output | One Ethernet thermal printer at the cashier counter, driven by the print agent |
| Waiter device | Waiters' own phones, on their mobile data or the restaurant WiFi |
| Hosting | Cloud server reachable from the internet; station screens on restaurant WiFi; print agent on the restaurant PC |
| GST and service charge | Off for now. Kept as settings (default 0) so they can be switched on later |
| Payments | Cash and UPI, recorded manually by the cashier. No payment gateway |
| Discounts | Cashier only, from the PC. Not available in the waiter app |
| Order edits | New KOT shown on the affected station screen(s) with added/cancelled items and an "EDITED" flag |
| Delivery | No tracking, no delivery-staff assignment. Order carries customer name, phone, address |
| Customers | Remembered by phone number to prefill repeat delivery/takeaway orders |
| Reports | Daily sales, item-wise, cash vs UPI, order-type split, waiter-wise, kitchen prep time per station |
| Admin | Staff and station-screen accounts, menu designer, table management, settings |

**Out of scope for the prototype**

- Online or customer-facing booking and ordering
- Delivery partner integrations and delivery tracking
- Payment gateways, GST invoicing, loyalty and coupons
- KOT printers (removed; a fallback "print KOT" is a later enhancement)
- Customer-facing order-status screens
- Multi-restaurant support

**Assumptions to confirm**

- Cancelling an item after the KOT is sent needs no approval but is logged with user and time.
- One bill printer exists at the cashier counter.
- Each station screen is a touch device (so cooks can tap Start / Ready). A non-touch TV would need a bump bar or a view-only mode.
- Station screens sit on the restaurant WiFi with a stable connection; a station screen going offline must be visible to the cashier immediately.

## Users and roles

Four staff roles plus one device role, each with a fixed permission set. Waiters and station screens log in with a short PIN; the owner, manager and cashier use a password on the PC.

| Role | Device | Can do | Cannot do |
| --- | --- | --- | --- |
| Waiter | Own phone (PWA) | Pick table, take dine-in/takeaway/delivery orders, send KOT, add or remove items on an open order, see own orders' KOT status (preparing / ready), mark ready KOTs served, request bill | Apply discounts, take payment, view reports, edit menu or staff |
| Cashier | Restaurant PC | Everything a waiter can, plus bill, apply discount, record cash/UPI payment, see all KOT statuses, resend a KOT to a station screen, reprint bills, view today's sales | Manage staff, edit menu, change settings |
| Manager | Restaurant PC | Everything a cashier can, plus reports and menu availability toggles | Manage staff roles and settings |
| Owner/Admin | Restaurant PC or phone | Everything, including staff and station-screen accounts, menu designer, tables, bill printer, settings, all reports and audit log | None |
| **Kitchen (station screen)** | Tablet/monitor at one station | See open KOTs for **its own station only**, mark Preparing / Ready / Served, recall the last cleared KOT, mark its own station's dishes in or out of stock | Everything else: no orders, billing, menu editing, reports or other stations |

A kitchen account is bound to exactly one station when the owner creates it. It is a device account, not a person: it stays logged in all day and refreshes its token silently.

**Permission rules**

- Discount endpoints require the cashier role or higher and are not exposed in the waiter app.
- A waiter sees and edits only orders they opened, unless a cashier or higher reassigns it.
- A kitchen account can only read and update KOTs whose station matches its own; every staff endpoint rejects it.
- Deactivated staff or screens cannot log in but their past orders, KOTs and reports stay intact.

## Architecture

Phones, station screens and the cashier panel all talk to one cloud server over HTTPS and Socket.IO. The print agent on the restaurant PC connects out to that server and prints bills to the counter printer on the local network.

```text
 Waiter phones ─┐                          ┌─► Station screen: Fried chicken
 Cashier PC  ───┼──► Cloud server (API +  ─┼─► Station screen: Juice
 Owner phone ───┘    Socket.IO + MongoDB)  └─► Station screen: Main
                           │
                           └──► Print agent (restaurant PC) ──► Bill printer (Ethernet, 9100)
```

**Stack:** Angular PWA (waiter app, station screen, cashier/admin panel), Node.js with Express, MongoDB, Socket.IO, and a Node print agent using ESC/POS for bills. All three packages live in one repo.

## Functional requirements by module

**M1. Auth and staff**

- PIN login for waiters and station screens, password login for cashier, manager and owner; JWT with role claim (and station claim for kitchen accounts).
- Owner creates, edits, deactivates staff and station-screen accounts, and resets PINs.
- Failed-login lockout after 5 attempts for 5 minutes.

**M2. Tables and floors**

- Two floors (Ground: 3 tables, First: 13 tables), each table has number, floor, capacity and status (free, occupied, billing).
- Status changes automatically: opening an order sets occupied, requesting the bill sets billing, payment sets free.
- Owner can add, rename, move or disable tables.
- Waiter app shows a floor switcher and a live table grid; changes sync to all phones over Socket.IO.

**M3. Menu designer**

- Categories with display order; items with name, price, station (fried chicken, juice, main), veg/non-veg flag, description, availability toggle.
- Optional portions (half/full) and modifiers or free-text notes (for example "no onion", "less spicy").
- Mark an item out of stock and it shows greyed out as "Out of stock" in the waiter app immediately; it cannot be ordered. Managers and owners toggle stock in the menu; each station screen toggles stock for its own station's dishes.
- Menu changes never alter the price on existing orders (prices are snapshotted into order items).

**M4. Orders**

- Order types: dine-in (needs a table), takeaway (needs customer name and phone), delivery (needs name, phone, address).
- One open order per table (an order in billing also blocks the table); takeaway and delivery orders are independent of tables.
- Waiter searches the menu, adds items with quantity, portion and note, and sends the order.
- Order status: open, billed, paid, cancelled.
- Transfer an order to another table; merge two tables' orders into one bill (cashier).

**M5. KOT and station screens (KDS)**

- Sending an order creates one KOT per station that has items, so one order can produce up to three KOTs. Each appears on its station's screen within 2 seconds.
- A KOT's content is immutable. Each has a running number, order reference, order type with table or customer, waiter, time and items. Only its kitchen status changes.
- KOT kitchen status: **new → preparing → ready → served**. The station screen taps move it forward; "served" is set by the waiter (or by the station's Clear button for takeaway/delivery handed over at the pass).
- Edits after sending create a new KOT with an "EDITED" flag listing items under ADD and CANCEL, shown only on the affected stations, and referencing the original KOT number.
- A station screen shows:
  - Columns or lanes for New, Preparing and Ready, oldest first.
  - Each card: KOT number, order type and table/customer, waiter, elapsed time, items with qty/portion/note, and the EDITED flag in red.
  - Elapsed timer turns amber after the "warn" threshold and red after the "late" threshold (settings, default 10 and 15 minutes).
  - A sound and a flash when a new or edited KOT arrives (sound can be muted in settings).
  - Recall: bring back the last cleared KOT for 5 minutes in case of a mis-tap.
  - A connection indicator; on reconnect the screen reloads all open KOTs for its station.
- The waiter app shows each sent KOT's status on the open order and a "Ready" notification for the waiter's own orders.
- The cashier panel shows every station screen's online/offline status, and any KOT not acknowledged by a screen within 10 seconds as an alert with a "Resend" button.
- Cashier can resend any KOT to its station screen; resends are labelled "RESENT" on the card and logged.

**M6. Bill printing**

- A print agent on the restaurant PC connects out to the server and prints bills to the counter printer on port 9100 using ESC/POS.
- Bill printer IP is stored in settings and editable by the owner, with a test-print button.
- Every bill print job is stored on the server. Failed prints retry 3 times, then raise an alert in the cashier panel with a one-click reprint. Jobs queued while the agent is offline are sent when it reconnects.

**M7. Billing**

- Cashier opens an order, reviews items, and generates the bill.
- Bill shows items, subtotal, discount, GST and service charge (both 0 by default), grand total.
- Discount: flat amount or percentage, cashier role or higher only, with a mandatory reason; logged with user and time.
- Payment modes: cash and UPI, with split payment across the two. Cash records amount tendered and change.
- Closing the bill marks the order paid, frees the table and prints the bill.
- Paid bills are immutable; corrections need a void by the owner, with reason.

**M8. Customers**

- Customer record keyed by phone number: name, saved addresses, order count, last order date.
- Typing a phone number on a takeaway or delivery order prefills the details; new numbers are saved automatically.

**M9. Reports**

- Daily sales (total, order count, average bill).
- Item-wise sales (quantity and revenue per item, filterable by category and station).
- Cash vs UPI totals.
- Order-type split: dine-in vs takeaway vs delivery.
- Waiter-wise sales (orders and revenue per waiter).
- **Kitchen performance: per station, KOT count and average/longest time from sent to ready.**
- All reports take a date range, and export to CSV.
- End-of-day summary the cashier can print.

**M10. Admin and settings**

- Staff and station-screen management, menu designer, table management, bill printer IP, restaurant name and address for the bill header, GST and service-charge toggles, KDS warn/late thresholds and sound.
- Audit log: KOT edits, KOT status changes, resends, item cancellations, discounts, voids, bill reprints, logins.

## Data model (MongoDB)

Ten collections plus an audit log. Prices and item names are snapshotted into orders so later menu edits never change history.

| Collection | Key fields | Notes |
| --- | --- | --- |
| `User` | name, role, station, pinHash, passwordHash, active | Role: waiter, cashier, manager, owner, kitchen. `station` is required only for kitchen |
| `Table` | number, floor (ground/first), capacity, status, active | Status: free, occupied, billing |
| `MenuCategory` | name, order, active | Display order in the waiter app |
| `MenuItem` | name, categoryId, price, station, isVeg, portions\[\], available, active | Station: fried\_chicken, juice, main |
| `Customer` | phone (unique), name, addresses\[\], orderCount, lastOrderAt | Prefill for takeaway and delivery |
| `Order` | number, type, tableId, waiterId, customerId, customerSnapshot, status, items\[\], createdAt | Type: dine\_in, takeaway, delivery. One open order per table |
| `KOT` | number, orderId, station, context{orderNumber, orderType, tableLabel, waiterName, customer}, items\[\], isEdited, againstKotNumber, addedItems\[\], cancelledItems\[\], status, deliveredAt, startedAt, readyAt, servedAt, resendCount, createdBy | Content immutable; status: new, preparing, ready, served |
| `Bill` | number, orderId, itemsSnapshot\[\], closedBy, closedByName, subtotal, discount{type, value, reason, appliedBy}, gst, serviceCharge, total, payments\[\], status, paidAt | Status: open, paid, void |
| `PrintJob` | type (bill, test), targetIp, payload, status, attempts, lastError | Bill printing queue; survives restarts |
| `Settings` | restaurantName, address, phone (one or more), billFooter, billFooterNote, printLogo, gstEnabled, gstRate, serviceChargeEnabled, serviceChargePercent, billPrinterIp, kdsWarnMinutes, kdsLateMinutes, kdsSoundEnabled | Single document |
| `AuditLog` | action, userId, entity, entityId, before, after, createdAt | KOT edits/status/resends, cancellations, discounts, voids, reprints, logins |

**Order item shape**

`{ menuItemId, name, price, qty, portion, note, station, status }` where status is active or cancelled. Cancelled items stay on the order for the audit trail but are excluded from the bill.

**Key rules**

- Unique index on open order per table so a table cannot have two open orders.
- KOT numbers and order numbers run in sequence per day (reset at the restaurant's day-end), and bill numbers run in a continuous sequence.
- Indexes: `Order(createdAt)`, `Order(waiterId, createdAt)`, `Bill(paidAt)`, `Customer(phone)`, `KOT(orderId)`, `KOT(station, status, createdAt)`.
- Day boundaries use Asia/Kolkata time.

## API and real-time events

REST over HTTPS under `/api/v1`, JWT bearer auth, role checks in middleware. Socket.IO carries live updates to phones, station screens and the cashier panel, and bill print jobs to the print agent.

| Module | Endpoints | Min. role |
| --- | --- | --- |
| Auth | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` | public / any incl. kitchen |
| Staff | `GET/POST /users`, `PATCH /users/:id`, `POST /users/:id/reset-pin` | owner |
| Tables | `GET /tables`, `POST /tables`, `PATCH /tables/:id`, `POST /tables/:id/request-bill` | any / owner / waiter |
| Menu | `GET /menu`, `POST/PATCH/DELETE /categories`, `POST/PATCH/DELETE /items`, `PATCH /items/:id/availability` | any / owner; availability: manager |
| Orders | `POST /orders`, `GET /orders?status=&type=`, `GET /orders/:id`, `POST /orders/:id/items`, `PATCH /orders/:id/items/:itemId/cancel`, `POST /orders/:id/transfer`, `POST /orders/merge` | waiter; transfer/merge: cashier |
| KOT (staff) | `GET /orders/:id/kots`, `GET /kots?status=&station=`, `POST /kots/:id/served`, `POST /kots/:id/resend` | waiter / cashier for resend |
| KOT (station) | `GET /kds/kots` (own station, open only), `POST /kds/kots/:id/status` {preparing, ready, served}, `POST /kds/kots/:id/recall`, `GET /kds/menu`, `PATCH /kds/items/:id/availability` (own station's dishes) | kitchen |
| Billing | `POST /orders/:id/bill`, `POST /bills/:id/discount`, `POST /bills/:id/payments`, `POST /bills/:id/close`, `POST /bills/:id/void`, `POST /bills/:id/reprint` | cashier; void: owner |
| Customers | `GET /customers/lookup?phone=` | waiter |
| Reports | `GET /reports/daily`, `/reports/items`, `/reports/payments`, `/reports/order-types`, `/reports/waiters`, `/reports/kitchen`, `GET /reports/*?format=csv` | manager |
| Settings | `GET/PATCH /settings`, `POST /settings/printers/bill/test`, `GET /settings/failed-jobs` | owner (GET: any) / cashier for failed jobs |
| Station status | `GET /kds/status` | cashier |
| Audit | `GET /audit?from=&to=&action=` | owner |

**Socket.IO events**

| Event | Direction | Purpose |
| --- | --- | --- |
| `table:updated` | server to all staff | Table status changes, keeps every phone's grid current |
| `order:updated` | server to cashier panel and owning waiter | New items, cancellations, status |
| `menu:updated` | server to all clients | Availability or price change |
| `kot:new` | server to `station:<station>` room | A new, edited or resent KOT for that station screen |
| `kot:received` | station screen to server (with ack) | Screen confirms the KOT is displayed; sets `deliveredAt` |
| `kot:updated` | server to station room, cashier panel and owning waiter | Status change (preparing, ready, served, recalled) |
| `kds:status` | server to cashier panel | Which station screens are online |
| `kot:undelivered` | server to cashier panel | A KOT not acknowledged by its screen within 10 seconds |
| `print:job` | server to print agent | Bill or test-print payload with target printer IP |
| `print:result` | print agent to server | Success or failure with error, drives retry and alerts |
| `agent:status` | print agent to server; server to cashier | Heartbeat every 15 seconds; cashier panel shows agent online/offline |

**Conventions**

- Order creation and add-items take a client-generated `clientRequestId` so a retry from the offline queue never creates a duplicate order, item or KOT.
- Errors use one shape: `{ code, message, details }`.
- All list endpoints paginate; report endpoints take `from` and `to` dates in Asia/Kolkata.
- Socket connections authenticate with the current access token on every (re)connect, so screens survive token expiry.

## Station screen (KDS) specification

Screens are landscape tablets or monitors (minimum 1024 px wide), dark background, large type readable from 2 metres. One screen per station.

**Standard KOT card**

```text
┌──────────────────────────────┐
│ #014   DINE-IN · First T7    │
│ Anu            ⏱ 04:12       │
├──────────────────────────────┤
│ 2 × Fried Chicken (Full)     │
│     note: extra spicy        │
│ 1 × Chicken Wings            │
├──────────────────────────────┤
│ Order #231      [ START ▶ ]  │
└──────────────────────────────┘
```

**Edited KOT card** (red border and red "EDITED" banner so the kitchen cannot miss it)

```text
┌──────── EDITED · vs #014 ────┐
│ #019   DINE-IN · First T7    │
│ Anu            ⏱ 00:20       │
├──────────────────────────────┤
│ ADD:                          │
│   1 × Chicken Wings           │
│ CANCEL:                       │
│   1 × Fried Chicken (Full)    │  ← struck through
├──────────────────────────────┤
│ Order #231      [ START ▶ ]  │
└──────────────────────────────┘
```

**Display rules**

- Type headers: dine-in shows floor and table; takeaway shows "TAKEAWAY" and customer name; delivery shows "DELIVERY", customer name and phone.
- Cards sort oldest first in each lane. Buttons: New → **Start**, Preparing → **Ready**, Ready → **Clear** (served).
- Timer colours: normal until `kdsWarnMinutes`, amber until `kdsLateMinutes`, red after.
- An edit that touches several stations shows one edited card per affected station only.
- Item names display in English; an optional per-item `printName` (short or local-language name) is used on the card when set.
- Resent cards carry a "RESENT" tag with the time.
- Tap targets at least 64 px; no double-tap needed; actions are undoable via Recall.

**Failure handling**

- Each screen confirms every KOT with `kot:received`. A KOT not confirmed within 10 seconds raises an alert in the cashier panel with a Resend button.
- If a station screen is offline, the cashier panel shows a red banner naming the station. KOTs are still stored on the server; the screen loads every open KOT for its station when it reconnects, so nothing is lost.
- The server never deletes or alters a KOT's content; status changes are logged.

## Bill print specification

The bill prints on the 80 mm counter printer (42 characters per line assumed; confirm against the model) over ESC/POS on TCP port 9100, in the same layout as the restaurant's existing receipt:

```text
              [logo]
      CopaKapana Restaurant        (bold, double height)
           Chamravattam
          Mob: 9072211810
               9072211820
               9072211830
------------------------------------------
Trans#      : 22814
Cashier     : CASHIER
Date        : 21-11-2026 15:20:13
Table No    : None
------------------------------------------
Item                 Qty     Rate    Total
------------------------------------------
PARATHA                3    15.00    45.00
PEPSI 20               1    20.00    20.00
------------------------------------------
Net Total    :                       65.00  (bold, double height)
Paid by     : CASH 65.00
------------------------------------------
      ***Thanks for visiting***
```

- Header from settings: restaurant name, location, one or more mobile numbers (one per line under "Mob:"), and an optional logo stored in the printer's memory.
- **Trans#** is the continuous bill number; **Cashier** is the user who closed the bill; **Date** is DD-MM-YYYY HH:mm:ss in Asia/Kolkata; **Table No** is the table, or "None" for takeaway and delivery.
- Takeaway bills add the customer name; delivery bills add name, phone and address.
- Amounts print with two decimals and no currency sign. Long item names wrap under the Item column; portions print in brackets.
- Subtotal, discount (with reason), GST and service charge lines appear only when they change the total.
- Payment mode(s) print under the net total, with tendered and change for cash.
- Footer: the thank-you line and an optional extra line (e.g. social handles), both editable in settings.
- Reprints carry a "REPRINT" line with the time. The agent acknowledges every job; failures retry 3 times and then alert the cashier.

## Non-functional requirements

| Area | Requirement |
| --- | --- |
| Speed | Order send to KOT visible on the station screen in under 2 seconds on normal 4G or WiFi; menu loads in under 1 second after first visit (cached) |
| Reliability | Waiter app queues orders offline and retries with the same `clientRequestId`, so no duplicates and no lost orders; station screens resync all open KOTs on reconnect |
| Kitchen visibility | Station screen online/offline visible to the cashier within 15 seconds; undelivered KOT alert within 10 seconds |
| Print safety | Every bill print job is stored and acknowledged; failures retry and then alert the cashier; jobs survive an agent restart |
| Availability | Target 99% during opening hours; daily MongoDB backup with 7-day retention |
| Security | HTTPS only, hashed PINs and passwords (bcrypt), JWT with short expiry and refresh, role checks on every route, kitchen accounts restricted to their station, rate-limited login, secrets in environment variables only |
| Data integrity | Paid bills and sent KOT content are immutable; corrections create new records; all sensitive actions go to the audit log |
| Mobile UX | One-handed use, tap targets of at least 44 px, works from 360 px width, installable PWA |
| Kitchen UX | Landscape, dark theme, readable at 2 m, 64 px tap targets, screen kept awake (Wake Lock), audible alert on new KOT |
| Privacy | Customer phone numbers and addresses are visible only to cashier roles and above in reports; excluded from CSV exports unless the owner opts in. Station screens show customer name only (plus phone for delivery) |
| Time | All timestamps stored in UTC, displayed and bucketed in Asia/Kolkata |
| Maintainability | One repo with three packages (server, web app, print agent), shared TypeScript types, environment-based config |

## Build order

The backend core and station screens come before the waiter app, because the waiter app can only be tested properly once a KOT appears in the kitchen. Billing follows, then customers, reports and hardening.

## Detailed todo list

Work top to bottom. Each phase ends with an exit check; do not start the next phase until it passes.

### Phase 0. Setup

- [ ] Create one repo with three packages: `server`, `client` (Angular PWA: waiter, station screen, cashier/admin), `print-agent`
- [ ] Set up TypeScript, ESLint, Prettier and a shared types package
- [ ] Provision MongoDB (Atlas free tier for the prototype) and a cloud host for the server
- [ ] Add environment config (`.env.example`), never commit secrets
- [ ] Express app skeleton with health check, error handler, request logging
- [ ] Socket.IO server skeleton with JWT handshake auth
- [ ] Seed script: owner account
- [ ] **Exit:** server runs, connects to MongoDB, seed script creates data

### Phase 1. Auth and staff

- [ ] `User` model with roles including `kitchen` and its `station`, password/PIN hashing
- [ ] `POST /auth/login` (PIN for waiter and kitchen, password for others), JWT access and refresh tokens
- [ ] Role middleware (`requireRole`) and kitchen isolation (`requireAuth` rejects kitchen; `requireKitchen` for KDS routes)
- [ ] Login lockout after repeated failures
- [ ] Staff CRUD endpoints (owner only), reset PIN, deactivate; station-screen accounts with a station picker
- [ ] Angular: login screens (PIN pad for waiter, station-screen login, password form for PC), auth guard, token refresh
- [ ] **Exit:** each role logs in and sees only what its role allows

### Phase 2. Tables and menu designer

- [ ] `Table`, `MenuCategory`, `MenuItem` models and indexes
- [ ] Table endpoints and admin screen to add, rename, move floor, disable
- [ ] Menu endpoints and admin menu designer
- [ ] `menu:updated` and `table:updated` socket events
- [ ] **Exit:** owner builds the real menu and the 16 tables; changes appear live on a second device

### Phase 3. Orders and KOT (backend core)

- [ ] `Order`, `KOT`, `AuditLog` models; unique index for one open order per table
- [ ] `POST /orders` and `POST /orders/:id/items` with `clientRequestId` idempotency
- [ ] Item snapshotting (name, price, station) at add time
- [ ] KOT generator: split items by station, one KOT per station, daily sequence numbers, context snapshot (table, waiter, customer)
- [ ] Edited KOTs for adds and cancels, referencing the original KOT
- [ ] Table status automation (free, occupied, billing) including waiter request-bill
- [ ] Order transfer and merge (cashier)
- [ ] Audit log writes for edits, cancellations and KOT status changes
- [ ] Unit tests for KOT splitting, edit KOTs and idempotency
- [ ] **Exit:** API tests create orders, edits and cancels produce the correct KOTs

### Phase 4. Station screens (KDS)

- [ ] Socket rooms per station; `kot:new`, `kot:received`, `kot:updated`, `kds:status`, `kot:undelivered`
- [ ] KDS endpoints: list own open KOTs, status transitions, recall
- [ ] Station screen page: New / Preparing / Ready lanes, timers with warn/late colours, EDITED and RESENT styling, sound, wake lock, reconnect resync
- [ ] Waiter app: KOT status on the open order, "ready" notification, mark served
- [ ] Cashier panel: station online/offline indicators, undelivered alerts with Resend
- [ ] Settings: KDS warn/late minutes and sound toggle
- [ ] **Exit:** a KOT sent via the API appears on the correct station screen; switching a screen off raises an alert and it catches up on reconnect

### Phase 5. Waiter PWA

- [ ] Mobile-first layout, installable PWA manifest and service worker
- [ ] Floor switcher and live table grid over Socket.IO
- [ ] Order type picker, menu browser, add-item sheet, cart and Send KOT
- [ ] Open order view with Add item and Cancel item (shows the EDITED KOT result)
- [ ] Offline queue in IndexedDB; retry with the same `clientRequestId`; visible "queued" badge
- [ ] Request bill button that sets the table to billing
- [ ] **Exit:** two waiters on two phones order on different tables, KOTs appear on screens, and an order sent in airplane mode arrives once on reconnect

### Phase 6. Cashier panel, billing and bill printing

- [ ] `Bill` model and bill-number sequence
- [ ] Cashier home: live open orders by floor and by type, with KOT status
- [ ] Bill generation, discount, payments (cash/UPI/split), close, void, reprint
- [ ] Print agent for bills: persisted `PrintJob`, `print:result`, 3 retries, drain on reconnect, `agent:status`
- [ ] Settings: bill printer IP and test print; GST and service charge toggles
- [ ] Tests for bill math, rounding and split payments
- [ ] **Exit:** a full dine-in order goes from waiter phone to station screen to paid bill and printed receipt

### Phase 7. Customers, takeaway and delivery

- [ ] `Customer` model with unique phone index; lookup and auto-save
- [ ] Prefill name and address in the waiter and cashier order forms
- [ ] Takeaway and delivery headers on KDS cards and bills
- [ ] **Exit:** a repeat delivery customer is prefilled by phone and shows correctly on screen and bill

### Phase 8. Reports

- [ ] Daily sales, item-wise, cash vs UPI, order-type split, waiter-wise
- [ ] Kitchen performance per station (count, average and longest sent-to-ready)
- [ ] Date range picker, CSV export, printable end-of-day summary, charts
- [ ] **Exit:** report totals match the sum of paid bills for a test day

### Phase 9. Hardening and go-live

- [ ] Audit log viewer, rate limiting, input validation, security headers
- [ ] Daily MongoDB backup and a tested restore; error monitoring
- [ ] Load test: 10 waiters ordering at once with 3 station screens connected
- [ ] Dry run: one full simulated service with real station screens, bill printer and staff phones
- [ ] Staff guides (waiter, cashier, kitchen) and an owner guide
- [ ] Deploy to production, sign in the station screens, point the print agent at it, hand over credentials
- [ ] **Exit:** a live service day with no lost or duplicated KOT

## Risks, open questions and later enhancements

**Risks**

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Station screen loses WiFi or power | Kitchen doesn't see new KOTs | KOTs stored server-side, resync on reconnect, offline banner and undelivered alert at the cashier, waiter sees KOT still "new"; screen on a UPS/charger |
| Screen sleeps or browser tab closed | KOTs not seen | Wake Lock, kiosk mode / installed PWA, auto-login with long-lived refresh |
| Cook mis-taps Ready or Clear | Order looks done when it isn't | Recall for 5 minutes; every status change logged |
| Kitchen noise hides new KOT | Delay | Loud chime plus full-screen flash on new and edited KOTs |
| Print agent PC is off (bills only) | Bill not printed | Server-side job queue, offline banner, reprint, agent starts on boot |
| Weak mobile signal at a waiter | Order delayed | Offline queue with idempotent retry, visible queued badge |
| Waiter sends the same order twice | Duplicate KOT in the kitchen | `clientRequestId` idempotency on create and add-items, and an "already sent" guard in the app |
| Cloud outage during service | System unusable | Backups; later option to run the server on the restaurant PC with cloud sync |
| Staff share one PIN | Weak audit trail | Unique PIN per waiter, enforced at creation |

**Open questions for you to confirm**

- [ ] Are the station screens touch devices (tablets/touch monitors), or plain TVs that need a bump bar / view-only mode?
- [ ] Who marks a KOT "served": the waiter on the phone, the station on Clear, or both (current plan: both)?
- [ ] Should a KOT printer remain as a fallback at any station (current plan: no)?
- [ ] Do item cancellations after a KOT need cashier approval, or only a log entry (current plan: log only)?
- [ ] Do you want a Manager role between cashier and owner (current plan: included)?
- [ ] What are the default warn/late times per station (current plan: 10 and 15 minutes for all)?
- [ ] Should split payment (part cash, part UPI) be supported (current plan: yes)?
- [ ] Should delivery orders need a minimum charge or delivery fee line?

**Later enhancements (not in the prototype)**

- Per-item status on the station screen (tick off items individually)
- Expo/pass screen showing all stations' ready KOTs
- Optional fallback KOT printer per station
- Customer-facing "order ready" screen for takeaway
- GST invoicing and service charge in production use
- Table booking, inventory, loyalty, aggregator integration, multi-restaurant support
