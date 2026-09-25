import { describe, expect, it } from "vitest";
import { ConcurrencyGate, envConcurrencyLimit } from "../src/concurrency-gate";

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

	it("reads the limit from the environment with a default of 100", () => {
		expect(envConcurrencyLimit({})).toEqual({ limit: 100, source: "default" });
		expect(envConcurrencyLimit({ AIAND_CONCURRENCY_LIMIT: "1000" })).toEqual({ limit: 1000, source: "env" });
		expect(envConcurrencyLimit({ AIAND_CONCURRENCY_LIMIT: "0" })).toEqual({ limit: 0, source: "env" });
	});
});
