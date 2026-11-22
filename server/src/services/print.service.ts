import { AuditLog } from '../models/AuditLog';
import { IPrintJob, PrintJob } from '../models/PrintJob';
import { emitToRoom, emitToStaff, isAgentConnected, registerSocketHandlers } from '../socket';
import { PrintStatus } from '../types';

/**
 * Bill printing only (tickets go to station screens).
 * Every job is persisted first, so jobs survive server/agent restarts and an
 * offline agent receives its backlog when it reconnects.
 */

/** Agent must acknowledge within this window or the job is treated as failed. */
const ACK_TIMEOUT_MS = 25_000; // agent retries 3× with a 5 s TCP timeout + 1 s gaps (~17 s worst case)
const MAX_SERVER_ATTEMPTS = 1; // agent already retries 3 times per dispatch

const sendToAgent = (job: IPrintJob): void => {
  emitToRoom('print-agent', 'print:job', {
    ...(job.payload as Record<string, unknown>),
    jobId: job._id.toString(),
    type: job.type,
    printerIp: job.targetIp,
  });
};

export const PrintService = {
  async enqueue(type: 'bill' | 'test', targetIp: string, payload: Record<string, unknown>): Promise<IPrintJob> {
    const job = await PrintJob.create({ type, targetIp, payload, status: PrintStatus.Pending, attempts: 0 });
    if (isAgentConnected()) {
      job.attempts = 1;
      job.dispatchedAt = new Date();
      await job.save();
      sendToAgent(job);
    }
    return job;
  },

  async handleResult(result: { jobId: string; status: 'printed' | 'failed'; error?: string }): Promise<void> {
    const job = await PrintJob.findById(result.jobId).catch(() => null);
    if (!job) return;

    if (result.status === 'printed') {
      job.status = PrintStatus.Printed;
      job.lastError = undefined;
    } else {
      job.status = PrintStatus.Failed;
      job.lastError = result.error || 'Printer error';
      emitToStaff('print:failed', { jobId: job._id, type: job.type, error: job.lastError });
    }
    await job.save();
  },

  /** Agent (re)connected: send everything still pending. */
  async drainPending(): Promise<void> {
    const pending = await PrintJob.find({ status: PrintStatus.Pending }).sort({ createdAt: 1 }).limit(100);
    for (const job of pending) {
      job.attempts = (job.attempts || 0) + 1;
      job.dispatchedAt = new Date();
      await job.save();
      sendToAgent(job);
    }
  },

  /** Jobs dispatched but never acknowledged → failed, so the cashier sees an alert. */
  async expireUnacknowledged(): Promise<void> {
    const stale = await PrintJob.find({
      status: PrintStatus.Pending,
      dispatchedAt: { $lte: new Date(Date.now() - ACK_TIMEOUT_MS) },
      attempts: { $gte: MAX_SERVER_ATTEMPTS },
    });
    for (const job of stale) {
      job.status = PrintStatus.Failed;
      job.lastError = 'No acknowledgement from print agent';
      await job.save();
      emitToStaff('print:failed', { jobId: job._id, type: job.type, error: job.lastError });
    }
  },

  /** Cashier one-click retry of a failed job. */
  async retry(jobId: string, userId?: string): Promise<IPrintJob | null> {
    const job = await PrintJob.findById(jobId).catch(() => null);
    if (!job) return null;
    job.status = PrintStatus.Pending;
    job.lastError = undefined;
    job.dispatchedAt = undefined;
    await job.save();
    await AuditLog.create({ action: 'print_job_retried', userId, entity: 'PrintJob', entityId: job._id });
    if (isAgentConnected()) {
      job.attempts = (job.attempts || 0) + 1;
      job.dispatchedAt = new Date();
      await job.save();
      sendToAgent(job);
    }
    return job;
  },
};

export const initPrintWatchers = (): NodeJS.Timeout => {
  registerSocketHandlers({
    printResult: (r) => PrintService.handleResult(r),
    agentConnected: () => PrintService.drainPending(),
  });
  return setInterval(() => {
    PrintService.expireUnacknowledged().catch((err) => console.error('print watchdog failed', err));
  }, 5_000);
};
