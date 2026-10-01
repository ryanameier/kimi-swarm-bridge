import { describe, expect, it, vi } from "vitest";
import { ConcurrencyGate, envConcurrencyLimit, MAX_WAIT_MS } from "../src/concurrency-gate";

describe("ConcurrencyGate", () => {
	it("admits up to the limit and queues the rest in arrival order", async () => {
		let now = 0;
		const gate = new ConcurrencyGate(2, () => now);
		const a = await gate.acquire();
		const b = await gate.acquire();
		const order: string[] = [];
		const c = gate.acquire().then((lease) => (order.push("c"), lease));
		const d = gate.acquire().then((lease) => (order.push("d"), lease));
		expect(gate.active).toBe(2);
		expect(gate.queued).toBe(2);
		now = 40;
		gate.release(a.id);
		expect((await c).waitMs).toBe(40);
		gate.release(b.id);
		await d;
		expect(order).toEqual(["c", "d"]);
		expect(gate.peakActive).toBe(2);
		expect(gate.waited).toBe(2);
	});

	it("lets queued requests through when the limit is raised or turned off", async () => {
		const gate = new ConcurrencyGate(1);
		await gate.acquire();
		const waiting = gate.acquire();
		gate.setLimit(0);
		await expect(waiting).resolves.toMatchObject({ waitMs: expect.any(Number) });
		expect(gate.active).toBe(2);
	});

	it("drops leases that were never released", async () => {
		let now = 0;
		const gate = new ConcurrencyGate(1, () => now);
		await gate.acquire();
		now = 6 * 60_000;
		await expect(gate.acquire()).resolves.toMatchObject({ waitMs: 0 });
	});

	it("lets a request through without a slot after the maximum wait, so dead leases cannot stall everyone", async () => {
		vi.useFakeTimers();
		try {
			const gate = new ConcurrencyGate(1);
			await gate.acquire(); // never released, like a request from an aborted run
			const waiting = gate.acquire();
			await vi.advanceTimersByTimeAsync(MAX_WAIT_MS);
			const lease = await waiting;
			expect(lease.waitMs).toBeGreaterThanOrEqual(MAX_WAIT_MS);
			expect(gate.bypassed).toBe(1);
			expect(gate.queued).toBe(0);
			gate.release(lease.id); // no-op for a bypassed request
			expect(gate.active).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("sweeps expired leases while requests wait, without needing a new request", async () => {
		vi.useFakeTimers();
		try {
			let now = 0;
			const gate = new ConcurrencyGate(1, () => now);
			await gate.acquire();
			const waiting = gate.acquire();
			now = 5 * 60_000 + 1;
			await vi.advanceTimersByTimeAsync(15_000);
			await expect(waiting).resolves.toMatchObject({ waitMs: now });
			expect(gate.bypassed).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reads the limit from the environment with a default of 100", () => {
		expect(envConcurrencyLimit({})).toEqual({ limit: 100, source: "default" });
		expect(envConcurrencyLimit({ AIAND_CONCURRENCY_LIMIT: "1000" })).toEqual({ limit: 1000, source: "env" });
		expect(envConcurrencyLimit({ AIAND_CONCURRENCY_LIMIT: "0" })).toEqual({ limit: 0, source: "env" });
	});
});
