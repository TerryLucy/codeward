/**
 * Per-key serial work queue. While a job for a key is running, newer submissions replace any
 * pending one (latest push wins), so rapid pushes don't trigger redundant reviews.
 */
export class KeyedQueue {
  private readonly running = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, () => Promise<void>>();
  private readonly onError: (key: string, err: unknown) => void;

  constructor(onError: (key: string, err: unknown) => void) {
    this.onError = onError;
  }

  submit(key: string, job: () => Promise<void>): void {
    if (this.running.has(key)) {
      this.pending.set(key, job);
      return;
    }
    this.start(key, job);
  }

  get size(): number {
    return this.running.size + this.pending.size;
  }

  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all(this.running.values());
  }

  private start(key: string, job: () => Promise<void>): void {
    const p = job()
      .catch((err: unknown) => this.onError(key, err))
      .finally(() => {
        this.running.delete(key);
        const next = this.pending.get(key);
        if (next) {
          this.pending.delete(key);
          this.start(key, next);
        }
      });
    this.running.set(key, p);
  }
}
