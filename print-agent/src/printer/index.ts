import { SharedPrinter } from './sharedPrinter';
import { TcpPrinter } from './tcpPrinter';
import { WindowsPrinter } from './windowsPrinter';

/**
 * Sends raw ESC/POS bytes to whatever kind of printer the address describes:
 *   printer:POS-80C        a printer installed on this Windows PC (e.g. USB) — recommended
 *   \\PC-NAME\ShareName    a printer shared from another Windows PC
 *   192.168.1.100          a network (Ethernet/Wi-Fi) printer on port 9100
 */
export const printTo = async (target: string, buffer: Buffer): Promise<void> => {
  if (WindowsPrinter.isPrinterTarget(target)) return WindowsPrinter.printRaw(target, buffer);
  if (SharedPrinter.isShareTarget(target)) return SharedPrinter.printRaw(target, buffer);
  return TcpPrinter.printRaw(target.trim(), buffer);
};

export const describeTarget = (target: string): string =>
  WindowsPrinter.isPrinterTarget(target)
    ? `printer "${WindowsPrinter.printerName(target)}" on this PC`
    : SharedPrinter.isShareTarget(target)
      ? `shared printer ${SharedPrinter.normalise(target)}`
      : `network printer ${target.trim()}:9100`;
