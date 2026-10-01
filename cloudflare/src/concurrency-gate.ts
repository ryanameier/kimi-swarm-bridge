/** Admission logic for AiandGate, kept free of Workers imports so it can be unit-tested. */

export const DEFAULT_AIAND_CONCURRENCY = 100;
/** A lease not released within this time (lost release, dropped connection) is dropped. */
const LEASE_TTL_MS = 5 * 60_000;
/**
 * Longest a request waits for a slot. After that it goes ahead without one, so
 * leases held by requests that died (for example an aborted run) can never
 * stall the organization; at worst ai& rate-limits and Kimi backs off.
 */
export const MAX_WAIT_MS = 120_000;
/** While requests are queued, expired leases are swept this often. */
const SWEEP_MS = 15_000;

export interface GateStats {
	limit: number;
	source: "override" | "env" | "default";
	active: number;
	queued: number;
	peakActive: number;
	waited: number;
	totalWaitMs: number;
	/** Requests that waited the maximum and went ahead without a slot. */
	bypassed: number;
	since: number;
}

export interface GateEnv {
	AIAND_CONCURRENCY_LIMIT?: string;
}

export function envConcurrencyLimit(env: GateEnv): { limit: number; source: "env" | "default" } {
	const parsed = Number.parseInt(env.AIAND_CONCURRENCY_LIMIT ?? "", 10);
	return Number.isFinite(parsed) && parsed >= 0 ? { limit: parsed, source: "env" } : { limit: DEFAULT_AIAND_CONCURRENCY, source: "default" };
}

/** Pure admission logic, kept separate from the Durable Object for tests. */
export class ConcurrencyGate {
	private readonly leases = new Map<string, number>();
	private readonly waiting: Array<{ id: string; since: number; resolve: (waitMs: number) => void; timer: ReturnType<typeof setTimeout> }> = [];
	private sweeper: ReturnType<typeof setInterval> | undefined;
	/** Requests that waited MAX_WAIT_MS and went ahead without a slot. */
	bypassed = 0;
	private nextId = 0;
	peakActive = 0;
	waited = 0;
	totalWaitMs = 0;
	since = Date.now();

	constructor(public limit: number, private readonly now: () => number = Date.now) {}

	get active(): number {
		return this.leases.size;
	}

	get queued(): number {
		return this.waiting.length;
	}

	/** Resolves with the lease id once a slot is free, plus how long it waited. */
	acquire(): Promise<{ id: string; waitMs: number }> {
		this.expire();
		const id = `l${(this.nextId += 1)}`;
		if (this.limit <= 0 || (this.leases.size < this.limit && this.waiting.length === 0)) {
			this.admit(id);
			return Promise.resolve({ id, waitMs: 0 });
		}
		this.startSweeper();
		return new Promise((resolve) => {
			const since = this.now();
			const timer = setTimeout(() => {
				const index = this.waiting.findIndex((entry) => entry.id === id);
				if (index === -1) return;
				this.waiting.splice(index, 1);
				this.bypassed += 1;
				// Not admitted: its later release() is a no-op.
				resolve({ id, waitMs: this.now() - since });
			}, MAX_WAIT_MS);
			this.waiting.push({ id, since, timer, resolve: (waitMs) => resolve({ id, waitMs }) });
		});
	}

	release(id: string): void {
		this.leases.delete(id);
		this.drain();
	}

	setLimit(limit: number): void {
		this.limit = limit;
		this.drain();
	}

	private admit(id: string): void {
		this.leases.set(id, this.now());
		this.peakActive = Math.max(this.peakActive, this.leases.size);
	}

	private drain(): void {
		while (this.waiting.length > 0 && (this.limit <= 0 || this.leases.size < this.limit)) {
			const next = this.waiting.shift()!;
			clearTimeout(next.timer);
			const waitMs = this.now() - next.since;
			this.admit(next.id);
			this.waited += 1;
			this.totalWaitMs += waitMs;
			next.resolve(waitMs);
		}
	}

	private expire(): void {
		const cutoff = this.now() - LEASE_TTL_MS;
		for (const [id, at] of this.leases) if (at < cutoff) this.leases.delete(id);
		this.drain();
		if (this.waiting.length === 0 && this.sweeper !== undefined) {
			clearInterval(this.sweeper);
			this.sweeper = undefined;
		}
	}

	/** Expired leases are otherwise only noticed when a new request arrives. */
	private startSweeper(): void {
		this.sweeper ??= setInterval(() => this.expire(), SWEEP_MS);
	}
}
