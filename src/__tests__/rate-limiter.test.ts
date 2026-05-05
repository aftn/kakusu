import { TokenBucket } from "@/utils/rateLimiter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("TokenBucket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows bursts up to maxTokens without waiting", async () => {
    const bucket = new TokenBucket(5, 10);
    const results: number[] = [];
    // All 5 should resolve immediately
    for (let i = 0; i < 5; i++) {
      await bucket.acquire();
      results.push(i);
    }
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it("blocks when tokens are exhausted and resolves after refill", async () => {
    const bucket = new TokenBucket(2, 10); // 2 burst, 10/sec refill

    // Exhaust burst
    await bucket.acquire();
    await bucket.acquire();

    // Third acquire should block
    let resolved = false;
    const p = bucket.acquire().then(() => {
      resolved = true;
    });

    // Not yet resolved
    expect(resolved).toBe(false);
    expect(bucket.pending).toBe(1);

    // Advance time by 100ms (should refill 1 token at 10/sec)
    await vi.advanceTimersByTimeAsync(100);
    await p;

    expect(resolved).toBe(true);
    expect(bucket.pending).toBe(0);
  });

  it("drains multiple waiters in FIFO order", async () => {
    const bucket = new TokenBucket(1, 5); // 1 burst, 5/sec

    await bucket.acquire(); // exhaust

    const order: number[] = [];
    const p1 = bucket.acquire().then(() => order.push(1));
    const p2 = bucket.acquire().then(() => order.push(2));
    const p3 = bucket.acquire().then(() => order.push(3));

    expect(bucket.pending).toBe(3);

    // Refill happens at 5/sec = 1 token per 200ms
    // After 200ms: 1 token → waiter 1 resolved
    await vi.advanceTimersByTimeAsync(200);
    await p1;
    expect(order).toEqual([1]);

    // After another 200ms: waiter 2
    await vi.advanceTimersByTimeAsync(200);
    await p2;
    expect(order).toEqual([1, 2]);

    // After another 200ms: waiter 3
    await vi.advanceTimersByTimeAsync(200);
    await p3;
    expect(order).toEqual([1, 2, 3]);
    expect(bucket.pending).toBe(0);
  });

  it("refills tokens over elapsed time", async () => {
    const bucket = new TokenBucket(10, 10);

    // Use all 10 tokens
    for (let i = 0; i < 10; i++) {
      await bucket.acquire();
    }

    // Advance 500ms → 5 tokens refilled
    await vi.advanceTimersByTimeAsync(500);

    // Should be able to acquire 5 immediately
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      await bucket.acquire();
      results.push(true);
    }
    expect(results.length).toBe(5);
  });

  it("does not exceed maxTokens on refill", async () => {
    const bucket = new TokenBucket(3, 10);

    // Wait 5 seconds (50 tokens worth of refill)
    await vi.advanceTimersByTimeAsync(5000);

    // Should still only have 3 tokens (maxTokens cap)
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();

    // 4th should block
    let blocked = false;
    const p = bucket.acquire().then(() => {
      blocked = true;
    });
    expect(blocked).toBe(false);

    // Clean up
    await vi.advanceTimersByTimeAsync(200);
    await p;
  });

  it("sustains throughput at refill rate under continuous load", async () => {
    const bucket = new TokenBucket(3, 10); // 3 burst, 10/sec

    // Exhaust burst tokens
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();

    // Queue 10 more acquires
    let completed = 0;
    const promises = Array.from({ length: 10 }, () =>
      bucket.acquire().then(() => {
        completed++;
      }),
    );

    expect(bucket.pending).toBe(10);

    // Advance 1 second → should refill 10 tokens → all 10 resolved
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(promises);

    expect(completed).toBe(10);
    expect(bucket.pending).toBe(0);
  });
});
