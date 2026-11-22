/**
 * ESC/POS formatting for the cashier counter printer.
 */
export class EscposFormatter {
  private static readonly LINE_WIDTH = 42;

  // ESC/POS Command Byte Sequences
  private static readonly ESC = '\x1B';
  private static readonly GS = '\x1D';

  public static readonly INIT = `${this.ESC}@`;
  public static readonly BOLD_ON = `${this.ESC}E\x01`;
  public static readonly BOLD_OFF = `${this.ESC}E\x00`;
  public static readonly DOUBLE_ON = `${this.GS}!\x11`; // Double height + width
  public static readonly DOUBLE_OFF = `${this.GS}!\x00`;
  public static readonly ALIGN_LEFT = `${this.ESC}a\x00`;
  public static readonly ALIGN_CENTER = `${this.ESC}a\x01`;
  public static readonly ALIGN_RIGHT = `${this.ESC}a\x02`;
  public static readonly CUT_FEED = `${this.GS}V\x41\x03`; // Feed 3 lines & cut
  public static readonly BEEP = `${this.ESC}B\x02\x02`; // 2 beeps

  public static divider(char = '-'): string {
    return char.repeat(this.LINE_WIDTH) + '\n';
  }

  public static leftRight(left: string, right: string): string {
    const spaceCount = Math.max(1, this.LINE_WIDTH - left.length - right.length);
    return left + ' '.repeat(spaceCount) + right + '\n';
  }

  /** Text-size modes (GS !) */
  public static readonly DOUBLE_HEIGHT = `${this.GS}!\x01`;
  /** Print the logo stored in the printer's NV memory (image #1, normal size). */
  public static readonly NV_LOGO = `${this.ESC}a\x01\x1Cp\x01\x00`;

  /** Amount as on the restaurant's receipt: no currency sign, 2 decimals. */
  private static amount(n: number | undefined): string {
    return Number(n || 0).toFixed(2);
  }

  /** DD-MM-YYYY HH:mm:ss in Asia/Kolkata */
  public static istStamp(iso?: string): string {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(iso ? new Date(iso) : new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('day')}-${get('month')}-${get('year')} ${get('hour')}:${get('minute')}:${get('second')}`;
  }

  /** "Label    : value" with a fixed label column, wrapping long values. */
  private static field(label: string, value: string): string {
    const head = label.padEnd(12) + ': ';
    const room = this.LINE_WIDTH - head.length;
    const chunks = this.wrap(value || '', room);
    return chunks.map((c, i) => (i === 0 ? head : ' '.repeat(head.length)) + c).join('\n') + '\n';
  }

  private static wrap(text: string, width: number): string[] {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      if (!cur) cur = w;
      else if ((cur + ' ' + w).length <= width) cur += ' ' + w;
      else {
        lines.push(cur);
        cur = w;
      }
      while (cur.length > width) {
        lines.push(cur.slice(0, width));
        cur = cur.slice(width);
      }
    }
    if (cur || !lines.length) lines.push(cur);
    return lines;
  }

  // Item table columns: Item | Qty | Rate | Total  (20 + 4 + 9 + 9 = 42)
  private static readonly COL_ITEM = 20;
  private static readonly COL_QTY = 4;
  private static readonly COL_RATE = 9;
  private static readonly COL_TOTAL = 9;

  private static itemRow(name: string, qty: string, rate: string, total: string): string {
    const nameLines = this.wrap(name, this.COL_ITEM - 1);
    const nums = qty.padStart(this.COL_QTY) + rate.padStart(this.COL_RATE) + total.padStart(this.COL_TOTAL);
    return nameLines.map((n, i) => (i === 0 ? n.padEnd(this.COL_ITEM) + nums : n)).join('\n') + '\n';
  }

  /**
   * Customer bill, laid out like the restaurant's existing receipt:
   *   [logo] · name · location · Mob: numbers
   *   Trans# · Cashier · Date · Table No
   *   Item / Qty / Rate / Total
   *   Net Total · footer
   */
  public static formatBill(bill: any): Buffer {
    let out = this.INIT;

    // ── Header ────────────────────────────────────────────────
    if (bill.printLogo) out += this.NV_LOGO + '\n';
    out += this.ALIGN_CENTER;
    out += this.BOLD_ON + this.DOUBLE_HEIGHT;
    out += `${bill.restaurantName || 'CopaKapana Restaurant'}\n`;
    out += this.DOUBLE_OFF + this.BOLD_OFF;
    if (bill.address) out += this.wrap(bill.address, this.LINE_WIDTH).join('\n') + '\n';
    out += this.ALIGN_LEFT;

    const phones: string[] = bill.phones?.length ? bill.phones : bill.phone ? [bill.phone] : [];
    if (phones.length) {
      // "Mob: 9072211810" with further numbers aligned under the first, block centred
      const block = phones.map((p, i) => (i === 0 ? 'Mob: ' : '     ') + p);
      const width = Math.max(...block.map((l) => l.length));
      const pad = ' '.repeat(Math.max(0, Math.floor((this.LINE_WIDTH - width) / 2)));
      out += block.map((l) => pad + l).join('\n') + '\n';
    }

    if (bill.isReprint) {
      out += this.ALIGN_CENTER + this.BOLD_ON + `*** REPRINT ${this.istStamp()} ***\n` + this.BOLD_OFF + this.ALIGN_LEFT;
    }
    out += this.divider('-');

    // ── Bill details ──────────────────────────────────────────
    out += this.field('Trans#', String(bill.number ?? ''));
    out += this.field('Cashier', String(bill.cashierName || 'CASHIER').toUpperCase());
    out += this.field('Date', this.istStamp(bill.date));
    out += this.field('Table No', bill.orderType === 'dine_in' && bill.tableName ? String(bill.tableName) : 'None');

    const customer = bill.customer || {};
    if (bill.orderType === 'takeaway') {
      out += this.field('Order', `TAKEAWAY${customer.name ? ' - ' + customer.name : ''}`);
    } else if (bill.orderType === 'delivery') {
      out += this.field('Order', 'DELIVERY');
      if (customer.name) out += this.field('Customer', customer.name);
      if (customer.phone) out += this.field('Phone', customer.phone);
      if (customer.address) out += this.field('Address', customer.address);
    }
    out += this.divider('-');

    // ── Items ─────────────────────────────────────────────────
    out += this.BOLD_ON + this.itemRow('Item', 'Qty', 'Rate', 'Total') + this.BOLD_OFF;
    out += this.divider('-');
    for (const item of bill.itemsSnapshot || []) {
      const name = `${item.name}${item.portion ? ' (' + item.portion + ')' : ''}`.toUpperCase();
      out += this.itemRow(name, String(item.qty), this.amount(item.price), this.amount(item.price * item.qty));
    }
    out += this.divider('-');

    // Only show the breakdown when something changes the total
    const hasAdjustments = !!bill.discountAmount || !!bill.gst || !!bill.serviceCharge;
    if (hasAdjustments) {
      out += this.leftRight('Subtotal', this.amount(bill.subtotal));
      if (bill.discountAmount) {
        out += this.leftRight(`Discount${bill.discount?.reason ? ' (' + bill.discount.reason + ')' : ''}`.slice(0, 30), '-' + this.amount(bill.discountAmount));
      }
      if (bill.gst) out += this.leftRight('GST', this.amount(bill.gst));
      if (bill.serviceCharge) out += this.leftRight('Service Charge', this.amount(bill.serviceCharge));
      out += '\n';
    }

    // ── Net total ─────────────────────────────────────────────
    out += this.BOLD_ON + this.DOUBLE_HEIGHT;
    out += this.leftRight('Net Total    :', this.amount(bill.total));
    out += this.DOUBLE_OFF + this.BOLD_OFF;

    const payments: any[] = bill.payments || [];
    if (payments.length) {
      const modes = payments.map((p) => `${String(p.mode).toUpperCase()} ${this.amount(p.amount)}`).join(' + ');
      out += this.field('Paid by', modes);
      const cash = payments.find((p) => p.mode === 'cash' && p.change);
      if (cash) out += this.field('Tendered', this.amount(cash.tendered)) + this.field('Change', this.amount(cash.change));
    }
    out += this.divider('-');

    // ── Footer ────────────────────────────────────────────────
    out += this.ALIGN_CENTER;
    if (bill.footer !== '') out += `${bill.footer || '***Thanks for visiting***'}\n`;
    if (bill.footerNote) out += this.wrap(bill.footerNote, this.LINE_WIDTH).join('\n') + '\n';
    out += this.CUT_FEED;

    return Buffer.from(out, 'utf8');
  }

  public static formatTestPrint(payload: any): Buffer {
    let out = this.INIT;

    out += this.ALIGN_CENTER;
    out += this.BOLD_ON;
    out += `TEST PRINT SUCCESSFUL\n`;
    out += this.BOLD_OFF;
    out += `Printer: BILL (cashier counter)\n`;
    out += `Target IP: ${payload.targetIp}\n`;
    out += `Timestamp: ${payload.timestamp}\n`;
    out += this.divider('-');
    out += `Copakapana Billing System\n`;
    out += this.BEEP;
    out += this.CUT_FEED;

    return Buffer.from(out, 'utf8');
  }
}
