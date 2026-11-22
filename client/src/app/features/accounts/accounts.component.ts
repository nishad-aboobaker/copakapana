import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/auth/auth.service';
import { IconComponent } from '../../shared/icon.component';
import { UiService } from '../../shared/ui.service';

type Tab = 'vendors' | 'staff' | 'report';
type Mode = 'cash' | 'upi' | 'bank';

interface VendorRow {
  _id: string;
  name: string;
  phone?: string;
  note?: string;
  openingBalance: number;
  active: boolean;
  billed: number;
  paid: number;
  balance: number;
  lastDate: string | null;
}

interface VendorEntryRow {
  _id: string;
  date: string;
  billAmount: number;
  paidAmount: number;
  mode?: Mode;
  note?: string;
  createdBy?: string;
  createdByName?: string;
  createdAt: string;
  balance: number;
}

interface VendorDetail {
  vendor: VendorRow;
  entries: VendorEntryRow[];
  summary: { openingBalance: number; billed: number; paid: number; balance: number };
}

interface StaffRow {
  _id: string;
  name: string;
  phone?: string;
  job?: string;
  openingBalance: number;
  startDate: string;
  endDate?: string;
  active: boolean;
  monthlySalary: number;
  earned: number;
  paid: number;
  balance: number;
  earnedThisMonth: number;
  paidThisMonth: number;
}

interface SalaryPaymentRow {
  _id: string;
  date: string;
  amount: number;
  mode?: Mode;
  note?: string;
  createdBy?: string;
  createdByName?: string;
  createdAt: string;
}

interface StaffDetail {
  staff: StaffRow;
  payments: SalaryPaymentRow[];
  months: { month: string; earned: number; paid: number; balance: number }[];
  summary: { openingBalance: number; earned: number; paid: number; balance: number };
}

interface Report {
  from: string;
  to: string;
  vendors: { id: string; name: string; active: boolean; opening: number; billed: number; paid: number; closing: number }[];
  staff: { id: string; name: string; job?: string; active: boolean; monthlySalary: number; opening: number; earned: number; paid: number; closing: number }[];
  daily: { date: string; vendorBilled: number; vendorPaid: number; salaryPaid: number }[];
  totals: {
    vendors: { opening: number; billed: number; paid: number; closing: number };
    staff: { opening: number; earned: number; paid: number; closing: number };
    paidOut: number;
  };
}

const todayIST = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const LEVEL: Record<string, number> = { cashier: 1, manager: 2, owner: 3 };

/**
 * Accounts — vendor dues and staff salary (cashier and above).
 * Vendors: opening balance + daily bills − payments. Staff: outstanding salary + salary earned
 * day by day − payments. Report: any date range, per person and per day.
 */
@Component({
  selector: 'app-accounts',
  standalone: true,
  imports: [IconComponent, FormsModule],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1 class="page-title">Accounts</h1>
          <p class="page-subtitle">What you owe vendors and staff, what you paid them, and reports.</p>
        </div>
      </header>

      <div class="tabs" role="tablist">
        <button role="tab" [class.active]="tab() === 'vendors'" (click)="setTab('vendors')"><app-icon name="bag" /> Vendors</button>
        <button role="tab" [class.active]="tab() === 'staff'" (click)="setTab('staff')"><app-icon name="users" /> Staff salary</button>
        <button role="tab" [class.active]="tab() === 'report'" (click)="setTab('report')"><app-icon name="chart" /> Report</button>
      </div>

      <!-- ═══════════════ Vendors ═══════════════ -->
      @if (tab() === 'vendors') {
        <div class="layout" [class.has-detail]="vendorId()">
          <section class="list-pane">
            <div class="total-card">
              <span class="stat-label">Total owed to vendors</span>
              <strong class="num">{{ money(vendorsDue()) }}</strong>
            </div>
            <button class="btn btn-primary btn-block" (click)="openVendorForm()"><app-icon name="plus" /> Add vendor</button>
            @if (vendorsLoading() && vendors().length === 0) {
              <div class="skeleton" style="height: 200px; border-radius: 12px"></div>
            } @else if (vendors().length === 0) {
              <div class="card"><div class="empty-state">
                <div class="empty-icon"><app-icon name="bag" /></div>
                <h3>No vendors yet</h3>
                <p>Add the shops and suppliers you buy from, with what you already owe them.</p>
              </div></div>
            } @else {
              <ul class="person-list card" role="list">
                @for (v of vendors(); track v._id) {
                  <li>
                    <button class="person-row" [class.active]="v._id === vendorId()" [class.inactive]="!v.active" (click)="selectVendor(v._id)">
                      <span class="who">
                        <span class="name">{{ v.name }}</span>
                        <span class="sub">{{ v.active ? (v.lastDate ? 'Last entry ' + shortDate(v.lastDate) : 'No entries yet') : 'Inactive' }}</span>
                      </span>
                      <span class="amt" [class.neg]="v.balance < 0">{{ money(v.balance) }}</span>
                      <app-icon name="chevron-right" class="chev" />
                    </button>
                  </li>
                }
              </ul>
            }
          </section>

          <section class="detail-pane">
            @if (!vendorId()) {
              <div class="card placeholder"><div class="empty-state">
                <div class="empty-icon"><app-icon name="receipt" /></div>
                <h3>Select a vendor</h3>
                <p>Add today's bill and what you paid, and see the full statement.</p>
              </div></div>
            } @else if (vendorDetail(); as d) {
              <button class="btn btn-ghost back" (click)="vendorId.set(null)"><app-icon name="arrow-left" /> All vendors</button>
              <div class="card head-card">
                <div>
                  <h2>{{ d.vendor.name }} @if (!d.vendor.active) { <span class="badge">Inactive</span> }</h2>
                  <span class="text-muted text-sm">
                    @if (d.vendor.phone) { <a [href]="'tel:' + d.vendor.phone">{{ d.vendor.phone }}</a> · }
                    Opening balance {{ money(d.summary.openingBalance) }}
                    @if (d.vendor.note) { · {{ d.vendor.note }} }
                  </span>
                </div>
                <button class="btn btn-sm" (click)="openVendorForm(d.vendor)"><app-icon name="pencil" /> Edit</button>
              </div>

              <div class="stats">
                <div class="stat"><span class="stat-label">Total bills</span><span class="stat-value">{{ money(d.summary.billed) }}</span></div>
                <div class="stat"><span class="stat-label">Total paid</span><span class="stat-value">{{ money(d.summary.paid) }}</span></div>
                <div class="stat due"><span class="stat-label">{{ d.summary.balance < 0 ? 'Paid in advance' : 'Balance to pay' }}</span><span class="stat-value">{{ money(abs(d.summary.balance)) }}</span></div>
              </div>

              <form class="card entry-card" (ngSubmit)="saveVendorEntry()">
                <div class="card-header"><h3>Add bill / payment</h3></div>
                <div class="card-body entry-grid">
                  <div class="field"><label for="ve-date">Date</label><input id="ve-date" class="input" type="date" name="date" [max]="today" [(ngModel)]="ve.date" /></div>
                  <div class="field"><label for="ve-bill">Today's bill</label>
                    <div class="input-group"><span class="input-prefix-text">₹</span><input id="ve-bill" class="input" type="number" inputmode="decimal" min="0" name="bill" placeholder="0" [(ngModel)]="ve.bill" /></div>
                  </div>
                  <div class="field"><label for="ve-paid">Paid to them</label>
                    <div class="input-group"><span class="input-prefix-text">₹</span><input id="ve-paid" class="input" type="number" inputmode="decimal" min="0" name="paid" placeholder="0" [(ngModel)]="ve.paid" /></div>
                  </div>
                  @if ((ve.paid || 0) > 0) {
                    <div class="field"><span class="label">Paid by</span>
                      <div class="segmented full">
                        @for (m of modes; track m) { <button type="button" [class.active]="ve.mode === m" (click)="ve.mode = m">{{ modeLabel(m) }}</button> }
                      </div>
                    </div>
                  }
                  <div class="field wide"><label for="ve-note">Note (optional)</label><input id="ve-note" class="input" name="note" maxlength="200" placeholder="e.g. 20 kg chicken" [(ngModel)]="ve.note" /></div>
                </div>
                <div class="card-footer">
                  @if ((ve.bill || 0) > 0 || (ve.paid || 0) > 0) {
                    <span class="preview text-sm">New balance {{ money(d.summary.balance + (ve.bill || 0) - (ve.paid || 0)) }}</span>
                  }
                  <button class="btn btn-primary" type="submit" [disabled]="saving() || (!(ve.bill > 0) && !(ve.paid > 0))">
                    @if (saving()) { <span class="spinner"></span> } @else { <app-icon name="check" /> } Save
                  </button>
                </div>
              </form>

              <div class="card">
                <div class="card-header"><h3>Statement</h3><span class="text-muted text-sm">{{ d.entries.length }} entr{{ d.entries.length === 1 ? 'y' : 'ies' }}</span></div>
                @if (d.entries.length === 0) {
                  <div class="empty-state"><p>No bills or payments yet.</p></div>
                } @else {
                  <div class="table-scroll">
                    <table class="table">
                      <thead><tr><th>Date</th><th class="text-right">Bill</th><th class="text-right">Paid</th><th class="text-right">Balance</th><th>Note</th><th></th></tr></thead>
                      <tbody>
                        @for (e of d.entries; track e._id) {
                          <tr>
                            <td class="nowrap">{{ shortDate(e.date) }}</td>
                            <td class="text-right num">{{ e.billAmount ? money(e.billAmount) : '—' }}</td>
                            <td class="text-right num">{{ e.paidAmount ? money(e.paidAmount) : '—' }}@if (e.paidAmount && e.mode) { <small class="text-muted"> {{ modeLabel(e.mode) }}</small> }</td>
                            <td class="text-right num strong">{{ money(e.balance) }}</td>
                            <td class="note-cell">{{ e.note }}@if (e.createdByName) { <small class="text-muted"> · {{ e.createdByName }}</small> }</td>
                            <td class="text-right">
                              @if (canDelete(e)) {
                                <button class="btn btn-ghost btn-icon btn-sm" (click)="deleteVendorEntry(e)" aria-label="Delete entry"><app-icon name="trash" /></button>
                              }
                            </td>
                          </tr>
                        }
                        <tr class="opening-row"><td>Opening</td><td></td><td></td><td class="text-right num">{{ money(d.summary.openingBalance) }}</td><td colspan="2"></td></tr>
                      </tbody>
                    </table>
                  </div>
                }
              </div>
            } @else {
              <div class="skeleton" style="height: 420px; border-radius: 12px"></div>
            }
          </section>
        </div>
      }

      <!-- ═══════════════ Staff salary ═══════════════ -->
      @if (tab() === 'staff') {
        <div class="layout" [class.has-detail]="staffId()">
          <section class="list-pane">
            <div class="total-card">
              <span class="stat-label">Total salary to pay</span>
              <strong class="num">{{ money(staffDue()) }}</strong>
            </div>
            <button class="btn btn-primary btn-block" (click)="openStaffForm()"><app-icon name="plus" /> Add staff</button>
            @if (staffLoading() && staff().length === 0) {
              <div class="skeleton" style="height: 200px; border-radius: 12px"></div>
            } @else if (staff().length === 0) {
              <div class="card"><div class="empty-state">
                <div class="empty-icon"><app-icon name="users" /></div>
                <h3>No staff yet</h3>
                <p>Add each person with their monthly salary and any salary you still owe them.</p>
              </div></div>
            } @else {
              <ul class="person-list card" role="list">
                @for (s of staff(); track s._id) {
                  <li>
                    <button class="person-row" [class.active]="s._id === staffId()" [class.inactive]="!s.active" (click)="selectStaff(s._id)">
                      <span class="who">
                        <span class="name">{{ s.name }}</span>
                        <span class="sub">{{ s.active ? (s.job ? s.job + ' · ' : '') + money(s.monthlySalary) + '/month' : 'Left ' + shortDate(s.endDate!) }}</span>
                      </span>
                      <span class="amt-col">
                        <span class="amt" [class.neg]="s.balance < 0">{{ money(abs(s.balance)) }}</span>
                        <span class="sub">{{ s.balance < 0 ? 'advance' : 'to pay' }}</span>
                      </span>
                      <app-icon name="chevron-right" class="chev" />
                    </button>
                  </li>
                }
              </ul>
            }
          </section>

          <section class="detail-pane">
            @if (!staffId()) {
              <div class="card placeholder"><div class="empty-state">
                <div class="empty-icon"><app-icon name="cash" /></div>
                <h3>Select a staff member</h3>
                <p>Record today's payment and see what they've earned and been paid each month.</p>
              </div></div>
            } @else if (staffDetail(); as d) {
              <button class="btn btn-ghost back" (click)="staffId.set(null)"><app-icon name="arrow-left" /> All staff</button>
              <div class="card head-card">
                <div>
                  <h2>{{ d.staff.name }} @if (!d.staff.active) { <span class="badge">Left</span> }</h2>
                  <span class="text-muted text-sm">
                    @if (d.staff.job) { {{ d.staff.job }} · }
                    {{ money(d.staff.monthlySalary) }}/month · since {{ shortDate(d.staff.startDate) }}
                    @if (d.staff.phone) { · <a [href]="'tel:' + d.staff.phone">{{ d.staff.phone }}</a> }
                  </span>
                </div>
                <button class="btn btn-sm" (click)="openStaffForm(d.staff)"><app-icon name="pencil" /> Edit</button>
              </div>

              <div class="stats">
                <div class="stat"><span class="stat-label">Earned this month</span><span class="stat-value">{{ money(thisMonth(d).earned) }}</span><span class="stat-meta">so far, day by day</span></div>
                <div class="stat"><span class="stat-label">Paid this month</span><span class="stat-value">{{ money(thisMonth(d).paid) }}</span></div>
                <div class="stat due"><span class="stat-label">{{ d.summary.balance < 0 ? 'Advance paid' : 'Balance to pay' }}</span><span class="stat-value">{{ money(abs(d.summary.balance)) }}</span>
                  <span class="stat-meta">outstanding {{ money(d.summary.openingBalance) }} + earned {{ money(d.summary.earned) }} − paid {{ money(d.summary.paid) }}</span></div>
              </div>

              <form class="card entry-card" (ngSubmit)="savePayment()">
                <div class="card-header"><h3>Pay salary</h3></div>
                <div class="card-body entry-grid">
                  <div class="field"><label for="sp-date">Date</label><input id="sp-date" class="input" type="date" name="date" [max]="today" [(ngModel)]="sp.date" /></div>
                  <div class="field"><label for="sp-amt">Amount paid</label>
                    <div class="input-group"><span class="input-prefix-text">₹</span><input id="sp-amt" class="input" type="number" inputmode="decimal" min="0" name="amount" placeholder="0" [(ngModel)]="sp.amount" /></div>
                    <div class="chips">
                      @for (q of [200, 500, 1000]; track q) { <button type="button" class="chip" (click)="sp.amount = q">₹{{ q }}</button> }
                      @if (d.summary.balance > 0) { <button type="button" class="chip" (click)="sp.amount = d.summary.balance">Full {{ money(d.summary.balance) }}</button> }
                    </div>
                  </div>
                  <div class="field"><span class="label">Paid by</span>
                    <div class="segmented full">
                      @for (m of modes; track m) { <button type="button" [class.active]="sp.mode === m" (click)="sp.mode = m">{{ modeLabel(m) }}</button> }
                    </div>
                  </div>
                  <div class="field wide"><label for="sp-note">Note (optional)</label><input id="sp-note" class="input" name="note" maxlength="200" placeholder="e.g. advance" [(ngModel)]="sp.note" /></div>
                </div>
                <div class="card-footer">
                  @if (sp.amount > 0) { <span class="preview text-sm">Balance after {{ money(d.summary.balance - sp.amount) }}</span> }
                  <button class="btn btn-primary" type="submit" [disabled]="saving() || !(sp.amount > 0)">
                    @if (saving()) { <span class="spinner"></span> } @else { <app-icon name="check" /> } Save payment
                  </button>
                </div>
              </form>

              <div class="two-col">
                <div class="card">
                  <div class="card-header"><h3>Payments</h3><span class="text-muted text-sm">{{ d.payments.length }}</span></div>
                  @if (d.payments.length === 0) {
                    <div class="empty-state"><p>No payments yet.</p></div>
                  } @else {
                    <div class="table-scroll short">
                      <table class="table">
                        <thead><tr><th>Date</th><th class="text-right">Amount</th><th>Note</th><th></th></tr></thead>
                        <tbody>
                          @for (p of d.payments; track p._id) {
                            <tr>
                              <td class="nowrap">{{ shortDate(p.date) }}</td>
                              <td class="text-right num strong">{{ money(p.amount) }}@if (p.mode) { <small class="text-muted"> {{ modeLabel(p.mode) }}</small> }</td>
                              <td class="note-cell">{{ p.note }}@if (p.createdByName) { <small class="text-muted"> · {{ p.createdByName }}</small> }</td>
                              <td class="text-right">
                                @if (canDelete(p)) {
                                  <button class="btn btn-ghost btn-icon btn-sm" (click)="deletePayment(p)" aria-label="Delete payment"><app-icon name="trash" /></button>
                                }
                              </td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </div>
                  }
                </div>
                <div class="card">
                  <div class="card-header"><h3>Month by month</h3></div>
                  <div class="table-scroll short">
                    <table class="table">
                      <thead><tr><th>Month</th><th class="text-right">Earned</th><th class="text-right">Paid</th><th class="text-right">Balance</th></tr></thead>
                      <tbody>
                        @for (m of d.months; track m.month) {
                          <tr>
                            <td class="nowrap">{{ monthLabel(m.month) }}</td>
                            <td class="text-right num">{{ money(m.earned) }}</td>
                            <td class="text-right num">{{ money(m.paid) }}</td>
                            <td class="text-right num strong" [class.neg]="m.balance < 0">{{ money(m.balance) }}</td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            } @else {
              <div class="skeleton" style="height: 420px; border-radius: 12px"></div>
            }
          </section>
        </div>
      }

      <!-- ═══════════════ Report ═══════════════ -->
      @if (tab() === 'report') {
        <div class="report">
          <div class="card range-card no-print">
            <div class="field"><label for="r-from">From</label><input id="r-from" class="input" type="date" [max]="today" [(ngModel)]="rFrom" (change)="loadReport()" /></div>
            <div class="field"><label for="r-to">To</label><input id="r-to" class="input" type="date" [max]="today" [(ngModel)]="rTo" (change)="loadReport()" /></div>
            <div class="presets">
              <button class="btn btn-sm" (click)="preset('today')">Today</button>
              <button class="btn btn-sm" (click)="preset('month')">This month</button>
              <button class="btn btn-sm" (click)="preset('last')">Last month</button>
            </div>
            <div class="actions">
              <button class="btn btn-sm" [disabled]="!report()" (click)="downloadCsv()"><app-icon name="download" /> CSV</button>
              <button class="btn btn-sm" [disabled]="!report()" (click)="print()"><app-icon name="printer" /> Print</button>
            </div>
          </div>

          @if (reportLoading() && !report()) {
            <div class="skeleton" style="height: 320px; border-radius: 12px"></div>
          } @else if (report(); as r) {
            <h2 class="print-title">Accounts · {{ shortDate(r.from) }} – {{ shortDate(r.to) }}</h2>
            <div class="stats four">
              <div class="stat"><span class="stat-label">Vendor bills</span><span class="stat-value">{{ money(r.totals.vendors.billed) }}</span></div>
              <div class="stat"><span class="stat-label">Paid to vendors</span><span class="stat-value">{{ money(r.totals.vendors.paid) }}</span></div>
              <div class="stat"><span class="stat-label">Salary earned</span><span class="stat-value">{{ money(r.totals.staff.earned) }}</span></div>
              <div class="stat"><span class="stat-label">Salary paid</span><span class="stat-value">{{ money(r.totals.staff.paid) }}</span></div>
            </div>
            <div class="alert alert-info"><app-icon name="info" /><div class="alert-body">
              Total paid out: <strong>{{ money(r.totals.paidOut) }}</strong>. Still owed at the end: vendors <strong>{{ money(r.totals.vendors.closing) }}</strong>, salary <strong>{{ money(r.totals.staff.closing) }}</strong>.
            </div></div>

            <div class="card">
              <div class="card-header"><h3>Vendors</h3></div>
              <div class="table-scroll">
                <table class="table">
                  <thead><tr><th>Vendor</th><th class="text-right">Balance at start</th><th class="text-right">Bills</th><th class="text-right">Paid</th><th class="text-right">Balance at end</th></tr></thead>
                  <tbody>
                    @for (v of r.vendors; track v.id) {
                      <tr><td>{{ v.name }}</td><td class="text-right num">{{ money(v.opening) }}</td><td class="text-right num">{{ money(v.billed) }}</td><td class="text-right num">{{ money(v.paid) }}</td><td class="text-right num strong">{{ money(v.closing) }}</td></tr>
                    } @empty { <tr><td colspan="5" class="text-muted">No vendors.</td></tr> }
                  </tbody>
                  <tfoot><tr><td>Total</td><td class="text-right num">{{ money(r.totals.vendors.opening) }}</td><td class="text-right num">{{ money(r.totals.vendors.billed) }}</td><td class="text-right num">{{ money(r.totals.vendors.paid) }}</td><td class="text-right num">{{ money(r.totals.vendors.closing) }}</td></tr></tfoot>
                </table>
              </div>
            </div>

            <div class="card">
              <div class="card-header"><h3>Staff salary</h3></div>
              <div class="table-scroll">
                <table class="table">
                  <thead><tr><th>Staff</th><th class="text-right">Monthly</th><th class="text-right">Balance at start</th><th class="text-right">Earned</th><th class="text-right">Paid</th><th class="text-right">Balance at end</th></tr></thead>
                  <tbody>
                    @for (s of r.staff; track s.id) {
                      <tr><td>{{ s.name }}@if (s.job) { <small class="text-muted"> · {{ s.job }}</small> }</td><td class="text-right num">{{ money(s.monthlySalary) }}</td><td class="text-right num">{{ money(s.opening) }}</td><td class="text-right num">{{ money(s.earned) }}</td><td class="text-right num">{{ money(s.paid) }}</td><td class="text-right num strong">{{ money(s.closing) }}</td></tr>
                    } @empty { <tr><td colspan="6" class="text-muted">No staff.</td></tr> }
                  </tbody>
                  <tfoot><tr><td>Total</td><td></td><td class="text-right num">{{ money(r.totals.staff.opening) }}</td><td class="text-right num">{{ money(r.totals.staff.earned) }}</td><td class="text-right num">{{ money(r.totals.staff.paid) }}</td><td class="text-right num">{{ money(r.totals.staff.closing) }}</td></tr></tfoot>
                </table>
              </div>
            </div>

            <div class="card">
              <div class="card-header"><h3>Day by day</h3></div>
              @if (r.daily.length === 0) {
                <div class="empty-state"><p>Nothing recorded in these dates.</p></div>
              } @else {
                <div class="table-scroll">
                  <table class="table">
                    <thead><tr><th>Date</th><th class="text-right">Vendor bills</th><th class="text-right">Paid to vendors</th><th class="text-right">Salary paid</th><th class="text-right">Total paid out</th></tr></thead>
                    <tbody>
                      @for (day of r.daily; track day.date) {
                        <tr><td class="nowrap">{{ shortDate(day.date) }}</td><td class="text-right num">{{ money(day.vendorBilled) }}</td><td class="text-right num">{{ money(day.vendorPaid) }}</td><td class="text-right num">{{ money(day.salaryPaid) }}</td><td class="text-right num strong">{{ money(day.vendorPaid + day.salaryPaid) }}</td></tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
            </div>
          }
        </div>
      }

      <!-- Vendor form -->
      @if (vendorForm) {
        <div class="modal-backdrop" (click)="vendorForm = null">
          <form class="modal" (click)="$event.stopPropagation()" (ngSubmit)="saveVendor()">
            <div class="modal-header">
              <h3>{{ vendorForm.id ? 'Edit vendor' : 'Add vendor' }}</h3>
              <button type="button" class="btn btn-ghost btn-icon modal-close" (click)="vendorForm = null" aria-label="Close"><app-icon name="x" /></button>
            </div>
            <div class="modal-body">
              <div class="field"><label for="vf-name">Name</label><input id="vf-name" class="input" name="name" maxlength="80" required autofocus placeholder="e.g. Malabar Chicken" [(ngModel)]="vendorForm.name" /></div>
              <div class="field"><label for="vf-phone">Phone (optional)</label><input id="vf-phone" class="input" name="phone" inputmode="tel" maxlength="30" [(ngModel)]="vendorForm.phone" /></div>
              <div class="field"><label for="vf-ob">Opening balance (OB)</label>
                <div class="input-group"><span class="input-prefix-text">₹</span><input id="vf-ob" class="input" type="number" inputmode="decimal" name="ob" [(ngModel)]="vendorForm.openingBalance" /></div>
                <span class="hint">What you already owed them before using this app.</span>
              </div>
              <div class="field"><label for="vf-note">Note (optional)</label><input id="vf-note" class="input" name="note" maxlength="200" placeholder="e.g. chicken, every morning" [(ngModel)]="vendorForm.note" /></div>
              @if (vendorForm.id) {
                <label class="switch"><input type="checkbox" name="active" [(ngModel)]="vendorForm.active" /><span class="track"></span> Active vendor</label>
              }
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" (click)="vendorForm = null">Cancel</button>
              <button type="submit" class="btn btn-primary" [disabled]="saving() || !vendorForm.name.trim()">Save</button>
            </div>
          </form>
        </div>
      }

      <!-- Staff form -->
      @if (staffForm) {
        <div class="modal-backdrop" (click)="staffForm = null">
          <form class="modal" (click)="$event.stopPropagation()" (ngSubmit)="saveStaff()">
            <div class="modal-header">
              <h3>{{ staffForm.id ? 'Edit staff' : 'Add staff' }}</h3>
              <button type="button" class="btn btn-ghost btn-icon modal-close" (click)="staffForm = null" aria-label="Close"><app-icon name="x" /></button>
            </div>
            <div class="modal-body">
              <div class="field"><label for="sf-name">Name</label><input id="sf-name" class="input" name="name" maxlength="80" required autofocus [(ngModel)]="staffForm.name" /></div>
              <div class="row2">
                <div class="field"><label for="sf-job">Job (optional)</label><input id="sf-job" class="input" name="job" maxlength="40" placeholder="e.g. Cook" [(ngModel)]="staffForm.job" /></div>
                <div class="field"><label for="sf-phone">Phone (optional)</label><input id="sf-phone" class="input" name="phone" inputmode="tel" maxlength="30" [(ngModel)]="staffForm.phone" /></div>
              </div>
              <div class="field"><label for="sf-sal">Monthly salary</label>
                <div class="input-group"><span class="input-prefix-text">₹</span><input id="sf-sal" class="input" type="number" inputmode="decimal" min="0" name="salary" required [(ngModel)]="staffForm.monthlySalary" /></div>
                <span class="hint">Earned day by day: {{ money(perDay()) }} a day in a 30-day month.</span>
              </div>
              @if (staffForm.id && staffForm.monthlySalary !== staffForm.originalSalary) {
                <div class="field"><label for="sf-from">New salary applies from</label><input id="sf-from" class="input" type="date" name="from" [(ngModel)]="staffForm.salaryFrom" />
                  <span class="hint">Days before this keep the old salary.</span></div>
              }
              <div class="field"><label for="sf-ob">Outstanding salary</label>
                <div class="input-group"><span class="input-prefix-text">₹</span><input id="sf-ob" class="input" type="number" inputmode="decimal" name="ob" [(ngModel)]="staffForm.openingBalance" /></div>
                <span class="hint">Salary you still owed them before {{ staffForm.id ? 'their start date' : 'today' }}. Use a minus amount for an advance they already took.</span>
              </div>
              @if (!staffForm.id) {
                <div class="field"><label for="sf-start">Salary starts from</label><input id="sf-start" class="input" type="date" name="start" [max]="today" [(ngModel)]="staffForm.startDate" /></div>
              } @else {
                <label class="switch"><input type="checkbox" name="active" [(ngModel)]="staffForm.active" /><span class="track"></span> Still working here</label>
                @if (!staffForm.active && staffForm.wasActive) { <p class="hint text-sm text-muted">Their salary stops after today. They stay in the reports.</p> }
              }
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" (click)="staffForm = null">Cancel</button>
              <button type="submit" class="btn btn-primary" [disabled]="saving() || !staffForm.name.trim() || staffForm.monthlySalary === null || staffForm.monthlySalary < 0">Save</button>
            </div>
          </form>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .tabs { margin-bottom: 1.25rem; }
      .layout { display: grid; grid-template-columns: minmax(280px, 360px) 1fr; gap: 1.25rem; align-items: start; }
      .list-pane { display: flex; flex-direction: column; gap: 0.6rem; position: sticky; top: 1rem; }
      .total-card { display: flex; flex-direction: column; gap: 0.2rem; padding: 0.9rem 1.1rem; border-radius: var(--radius); background: var(--primary-soft); }
      .total-card strong { font-size: var(--fs-2xl); color: var(--primary-active); font-variant-numeric: tabular-nums; }
      .person-list { list-style: none; margin: 0; padding: 0.35rem; max-height: calc(100vh - 19rem); overflow-y: auto; }
      .person-row { width: 100%; display: flex; align-items: center; gap: 0.6rem; padding: 0.7rem 0.6rem; border: 0; background: none; border-radius: var(--radius-sm, 8px); text-align: left; cursor: pointer; color: inherit; }
      .person-row:hover { background: var(--gray-50, #f7f6f4); }
      .person-row.active { background: var(--primary-soft); }
      .person-row.inactive .name { color: var(--text-muted); }
      .who { display: flex; flex-direction: column; min-width: 0; flex: 1; }
      .name { font-weight: 650; color: var(--text-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sub { font-size: var(--fs-xs); color: var(--text-muted); }
      .amt-col { display: flex; flex-direction: column; align-items: flex-end; }
      .amt { font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text-strong); white-space: nowrap; }
      .neg { color: var(--success); }
      .chev { color: var(--text-subtle); display: inline-flex; }

      .detail-pane { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
      .placeholder { min-height: 320px; display: grid; place-items: center; }
      .back { display: none; align-self: flex-start; }
      .head-card { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem 1.25rem; }
      .head-card h2 { font-size: var(--fs-lg); display: flex; align-items: center; gap: 0.5rem; }
      .head-card a { color: var(--primary); text-decoration: none; }
      .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.75rem; }
      .stats.four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .stat .stat-value { font-size: var(--fs-xl); }
      .stat.due { border-color: var(--primary); background: var(--primary-soft); }
      .stat.due .stat-value { color: var(--primary-active); }
      .entry-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 0.9rem; }
      .entry-grid .wide { grid-column: 1 / -1; }
      .segmented.full { display: flex; }
      .segmented.full button { flex: 1; justify-content: center; }
      .card-footer { align-items: center; }
      .preview { margin-right: auto; color: var(--text-muted); font-variant-numeric: tabular-nums; }
      .chips { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.15rem; }
      .chip { border: 1px solid var(--border-strong); background: var(--surface); border-radius: var(--radius-full); padding: 0.2rem 0.6rem; font-size: var(--fs-xs); font-weight: 600; cursor: pointer; color: var(--text); }
      .chip:hover { border-color: var(--primary); color: var(--primary); }
      .table-scroll { overflow-x: auto; }
      .table-scroll.short { max-height: 360px; overflow-y: auto; }
      .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
      .strong { font-weight: 700; color: var(--text-strong); }
      .nowrap { white-space: nowrap; }
      .note-cell { max-width: 260px; color: var(--text-muted); }
      .opening-row td { color: var(--text-muted); font-style: italic; }
      .two-col { display: flex; flex-direction: column-reverse; gap: 1rem; }
      .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }

      .report { display: flex; flex-direction: column; gap: 1rem; }
      .range-card { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.75rem; padding: 1rem 1.25rem; }
      .range-card .field { width: 170px; }
      .presets, .actions { display: flex; gap: 0.4rem; flex-wrap: wrap; padding-bottom: 0.35rem; }
      .actions { margin-left: auto; }
      .print-title { display: none; }

      @media (max-width: 900px) {
        .layout { grid-template-columns: 1fr; }
        .list-pane { position: static; }
        .person-list { max-height: none; }
        .layout.has-detail .list-pane { display: none; }
        .layout:not(.has-detail) .detail-pane { display: none; }
        .back { display: inline-flex; }
        .stats.four { grid-template-columns: 1fr 1fr; }
      }
      @media (max-width: 560px) {
        .stats { grid-template-columns: 1fr 1fr; }
        .stats .stat.due { grid-column: span 2; }
        .range-card .field { width: calc(50% - 0.4rem); }
        .actions { margin-left: 0; }
        .row2 { grid-template-columns: 1fr; }
      }
      @media print {
        .no-print, .tabs, .page-header { display: none !important; }
        .print-title { display: block; font-size: 1.2rem; }
        .table-scroll { overflow: visible; }
      }
    `,
  ],
})
export class AccountsComponent implements OnInit {
  private http = inject(HttpClient);
  private ui = inject(UiService);
  private auth = inject(AuthService);
  private api = `${environment.apiUrl}/accounts`;

  readonly modes: Mode[] = ['cash', 'upi', 'bank'];
  readonly today = todayIST();

  tab = signal<Tab>('vendors');
  saving = signal(false);

  // Vendors
  vendors = signal<VendorRow[]>([]);
  vendorsDue = signal(0);
  vendorsLoading = signal(false);
  vendorId = signal<string | null>(null);
  vendorDetail = signal<VendorDetail | null>(null);
  ve = { date: todayIST(), bill: null as any, paid: null as any, mode: 'cash' as Mode, note: '' };
  vendorForm: { id?: string; name: string; phone: string; openingBalance: number | null; note: string; active: boolean } | null = null;

  // Staff
  staff = signal<StaffRow[]>([]);
  staffDue = signal(0);
  staffLoading = signal(false);
  staffId = signal<string | null>(null);
  staffDetail = signal<StaffDetail | null>(null);
  sp = { date: todayIST(), amount: null as any, mode: 'cash' as Mode, note: '' };
  staffForm: {
    id?: string;
    name: string;
    job: string;
    phone: string;
    monthlySalary: number | null;
    originalSalary?: number;
    salaryFrom: string;
    openingBalance: number | null;
    startDate: string;
    active: boolean;
    wasActive: boolean;
  } | null = null;

  // Report
  report = signal<Report | null>(null);
  reportLoading = signal(false);
  rFrom = `${todayIST().slice(0, 7)}-01`;
  rTo = todayIST();

  private role = computed(() => this.auth.currentUser?.role ?? 'cashier');

  ngOnInit(): void {
    this.loadVendors();
  }

  setTab(t: Tab): void {
    this.tab.set(t);
    if (t === 'vendors') this.loadVendors();
    if (t === 'staff') this.loadStaff();
    if (t === 'report') this.loadReport();
  }

  // ─── Vendors ─────────────────────────────────────────────────────────
  loadVendors(): void {
    this.vendorsLoading.set(true);
    this.http.get<{ vendors: VendorRow[]; totalDue: number }>(`${this.api}/vendors`).subscribe({
      next: (r) => {
        this.vendors.set(r.vendors);
        this.vendorsDue.set(r.totalDue);
        this.vendorsLoading.set(false);
      },
      error: (err) => {
        this.vendorsLoading.set(false);
        this.ui.apiError(err, 'Could not load vendors');
      },
    });
  }

  selectVendor(id: string): void {
    if (this.vendorId() !== id) {
      this.vendorDetail.set(null);
      this.ve = { date: todayIST(), bill: null, paid: null, mode: 'cash', note: '' };
    }
    this.vendorId.set(id);
    this.http.get<VendorDetail>(`${this.api}/vendors/${id}`).subscribe({
      next: (d) => this.vendorDetail.set(d),
      error: (err) => this.ui.apiError(err, 'Could not load this vendor'),
    });
  }

  openVendorForm(v?: VendorRow): void {
    this.vendorForm = v
      ? { id: v._id, name: v.name, phone: v.phone ?? '', openingBalance: v.openingBalance, note: v.note ?? '', active: v.active }
      : { name: '', phone: '', openingBalance: null, note: '', active: true };
  }

  saveVendor(): void {
    const f = this.vendorForm;
    if (!f || !f.name.trim()) return;
    this.saving.set(true);
    const body = { name: f.name, phone: f.phone, note: f.note, openingBalance: f.openingBalance ?? 0, ...(f.id ? { active: f.active } : {}) };
    const req = f.id ? this.http.patch<{ vendor: VendorRow }>(`${this.api}/vendors/${f.id}`, body) : this.http.post<{ vendor: VendorRow }>(`${this.api}/vendors`, body);
    req.subscribe({
      next: (r) => {
        this.saving.set(false);
        this.vendorForm = null;
        this.ui.success(f.id ? 'Vendor updated' : `${r.vendor.name} added`);
        this.loadVendors();
        this.selectVendor(r.vendor._id);
      },
      error: (err) => {
        this.saving.set(false);
        this.ui.apiError(err, 'Could not save the vendor');
      },
    });
  }

  saveVendorEntry(): void {
    const id = this.vendorId();
    if (!id || this.saving()) return;
    const bill = Number(this.ve.bill) || 0;
    const paid = Number(this.ve.paid) || 0;
    if (bill <= 0 && paid <= 0) return;
    this.saving.set(true);
    this.http
      .post(`${this.api}/vendors/${id}/entries`, { date: this.ve.date, billAmount: bill, paidAmount: paid, mode: this.ve.mode, note: this.ve.note })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.ui.success('Saved');
          this.ve = { date: this.ve.date, bill: null, paid: null, mode: this.ve.mode, note: '' };
          this.selectVendor(id);
          this.loadVendors();
        },
        error: (err) => {
          this.saving.set(false);
          this.ui.apiError(err, 'Could not save');
        },
      });
  }

  async deleteVendorEntry(e: VendorEntryRow): Promise<void> {
    const parts = [e.billAmount ? `bill ${this.money(e.billAmount)}` : '', e.paidAmount ? `paid ${this.money(e.paidAmount)}` : ''].filter(Boolean).join(', ');
    const ok = await this.ui.confirm({ title: 'Delete this entry?', message: `${this.shortDate(e.date)}: ${parts}. The balance is recalculated.`, confirmText: 'Delete', danger: true });
    if (!ok) return;
    this.http.delete(`${this.api}/vendor-entries/${e._id}`).subscribe({
      next: () => {
        this.ui.success('Entry deleted');
        if (this.vendorId()) this.selectVendor(this.vendorId()!);
        this.loadVendors();
      },
      error: (err) => this.ui.apiError(err, 'Could not delete'),
    });
  }

  // ─── Staff ───────────────────────────────────────────────────────────
  loadStaff(): void {
    this.staffLoading.set(true);
    this.http.get<{ staff: StaffRow[]; totalDue: number }>(`${this.api}/staff`).subscribe({
      next: (r) => {
        this.staff.set(r.staff);
        this.staffDue.set(r.totalDue);
        this.staffLoading.set(false);
      },
      error: (err) => {
        this.staffLoading.set(false);
        this.ui.apiError(err, 'Could not load staff');
      },
    });
  }

  selectStaff(id: string): void {
    if (this.staffId() !== id) {
      this.staffDetail.set(null);
      this.sp = { date: todayIST(), amount: null, mode: 'cash', note: '' };
    }
    this.staffId.set(id);
    this.http.get<StaffDetail>(`${this.api}/staff/${id}`).subscribe({
      next: (d) => this.staffDetail.set(d),
      error: (err) => this.ui.apiError(err, 'Could not load this staff member'),
    });
  }

  thisMonth(d: StaffDetail): { earned: number; paid: number } {
    const m = d.months.find((x) => x.month === this.today.slice(0, 7));
    return { earned: m?.earned ?? 0, paid: m?.paid ?? 0 };
  }

  perDay(): number {
    return Math.round(((this.staffForm?.monthlySalary || 0) / 30) * 100) / 100;
  }

  openStaffForm(s?: StaffRow): void {
    this.staffForm = s
      ? {
          id: s._id,
          name: s.name,
          job: s.job ?? '',
          phone: s.phone ?? '',
          monthlySalary: s.monthlySalary,
          originalSalary: s.monthlySalary,
          salaryFrom: todayIST(),
          openingBalance: s.openingBalance,
          startDate: s.startDate,
          active: s.active,
          wasActive: s.active,
        }
      : { name: '', job: '', phone: '', monthlySalary: null, salaryFrom: todayIST(), openingBalance: null, startDate: todayIST(), active: true, wasActive: true };
  }

  saveStaff(): void {
    const f = this.staffForm;
    if (!f || !f.name.trim() || f.monthlySalary === null) return;
    this.saving.set(true);
    const body: Record<string, unknown> = { name: f.name, job: f.job, phone: f.phone, monthlySalary: f.monthlySalary, openingBalance: f.openingBalance ?? 0 };
    if (f.id) {
      body['active'] = f.active;
      if (f.monthlySalary !== f.originalSalary) body['salaryFrom'] = f.salaryFrom;
    } else {
      body['startDate'] = f.startDate;
    }
    const req = f.id ? this.http.patch<{ staff: StaffRow }>(`${this.api}/staff/${f.id}`, body) : this.http.post<{ staff: StaffRow }>(`${this.api}/staff`, body);
    req.subscribe({
      next: (r) => {
        this.saving.set(false);
        this.staffForm = null;
        this.ui.success(f.id ? 'Saved' : `${r.staff.name} added`);
        this.loadStaff();
        this.selectStaff(r.staff._id);
      },
      error: (err) => {
        this.saving.set(false);
        this.ui.apiError(err, 'Could not save');
      },
    });
  }

  savePayment(): void {
    const id = this.staffId();
    const amount = Number(this.sp.amount) || 0;
    if (!id || amount <= 0 || this.saving()) return;
    this.saving.set(true);
    this.http.post(`${this.api}/staff/${id}/payments`, { date: this.sp.date, amount, mode: this.sp.mode, note: this.sp.note }).subscribe({
      next: () => {
        this.saving.set(false);
        this.ui.success(`${this.money(amount)} paid`);
        this.sp = { date: this.sp.date, amount: null, mode: this.sp.mode, note: '' };
        this.selectStaff(id);
        this.loadStaff();
      },
      error: (err) => {
        this.saving.set(false);
        this.ui.apiError(err, 'Could not save the payment');
      },
    });
  }

  async deletePayment(p: SalaryPaymentRow): Promise<void> {
    const ok = await this.ui.confirm({ title: 'Delete this payment?', message: `${this.shortDate(p.date)}: ${this.money(p.amount)}. The balance is recalculated.`, confirmText: 'Delete', danger: true });
    if (!ok) return;
    this.http.delete(`${this.api}/salary-payments/${p._id}`).subscribe({
      next: () => {
        this.ui.success('Payment deleted');
        if (this.staffId()) this.selectStaff(this.staffId()!);
        this.loadStaff();
      },
      error: (err) => this.ui.apiError(err, 'Could not delete'),
    });
  }

  /** Managers and owners can delete anything; cashiers only what they entered today. */
  canDelete(e: { createdBy?: string; createdAt: string }): boolean {
    if ((LEVEL[this.role()] ?? 0) >= LEVEL['manager']) return true;
    const madeToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(e.createdAt)) === this.today;
    return !!e.createdBy && e.createdBy === this.auth.currentUser?.id && madeToday;
  }

  // ─── Report ──────────────────────────────────────────────────────────
  loadReport(): void {
    if (!this.rFrom || !this.rTo) return;
    this.reportLoading.set(true);
    this.http.get<Report>(`${this.api}/report`, { params: { from: this.rFrom, to: this.rTo } }).subscribe({
      next: (r) => {
        this.report.set(r);
        this.reportLoading.set(false);
      },
      error: (err) => {
        this.reportLoading.set(false);
        this.ui.apiError(err, 'Could not load the report');
      },
    });
  }

  preset(p: 'today' | 'month' | 'last'): void {
    const t = todayIST();
    if (p === 'today') {
      this.rFrom = t;
      this.rTo = t;
    } else if (p === 'month') {
      this.rFrom = `${t.slice(0, 7)}-01`;
      this.rTo = t;
    } else {
      const [y, m] = t.split('-').map(Number);
      const ly = m === 1 ? y - 1 : y;
      const lm = m === 1 ? 12 : m - 1;
      const days = new Date(Date.UTC(ly, lm, 0)).getUTCDate();
      this.rFrom = `${ly}-${String(lm).padStart(2, '0')}-01`;
      this.rTo = `${ly}-${String(lm).padStart(2, '0')}-${days}`;
    }
    this.loadReport();
  }

  print(): void {
    window.print();
  }

  downloadCsv(): void {
    const r = this.report();
    if (!r) return;
    const esc = (v: unknown) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines: unknown[][] = [
      [`Accounts report ${r.from} to ${r.to}`],
      [],
      ['VENDORS'],
      ['Vendor', 'Balance at start', 'Bills', 'Paid', 'Balance at end'],
      ...r.vendors.map((v) => [v.name, v.opening, v.billed, v.paid, v.closing]),
      ['Total', r.totals.vendors.opening, r.totals.vendors.billed, r.totals.vendors.paid, r.totals.vendors.closing],
      [],
      ['STAFF SALARY'],
      ['Staff', 'Job', 'Monthly salary', 'Balance at start', 'Earned', 'Paid', 'Balance at end'],
      ...r.staff.map((s) => [s.name, s.job ?? '', s.monthlySalary, s.opening, s.earned, s.paid, s.closing]),
      ['Total', '', '', r.totals.staff.opening, r.totals.staff.earned, r.totals.staff.paid, r.totals.staff.closing],
      [],
      ['DAY BY DAY'],
      ['Date', 'Vendor bills', 'Paid to vendors', 'Salary paid', 'Total paid out'],
      ...r.daily.map((d) => [d.date, d.vendorBilled, d.vendorPaid, d.salaryPaid, d.vendorPaid + d.salaryPaid]),
    ];
    const csv = lines.map((l) => l.map(esc).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `accounts-${r.from}-to-${r.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Formatting ──────────────────────────────────────────────────────
  money(n: number | null | undefined): string {
    const v = Number(n) || 0;
    const sign = v < 0 ? '−' : '';
    return `${sign}₹${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  }

  abs(n: number): number {
    return Math.abs(n);
  }

  modeLabel(m: Mode): string {
    return m === 'upi' ? 'UPI' : m === 'bank' ? 'Bank' : 'Cash';
  }

  shortDate(ymd: string): string {
    if (!ymd) return '';
    const d = new Date(`${ymd}T00:00:00Z`);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: ymd.slice(0, 4) === this.today.slice(0, 4) ? undefined : 'numeric', timeZone: 'UTC' });
  }

  monthLabel(ym: string): string {
    return new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
}
