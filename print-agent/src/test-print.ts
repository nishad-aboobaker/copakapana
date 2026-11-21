/**
 * Print a sample bill straight to a printer — no server, no login needed.
 *
 *   npm run list-printers                                 (printers installed on this PC)
 *   npm run test-print -- "printer:POS-80C"               (printer on this PC, e.g. USB — recommended)
 *   npm run test-print -- "\\DESKTOP-HT9KF41\POS80"       (printer shared from another PC)
 *   npm run test-print -- 192.168.1.100                   (network printer, port 9100)
 *   add --page for a short diagnostic page instead of a sample bill
 */
import { EscposFormatter } from './escpos/formatter';
import { describeTarget, printTo } from './printer';
import { WindowsPrinter } from './printer/windowsPrinter';

const args = process.argv.slice(2);

(async () => {
  if (args.includes('--list')) {
    const names = await WindowsPrinter.list();
    if (!names.length) {
      console.log('No printers found on this PC.');
      return;
    }
    console.log('Printers on this PC — use one as   printer:<name>\n');
    names.forEach((n) => console.log(`  printer:${n}`));
    return;
  }

  const target = args.find((a) => !a.startsWith('--'));
  if (!target) {
    console.log('Usage:  npm run test-print -- "printer:<name>"   |   "\\\\PC\\Share"   |   <printer-ip>');
    console.log('        npm run list-printers   to see printer names on this PC');
    process.exit(1);
  }

  const pageOnly = args.includes('--page');
  const buffer = pageOnly
    ? EscposFormatter.formatTestPrint({ targetIp: target, timestamp: new Date().toISOString() })
    : EscposFormatter.formatBill({
        restaurantName: 'CopaKapana Restaurant',
        address: 'Chamravattam',
        phones: ['9072211810', '9072211820', '9072211830'],
        footer: '***Thanks for visiting***',
        footerNote: 'TEST PRINT - not a real bill',
        cashierName: 'test',
        number: 0,
        date: new Date().toISOString(),
        orderType: 'takeaway',
        customer: {},
        itemsSnapshot: [
          { name: 'Paratha', qty: 3, price: 15 },
          { name: 'Pepsi 20', qty: 1, price: 20 },
        ],
        subtotal: 65,
        total: 65,
        payments: [{ mode: 'cash', amount: 65 }],
      });

  console.log(`Sending a test ${pageOnly ? 'page' : 'bill'} to ${describeTarget(target)} …`);
  try {
    await printTo(target, buffer);
    console.log('✅ Sent. Check the printer.');
  } catch (err: any) {
    console.error('❌ ' + (err?.message || err));
    process.exit(1);
  }
})();
