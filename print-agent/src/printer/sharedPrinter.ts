import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const BS = '\\';

/**
 * Sends raw ESC/POS bytes to a printer shared through Windows
 * (e.g. a USB receipt printer on another PC): \\COMPUTER\ShareName
 *
 * Uses `copy /b`, which hands the bytes to the print spooler unchanged —
 * the standard way to drive a shared receipt printer without extra drivers.
 * Works from the PC the printer is plugged into (\\localhost\ShareName) and
 * from any other Windows PC on the network that can open the share.
 */
export class SharedPrinter {
  /** \\HOST\Share (forward slashes accepted too) */
  public static isShareTarget(target: string): boolean {
    return /^(\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(target.trim());
  }

  public static normalise(target: string): string {
    return target.trim().split('/').join(BS);
  }

  public static async printRaw(target: string, buffer: Buffer, timeoutMs = 20_000): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('Shared printers (\\\\PC\\Printer) can only be used when the print agent runs on Windows');
    }
    const share = this.normalise(target);
    const file = path.join(os.tmpdir(), `kot-print-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
    await fs.writeFile(file, buffer);
    try {
      await new Promise<void>((resolve, reject) => {
        execFile('cmd.exe', ['/d', '/c', 'copy', '/b', file, share], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
          const out = `${stdout ?? ''}${stderr ?? ''}`.trim();
          if (err) return reject(new Error(this.explain(out, share) || err.message));
          // copy prints "1 file(s) copied." on success
          if (/1 file\(s\) copied/i.test(out)) return resolve();
          reject(new Error(this.explain(out, share) || `Printer share did not accept the job: ${out}`));
        });
      });
    } finally {
      fs.unlink(file).catch(() => {});
    }
  }

  /** Turn Windows error text into something the cashier can act on. */
  private static explain(out: string, share: string): string {
    const pc = share.split(BS).slice(0, 3).join(BS);
    if (/network name cannot be found|network path was not found/i.test(out)) {
      return `Can't find ${share}. Check that ${pc} is switched on, the printer is shared with exactly that name, and file & printer sharing is on.`;
    }
    if (/access is denied|logon failure|user name or password|credentials/i.test(out)) {
      return `Windows refused access to ${share}. Open ${pc} in File Explorer on this computer, sign in with that PC's Windows account and tick "Remember my credentials".`;
    }
    return out;
  }
}
