import { ChangeDetectionStrategy, Component, HostListener, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../../environments/environment';
import { SocketService } from '../../core/socket/socket.service';
import { AuthService } from '../../core/auth/auth.service';
import { IconComponent } from '../../shared/icon.component';
import { UiService } from '../../shared/ui.service';

interface SettingsForm {
  restaurantName: string;
  address: string;
  phone: string;
  billFooter: string;
  billFooterNote: string;
  printLogo: boolean;
  gstEnabled: boolean;
  gstRate: number;
  serviceChargeEnabled: boolean;
  serviceChargePercent: number;
  billPrinterIp: string;
  includeCustomerPiiInExports: boolean;
  kdsWarnMinutes: number;
  kdsLateMinutes: number;
  kdsSoundEnabled: boolean;
}

const FIELDS: (keyof SettingsForm)[] = [
  'restaurantName',
  'address',
  'phone',
  'billFooter',
  'billFooterNote',
  'printLogo',
  'gstEnabled',
  'gstRate',
  'serviceChargeEnabled',
  'serviceChargePercent',
  'billPrinterIp',
  'includeCustomerPiiInExports',
  'kdsWarnMinutes',
  'kdsLateMinutes',
  'kdsSoundEnabled',
];

@Component({
  selector: 'app-settings-admin',
  // Angular 22 defaults to OnPush; this page keeps plain-field state updated by HTTP/socket callbacks
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: true,
  imports: [FormsModule, IconComponent],
  template: `
    <div class="page narrow">
      <header class="page-header">
        <div>
          <h1 class="page-title">Settings</h1>
          <p class="page-subtitle">Restaurant details, taxes, kitchen screens and the bill printer.</p>
        </div>
      </header>

      @if (!form) {
        <div class="stack">
          @for (i of [1, 2, 3]; track i) { <div class="skeleton" style="height: 160px; border-radius: 12px"></div> }
        </div>
      } @else {
        <form class="stack sections" (ngSubmit)="save()" (input)="touch()" (change)="touch()">
          <!-- Restaurant -->
          <section class="card">
            <div class="card-header">
              <div><h3>Bill details</h3><p>Printed on every customer bill. The preview matches the printed layout.</p></div>
            </div>
            <div class="card-body split">
              <div class="stack">
                <div class="field">
                  <label for="s-name">Restaurant name</label>
                  <input id="s-name" name="restaurantName" class="input" [(ngModel)]="form.restaurantName" />
                </div>
                <div class="field">
                  <label for="s-addr">Location / address</label>
                  <textarea id="s-addr" name="address" class="textarea" rows="2" [(ngModel)]="form.address" placeholder="e.g. Chamravattam"></textarea>
                </div>
                <div class="field">
                  <label for="s-phone">Mobile numbers</label>
                  <textarea id="s-phone" name="phone" class="textarea" rows="3" [(ngModel)]="form.phone" placeholder="One per line"></textarea>
                  <span class="hint">One per line (or separated by commas). Each prints on its own line under "Mob:".</span>
                </div>
                <div class="field">
                  <label for="s-footer">Thank-you line</label>
                  <input id="s-footer" name="billFooter" class="input" [(ngModel)]="form.billFooter" placeholder="***Thanks for visiting***" />
                </div>
                <div class="field">
                  <label for="s-note">Extra footer line <span class="text-muted">(optional)</span></label>
                  <input id="s-note" name="billFooterNote" class="input" [(ngModel)]="form.billFooterNote" placeholder="e.g. Follow us on Instagram @copakapana" />
                </div>
                <label class="switch">
                  <input type="checkbox" name="printLogo" [(ngModel)]="form.printLogo" />
                  <span class="track"></span>
                  <span><strong>Print logo</strong><small>Prints the logo saved in the printer's memory (load it once with the printer's logo tool)</small></span>
                </label>
              </div>
              <div class="receipt" aria-label="Bill preview">
                <span class="receipt-tag">Preview</span>
                @if (form.printLogo) { <span class="r-logo">LOGO</span> }
                <strong class="r-name">{{ form.restaurantName || 'Restaurant name' }}</strong>
                @if (form.address) { <span class="r-center">{{ form.address }}</span> }
                @if (phones().length) {
                  <div class="r-phones">
                    @for (p of phones(); track $index; let first = $first) {
                      <span><span class="r-mob">{{ first ? 'Mob:' : '' }}</span>{{ p }}</span>
                    }
                  </div>
                }
                <hr />
                <div class="r-kv"><span>Trans#</span><span>22814</span></div>
                <div class="r-kv"><span>Cashier</span><span>{{ cashierPreview }}</span></div>
                <div class="r-kv"><span>Date</span><span>{{ datePreview }}</span></div>
                <div class="r-kv"><span>Table No</span><span>T5</span></div>
                <hr />
                <div class="r-items head"><span>Item</span><span>Qty</span><span>Rate</span><span>Total</span></div>
                <div class="r-items"><span>PARATHA</span><span>3</span><span>15.00</span><span>45.00</span></div>
                <div class="r-items"><span>PEPSI 20</span><span>1</span><span>20.00</span><span>20.00</span></div>
                <hr />
                @if (form.gstEnabled || form.serviceChargeEnabled) {
                  <div class="r-row"><span>Subtotal</span><span>65.00</span></div>
                  @if (form.gstEnabled) { <div class="r-row"><span>GST</span><span>{{ round(65 * form.gstRate / 100).toFixed(2) }}</span></div> }
                  @if (form.serviceChargeEnabled) { <div class="r-row"><span>Service Charge</span><span>{{ round(65 * form.serviceChargePercent / 100).toFixed(2) }}</span></div> }
                }
                <div class="r-row total"><span>Net Total :</span><span>{{ previewTotal() }}</span></div>
                <hr />
                @if (form.billFooter) { <span class="r-center">{{ form.billFooter }}</span> }
                @if (form.billFooterNote) { <span class="r-center">{{ form.billFooterNote }}</span> }
              </div>
            </div>
          </section>

          <!-- Taxes -->
          <section class="card">
            <div class="card-header"><div><h3>Taxes &amp; charges</h3><p>Off by default. Applied to new bills only.</p></div></div>
            <div class="card-body stack">
              <div class="setting">
                <label class="switch">
                  <input type="checkbox" name="gstEnabled" [(ngModel)]="form.gstEnabled" />
                  <span class="track"></span>
                  <span><strong>GST</strong><small>Adds a GST line to bills</small></span>
                </label>
                <div class="input-group pct" [class.disabled]="!form.gstEnabled">
                  <input name="gstRate" class="input num" type="number" min="0" max="28" step="0.5" [(ngModel)]="form.gstRate" [disabled]="!form.gstEnabled" aria-label="GST rate" />
                  <span class="suffix">%</span>
                </div>
              </div>
              <div class="setting">
                <label class="switch">
                  <input type="checkbox" name="serviceChargeEnabled" [(ngModel)]="form.serviceChargeEnabled" />
                  <span class="track"></span>
                  <span><strong>Service charge</strong><small>Adds a service charge line to bills</small></span>
                </label>
                <div class="input-group pct">
                  <input name="serviceChargePercent" class="input num" type="number" min="0" max="20" step="0.5" [(ngModel)]="form.serviceChargePercent" [disabled]="!form.serviceChargeEnabled" aria-label="Service charge percent" />
                  <span class="suffix">%</span>
                </div>
              </div>
            </div>
          </section>

          <!-- Kitchen screens -->
          <section class="card">
            <div class="card-header"><div><h3>Kitchen screens</h3><p>Ticket timers and alerts on the station screens. Changes apply instantly.</p></div></div>
            <div class="card-body stack">
              <div class="grid-2">
                <div class="field">
                  <label for="s-warn"><span class="dot amber"></span> Turn amber after</label>
                  <div class="input-group"><input id="s-warn" name="kdsWarnMinutes" class="input num" type="number" min="1" [(ngModel)]="form.kdsWarnMinutes" /><span class="suffix">min</span></div>
                </div>
                <div class="field">
                  <label for="s-late"><span class="dot red"></span> Turn red (late) after</label>
                  <div class="input-group"><input id="s-late" name="kdsLateMinutes" class="input num" type="number" min="1" [(ngModel)]="form.kdsLateMinutes" /><span class="suffix">min</span></div>
                  @if (form.kdsLateMinutes < form.kdsWarnMinutes) { <span class="error-text">Must be at least the amber time</span> }
                </div>
              </div>
              <label class="switch">
                <input type="checkbox" name="kdsSoundEnabled" [(ngModel)]="form.kdsSoundEnabled" />
                <span class="track"></span>
                <span><strong>Chime on new tickets</strong><small>Each screen can still mute itself</small></span>
              </label>
            </div>
          </section>

          <!-- Bill printer -->
          <section class="card">
            <div class="card-header">
              <div><h3>Bill printer</h3><p>The counter receipt printer, driven by the print agent on the restaurant PC.</p></div>
              <span class="badge" [class.badge-success]="agentOnline()" [class.badge-danger]="!agentOnline()">
                <app-icon name="printer" /> Agent {{ agentOnline() ? 'online' : 'offline' }}
              </span>
            </div>
            <div class="card-body">
              <div class="field">
                <label for="s-ip">Printer address</label>
                <div class="row">
                  <input id="s-ip" name="billPrinterIp" class="input mono ip" [(ngModel)]="form.billPrinterIp" placeholder="printer:POS-80C" [class.is-invalid]="!ipValid()" />
                  <button type="button" class="btn" (click)="testPrinter()" [disabled]="dirty() || testing()">
                    @if (testing()) { <span class="spinner"></span> } @else { <app-icon name="printer" /> } Test print
                  </button>
                </div>
                <span class="hint">{{ dirty() ? 'Save first to test the new address.' : printerHint() }}</span>
                @if (!ipValid()) {
                  <span class="error-text">Use printer:&lt;name&gt; (printer on the agent's PC), an IP like 192.168.1.100, or \\PC-NAME\Share</span>
                }
              </div>
            </div>
          </section>

          <!-- Privacy -->
          <section class="card">
            <div class="card-header"><div><h3>Privacy</h3></div></div>
            <div class="card-body">
              <label class="switch">
                <input type="checkbox" name="includeCustomerPiiInExports" [(ngModel)]="form.includeCustomerPiiInExports" />
                <span class="track"></span>
                <span><strong>Include customer phone numbers and addresses in CSV exports</strong><small>Off keeps customer details out of downloaded files</small></span>
              </label>
            </div>
          </section>

          <!-- Save bar -->
          <div class="save-bar" [class.show]="dirty()">
            <span><app-icon name="info" [size]="16" /> You have unsaved changes</span>
            <span class="spacer"></span>
            <button type="button" class="btn" (click)="reset()">Discard</button>
            <button type="submit" class="btn btn-primary" [disabled]="saving() || !valid()">
              @if (saving()) { <span class="spinner"></span> } Save changes
            </button>
          </div>
        </form>
      }
    </div>
  `,
  styles: [
    `
      .narrow { max-width: 920px; }
      .sections { gap: 1rem; padding-bottom: 5rem; }
      .split { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 1.5rem; align-items: start; }
      .receipt {
        position: relative; font-family: var(--font-mono); font-size: 0.75rem; background: #fffdf8; border: 1px solid var(--border);
        border-radius: 6px; padding: 1.25rem 1rem; display: flex; flex-direction: column; align-items: center; gap: 0.15rem; color: var(--gray-700);
        box-shadow: var(--shadow-sm); text-align: center;
      }
      .receipt strong { font-size: 0.9rem; color: var(--text-strong); }
      .receipt hr { width: 100%; border: 0; border-top: 1px dashed var(--gray-300); margin: 0.5rem 0; }
      .receipt-tag { position: absolute; top: -9px; left: 10px; font-family: var(--font); font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; background: var(--surface); padding: 0 0.35rem; color: var(--text-muted); }
      .r-row { width: 100%; display: flex; justify-content: space-between; }
      .r-row.total { font-weight: 800; font-size: 0.9rem; color: var(--text-strong); padding: 0.15rem 0; }
      .r-name { font-size: 0.95rem; }
      .r-center { text-align: center; }
      .r-logo { border: 1px dashed var(--gray-300); border-radius: 4px; padding: 0.2rem 0.6rem; font-size: 0.65rem; color: var(--text-muted); margin-bottom: 0.25rem; }
      .r-phones { display: flex; flex-direction: column; align-items: flex-start; }
      .r-mob { display: inline-block; width: 2.6em; }
      .r-kv { width: 100%; display: grid; grid-template-columns: 6.5em 1fr; text-align: left; }
      .r-kv span:first-child::after { content: ' :'; }
      .r-items { width: 100%; display: grid; grid-template-columns: 1fr 2.2em 4em 4.4em; text-align: right; }
      .r-items span:first-child { text-align: left; }
      .r-items.head { font-weight: 700; }
      .setting { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
      .switch span:last-child { display: flex; flex-direction: column; line-height: 1.3; }
      .switch small { font-weight: 400; color: var(--text-muted); font-size: var(--fs-xs); }
      .switch strong { color: var(--text-strong); }
      .pct { width: 110px; }
      .suffix { position: absolute; right: 0.85rem; color: var(--text-muted); font-size: var(--fs-sm); pointer-events: none; }
      .input-group .input { padding-right: 2.6rem; }
      .ip { max-width: 240px; }
      .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; margin-right: 0.3rem; }
      .dot.amber { background: #f59e0b; }
      .dot.red { background: var(--danger); }
      .save-bar {
        position: fixed; left: 50%; bottom: 1rem; z-index: 600; transform: translate(-50%, 150%); width: min(760px, calc(100% - 2rem));
        display: flex; align-items: center; gap: 0.6rem; padding: 0.7rem 0.8rem 0.7rem 1.1rem; border-radius: var(--radius); background: var(--gray-900); color: #fff;
        box-shadow: var(--shadow-lg); transition: transform 0.25s var(--ease);
      }
      .save-bar.show { transform: translate(-50%, 0); }
      .save-bar > span:first-child { display: inline-flex; align-items: center; gap: 0.4rem; font-size: var(--fs-sm); }
      .save-bar .btn:not(.btn-primary) { background: transparent; color: #fff; border-color: rgba(255, 255, 255, 0.25); }
      @media (min-width: 1024px) { .save-bar { left: calc(50% + var(--sidebar-w) / 2); } }
      @media (max-width: 760px) { .split { grid-template-columns: 1fr; } .setting { flex-direction: column; align-items: flex-start; } }
    `,
  ],
})
export class SettingsAdminComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private socket = inject(SocketService);
  private ui = inject(UiService);
  private auth = inject(AuthService);
  private sub?: Subscription;

  form: SettingsForm | null = null;
  private original: SettingsForm | null = null;
  readonly dirty = signal(false);
  readonly saving = signal(false);
  readonly testing = signal(false);
  readonly agentOnline = signal(false);
  readonly tick = signal(0);

  readonly ipValid = computed(() => {
    this.tick();
    const ip = this.form?.billPrinterIp?.trim() ?? '';
    // printer:<name> (installed on the agent's PC) · a network printer's IP · \\PC-NAME\ShareName
    return !ip || /^printer:.+/i.test(ip) || /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || this.isShare(ip);
  });

  printerHint(): string {
    const v = (this.form?.billPrinterIp ?? '').trim();
    if (/^printer:/i.test(v)) return 'Printer installed on the PC running the print agent (e.g. USB). Use the exact name from "npm run list-printers" on that PC.';
    if (this.isShare(v)) return 'Printer shared from another Windows PC. The print agent must be able to open this share.';
    return 'Recommended: printer:<name> for a USB printer on the agent\'s PC. A network printer uses its IP address (port 9100).';
  }

  isShare(v: string | undefined): boolean {
    return /^(\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test((v ?? '').trim());
  }

  readonly valid = computed(() => {
    this.tick();
    return !!this.form && this.ipValid() && this.form.kdsLateMinutes >= this.form.kdsWarnMinutes && this.form.kdsWarnMinutes >= 1;
  });

  ngOnInit(): void {
    this.fetchSettings();
    this.sub = this.socket.fromEvent<any>('agent:status').subscribe((a) => this.agentOnline.set(!!a?.online));
    this.http.get<any>(`${environment.apiUrl}/health`.replace('/api/v1', '')).subscribe({
      next: (h) => this.agentOnline.set(!!h?.agentOnline),
      error: () => {},
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  /** Warn before leaving the tab with unsaved changes. */
  @HostListener('window:beforeunload', ['$event'])
  beforeUnload(e: BeforeUnloadEvent): void {
    if (this.dirty()) e.preventDefault();
  }

  round(n: number): number {
    return Math.round(n || 0);
  }

  readonly cashierPreview = (this.auth.currentUser?.name ?? 'cashier').toUpperCase();
  readonly datePreview = (() => {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date());
    const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
    return `${g('day')}-${g('month')}-${g('year')} ${g('hour')}:${g('minute')}:${g('second')}`;
  })();

  /** Same splitting rule as the server: commas, semicolons or new lines. */
  readonly phones = computed(() => {
    this.tick();
    return (this.form?.phone ?? '').split(/[,\n;/]+/).map((x) => x.trim()).filter(Boolean);
  });

  readonly previewTotal = computed(() => {
    this.tick();
    const f = this.form;
    if (!f) return '65.00';
    const extra = (f.gstEnabled ? Math.round((65 * f.gstRate) / 100) : 0) + (f.serviceChargeEnabled ? Math.round((65 * f.serviceChargePercent) / 100) : 0);
    return (65 + extra).toFixed(2);
  });

  touch(): void {
    queueMicrotask(() => {
      this.dirty.set(JSON.stringify(this.form) !== JSON.stringify(this.original));
      this.tick.update((t) => t + 1);
    });
  }

  fetchSettings(): void {
    this.http.get<{ settings: any }>(`${environment.apiUrl}/settings`).subscribe({
      next: (res) => this.apply(res.settings),
      error: (err) => this.ui.apiError(err, 'Could not load settings'),
    });
  }

  private apply(s: any): void {
    const picked = {} as SettingsForm;
    for (const k of FIELDS) (picked as any)[k] = s?.[k];
    this.form = { ...picked };
    this.original = { ...picked };
    this.dirty.set(false);
    this.tick.update((t) => t + 1);
  }

  reset(): void {
    if (this.original) this.form = { ...this.original };
    this.dirty.set(false);
    this.tick.update((t) => t + 1);
  }

  save(): void {
    if (!this.form || !this.valid()) return;
    this.saving.set(true);
    this.http.patch<{ settings: any }>(`${environment.apiUrl}/settings`, this.form).subscribe({
      next: (res) => {
        this.saving.set(false);
        this.apply(res.settings);
        this.ui.success('Settings saved');
      },
      error: (err) => {
        this.saving.set(false);
        this.ui.apiError(err, 'Could not save settings');
      },
    });
  }

  testPrinter(): void {
    this.testing.set(true);
    this.http.post(`${environment.apiUrl}/settings/printers/bill/test`, {}).subscribe({
      next: () => {
        this.testing.set(false);
        this.ui.info(this.agentOnline() ? 'A test page should print in a few seconds.' : 'Queued — it prints when the print agent comes online.', 'Test print sent');
      },
      error: (err) => {
        this.testing.set(false);
        this.ui.apiError(err, 'Test print failed');
      },
    });
  }
}
