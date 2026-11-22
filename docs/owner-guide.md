# Owner & Administrator Guide — Copakapana Restaurant

## 1. Login & Dashboard Access
- Log in at `/login/pc` using Owner credentials (`owner` / `changeme123`).
- **Automatic First-Run Seeding**: When the backend server boots up, it automatically checks if an Owner account exists in MongoDB. If no Owner exists, it instantly seeds default owner credentials (`SEED_OWNER_NAME` and `SEED_OWNER_PASSWORD` from `.env`, defaulting to `owner` / `changeme123`).
- Owners have full system access, including staff administration, floor & table layout designer, menu management, kitchen station screens, bill printer configuration, audit trails, and voiding paid bills.

---

## 2. Staff Management (`/admin/staff`)
- **Add Staff**: Create new waiters (with numeric 4-6 digit PIN) or cashiers/managers (with username and password).
- **Delivery staff**: Add them with role **Delivery** and a PIN. They sign in from the same phone sign-in page as waiters and only see the delivery app (see the delivery guide).
- **Reset PIN**: Reset forgotten waiter PINs directly without knowing the previous PIN.
- **Deactivate**: Instantly revoke staff login access if an employee leaves.
- **Kitchen station screens**: Add one account per station with role **Kitchen station screen**, pick its station (Fried Chicken, Juice Counter, Main Kitchen) and set a PIN. On the station's tablet/monitor open `/login/kitchen`, tap the station and enter the PIN. The screen stays signed in; re-enter the PIN if it's ever signed out (at least weekly).

---

## 3. Floor & Table Management (`/admin/tables`)
- Switch between **Ground Floor** and **First Floor**.
- Add new tables, edit seat capacities, rename table labels, or temporarily disable tables undergoing maintenance.

---

## 4. Menu & Pricing Designer (`/admin/menu`)
- **Categories**: Create and reorder categories (e.g., Starters, Fried Chicken, Biryani, Juices).
- **Dishes**: Add new items with base price, veg/non-veg flag, portion variants (e.g. Half / Full / Family Pack), and kitchen routing station (`fried_chicken`, `juice`, `main`).
- **Served from the counter**: Turn this on for dishes that need no cooking, such as soft drinks and water bottles. Waiters add them to the bill without sending a ticket to any kitchen screen. They show a **Counter** tag in the menu.
- **Instant Availability Toggle**: Click the ⚡ toggle next to any item to instantly mark it "Out of Stock". The waiter app will immediately prevent ordering that item in real-time.

---

## 5. System Settings, Station Screens & Bill Printer (`/admin/settings`)
- **Restaurant Details**: Set the restaurant name, address, and phone number printed on customer receipts.
- **Taxes & Charges**: Enable/disable GST and configure the percentage rate; enable/disable service charge.
- **Kitchen Station Screens**: Set when a ticket card's timer turns amber (warn) and red (late), and whether a chime plays on new tickets.
- **Bill Printer**: Set the printer address the print agent uses (for example `printer:pos80`). Use **Test Print** to check it.
- **Privacy**: Toggle whether customer phone numbers and delivery addresses are included in CSV exports.

---

## 6. Reports & Business Analytics (`/admin/reports`)
- **Daily Sales**: Total revenue, bill counts, average order size, and daily breakdown.
- **Item Breakdown**: Best-selling dishes by volume and revenue, with station filtering.
- **Payment Split**: Total cash collections vs UPI / digital settlements.
- **Order Channels**: Performance comparison across Dine-In, Takeaway, and Delivery.
- **Staff Performance**: Sales volume attributed per waiter.
- **Kitchen Times**: Per station, the number of tickets and the average and longest time from sent to ready.
- **End of Day (EOD) Summary**: Complete printable settlement sheet. Click **🖨️ Print EOD Summary** to print an official daily audit report.
- **CSV Export**: Click **📥 Export to CSV** on any tab to download spreadsheet files.

---

## 7. Voiding Paid Bills
- If an erroneous bill was settled, open the bill in the Cashier Portal as Owner.
- Click **Void Bill**.
- Enter the mandatory reason (e.g., "Customer returned food / payment mode mismatch").
- The bill is permanently tagged as VOID in audit logs, and the order is reopened to allow correction.
