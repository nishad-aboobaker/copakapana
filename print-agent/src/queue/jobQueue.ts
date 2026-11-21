import { EscposFormatter } from '../escpos/formatter';
import { describeTarget, printTo } from '../printer';

/** Bill and test-print jobs only — KOTs are shown on kitchen station screens. */
export interface PrintJobTask {
  jobId: string;
  type: 'bill' | 'test';
  printerIp?: string;
  isReprint?: boolean;
  [key: string]: any;
}

export class JobQueue {
  private queue: PrintJobTask[] = [];
  private isProcessing = false;
  private onJobResultCallback?: (jobId: string, status: 'printed' | 'failed', error?: string) => void;

  constructor(onResult?: (jobId: string, status: 'printed' | 'failed', error?: string) => void) {
    this.onJobResultCallback = onResult;
  }

  public enqueue(job: PrintJobTask): void {
    // The server re-sends pending jobs on reconnect; ignore ones already queued
    if (this.queue.some((q) => q.jobId === job.jobId)) return;
    if (job.type !== 'bill' && job.type !== 'test') {
      console.warn(`⚠️ Ignoring unsupported job type "${job.type}" [${job.jobId}]`);
      this.onJobResultCallback?.(job.jobId, 'failed', `Unsupported job type ${job.type}`);
      return;
    }
    console.log(`📥 Enqueued ${job.type} print job [${job.jobId}]`);
    this.queue.push(job);
    this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    const currentJob = this.queue.shift()!;

    const buffer =
      currentJob.type === 'test'
        ? EscposFormatter.formatTestPrint(currentJob)
        : EscposFormatter.formatBill(currentJob);

    const targetIp = currentJob.printerIp;
    if (!targetIp) {
      this.onJobResultCallback?.(currentJob.jobId, 'failed', 'No printer IP in job');
      this.isProcessing = false;
      this.processNext();
      return;
    }
    let attempts = 0;
    const maxRetries = 3;
    let success = false;
    let lastError = '';

    while (attempts < maxRetries && !success) {
      attempts++;
      try {
        console.log(`🖨️  Printing job [${currentJob.jobId}] to ${describeTarget(targetIp)} (attempt ${attempts}/${maxRetries})...`);
        // printer:<name> (this PC) · \\PC\Share (shared) · IP (network printer, port 9100)
        await printTo(targetIp, buffer);
        success = true;
        console.log(`✅ Print job [${currentJob.jobId}] printed successfully`);
      } catch (err: any) {
        lastError = err.message || 'Printer TCP error';
        console.warn(`⚠️ Attempt ${attempts} failed for [${currentJob.jobId}]: ${lastError}`);
        if (attempts < maxRetries) {
          // 1-second delay between retries
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }

    if (success) {
      this.onJobResultCallback?.(currentJob.jobId, 'printed');
    } else {
      console.error(`❌ Print job [${currentJob.jobId}] failed after ${maxRetries} attempts.`);
      this.onJobResultCallback?.(currentJob.jobId, 'failed', lastError);
    }

    this.isProcessing = false;
    this.processNext();
  }
}
