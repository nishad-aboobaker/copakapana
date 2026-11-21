import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

/**
 * Prints raw ESC/POS bytes to a printer installed on THIS Windows PC, by its
 * name as shown in "Printers & scanners" — e.g. a USB receipt printer.
 *
 *   Address format:  printer:POS-80C
 *
 * Uses the Windows print spooler directly (OpenPrinter / WritePrinter with the
 * RAW data type), the same way POS software does. Nothing on the PC is changed:
 * no printer sharing, no network settings, no driver changes. Jobs simply join
 * the printer's normal queue alongside any other software's jobs.
 */
const PS_SCRIPT = String.raw`
param([string]$Printer, [string]$Path)
$ErrorActionPreference = 'Stop'
$src = @"
using System;
using System.Runtime.InteropServices;
public static class KotRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool OpenPrinter(string name, out IntPtr h, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern int StartDocPrinter(IntPtr h, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);
  public static void Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("NOT_FOUND");
    try {
      var di = new DOCINFO { pDocName = "Copakapana bill", pDataType = "RAW" };
      if (StartDocPrinter(h, 1, di) == 0) throw new Exception("START_FAILED " + Marshal.GetLastWin32Error());
      try {
        StartPagePrinter(h);
        int written;
        if (!WritePrinter(h, data, data.Length, out written) || written != data.Length)
          throw new Exception("WRITE_FAILED " + Marshal.GetLastWin32Error());
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
if (-not ('KotRawPrinter' -as [type])) { Add-Type -TypeDefinition $src }
[KotRawPrinter]::Send($Printer, [IO.File]::ReadAllBytes($Path))
Write-Output 'PRINTED'
`;

let scriptPath: string | null = null;

const ensureScript = async (): Promise<string> => {
  if (scriptPath) return scriptPath;
  const p = path.join(os.tmpdir(), 'kot-rawprint.ps1');
  await fs.writeFile(p, PS_SCRIPT, 'utf8');
  scriptPath = p;
  return p;
};

const run = (args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile('powershell.exe', args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

export class WindowsPrinter {
  public static isPrinterTarget(target: string): boolean {
    return /^printer:.+/i.test(target.trim());
  }

  public static printerName(target: string): string {
    return target.trim().replace(/^printer:/i, '').trim();
  }

  public static async printRaw(target: string, buffer: Buffer, timeoutMs = 30_000): Promise<void> {
    if (process.platform !== 'win32') throw new Error('printer:<name> addresses only work when the print agent runs on Windows');
    const name = this.printerName(target);
    const script = await ensureScript();
    const file = path.join(os.tmpdir(), `kot-print-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
    await fs.writeFile(file, buffer);
    try {
      // -ExecutionPolicy Bypass applies to this one process only; the PC's policy is not changed
      const { stdout } = await run(
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Printer', name, '-Path', file],
        timeoutMs,
      );
      if (!/PRINTED/.test(stdout)) throw new Error(`Printer "${name}" did not confirm the job`);
    } catch (err: any) {
      const text = `${err?.stderr ?? ''}${err?.stdout ?? ''}${err?.message ?? ''}`;
      if (/NOT_FOUND/.test(text)) {
        throw new Error(`No printer called "${name}" on this PC. Run "npm run list-printers" to see the exact names.`);
      }
      throw new Error(`Printing to "${name}" failed: ${text.split('\n').find((l) => l.trim()) ?? 'unknown error'}`);
    } finally {
      fs.unlink(file).catch(() => {});
    }
  }

  /** Names of printers installed on this PC (for setup). */
  public static async list(): Promise<string[]> {
    if (process.platform !== 'win32') return [];
    const { stdout } = await run(['-NoProfile', '-NonInteractive', '-Command', 'Get-Printer | Select-Object -ExpandProperty Name'], 20_000);
    return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
}
