/**
 * Token Bucket rate limiter.
 *
 * Google Drive API quota (drive.file scope) is typically
 * ~1,000 requests / 100 seconds / user ≈ 10 req/s.
 *
 * This limiter controls the rate of outgoing API requests while allowing
 * HTTP/2 stream multiplexing to overlap many concurrent uploads.
 */

/** Pending waiter entry */
interface Waiter {
  resolve: () => void;
}

export class TokenBucket {
  /** Current number of tokens available */
  private tokens: number;
  /** Maximum burst capacity */
  private readonly maxTokens: number;
  /** Token refill rate (tokens per millisecond) */
  private readonly refillRateMs: number;
  /** Last time tokens were refilled */
  private lastRefill: number;
  /** FIFO queue of waiters blocked on acquire */
  private readonly queue: Waiter[] = [];
  /** Timer used to wake the next waiter after a token refills */
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param maxTokens  Maximum burst size (e.g. 10)
   * @param refillPerSec  Tokens added per second (e.g. 10)
   */
  constructor(maxTokens: number, refillPerSec: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRateMs = refillPerSec / 1000;
    this.lastRefill = Date.now();
  }

  /** Refill tokens based on elapsed time */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsed * this.refillRateMs,
    );
    this.lastRefill = now;
  }

  /**
   * Acquire one token. Resolves immediately if a token is available,
   * otherwise waits until one is refilled.
   */
  acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return Promise.resolve();
    }

    // Enqueue waiter — will be drained when tokens become available
    return new Promise<void>((resolve) => {
      this.queue.push({ resolve });
      this.scheduleDrain();
    });
  }

  /** Schedule a timer to drain the waiter queue once the next token refills */
  private scheduleDrain(): void {
    if (this.drainTimer !== null) return; // already scheduled
    // Time until next token becomes available
    const deficit = 1 - this.tokens; // always > 0 here
    const waitMs = Math.max(1, Math.ceil(deficit / this.refillRateMs));
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drainQueue();
    }, waitMs);
  }

  /** Release as many waiters as available tokens allow */
  private drainQueue(): void {
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      const waiter = this.queue.shift()!;
      waiter.resolve();
    }
    // Still have waiters? Schedule another drain
    if (this.queue.length > 0) {
      this.scheduleDrain();
    }
  }

  /** Number of waiters currently blocked */
  get pending(): number {
    return this.queue.length;
  }
}
