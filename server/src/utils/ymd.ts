/** Business dates are plain 'YYYY-MM-DD' strings in India time (Asia/Kolkata). */
export const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export const todayIST = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

const toUtc = (ymd: string): Date => new Date(`${ymd}T00:00:00Z`);
const fromUtc = (d: Date): string => d.toISOString().slice(0, 10);

export const isValidYmd = (v: unknown): v is string =>
  typeof v === 'string' && YMD_RE.test(v) && fromUtc(toUtc(v)) === v;

export const addDays = (ymd: string, days: number): string => {
  const d = toUtc(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
};

export const daysInMonth = (ymd: string): number => {
  const [y, m] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

export const firstOfMonth = (ymd: string): string => `${ymd.slice(0, 7)}-01`;
export const lastOfMonth = (ymd: string): string => `${ymd.slice(0, 7)}-${String(daysInMonth(ymd)).padStart(2, '0')}`;
export const minYmd = (a: string, b: string): string => (a < b ? a : b);
export const maxYmd = (a: string, b: string): string => (a > b ? a : b);
