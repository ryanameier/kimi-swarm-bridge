import { DurableObject } from "cloudflare:workers";
import { ConcurrencyGate, envConcurrencyLimit, type GateEnv, type GateStats } from "./concurrency-gate";

export { DEFAULT_AIAND_CONCURRENCY } from "./concurrency-gate";

/**
 * Organization-wide cap on simultaneous ai& model requests.
 *
 * ai& limits requests in flight per organization (X-RateLimit-Limit; every key in
 * the org shares it). Every employee's container sends its model calls through
 * one instance of this object, which lets up to `limit` run at once and queues
 * the rest in arrival order, so a busy organization waits briefly instead of
 * getting HTTP 429s and Kimi's exponential backoff.
 *
 * The limit is AIAND_CONCURRENCY_LIMIT (default 100, 0 = off), or an admin
 * override stored here (POST /admin/aiand-limit), which applies immediately.
 * State is in memory: if the object restarts, counting starts again from zero.
 */

export class AiandGate extends DurableObject<GateEnv> {
	private gate: ConcurrencyGate | undefined;
	private source: GateStats["source"] = "default";

	private async load(): Promise<ConcurrencyGate> {
		if (this.gate) return this.gate;
		const override = await this.ctx.storage.get<number>("limit");
		const fromEnv = envConcurrencyLimit(this.env);
		this.source = override === undefined ? fromEnv.source : "override";
		this.gate = new ConcurrencyGate(override ?? fromEnv.limit);
		return this.gate;
	}

	async acquire(): Promise<{ id: string; waitMs: number }> {
		return (await this.load()).acquire();
	}

	async release(id: string): Promise<void> {
		(await this.load()).release(id);
	}

	/** null clears the override and returns to AIAND_CONCURRENCY_LIMIT. */
	async setLimit(limit: number | null): Promise<GateStats> {
		const gate = await this.load();
		if (limit === null) {
			await this.ctx.storage.delete("limit");
			const fromEnv = envConcurrencyLimit(this.env);
			this.source = fromEnv.source;
			gate.setLimit(fromEnv.limit);
		} else {
			await this.ctx.storage.put("limit", limit);
			this.source = "override";
			gate.setLimit(limit);
		}
		return this.stats();
	}

	async stats(): Promise<GateStats> {
		const gate = await this.load();
		return {
			limit: gate.limit,
			source: this.source,
			active: gate.active,
			queued: gate.queued,
			peakActive: gate.peakActive,
			waited: gate.waited,
			totalWaitMs: gate.totalWaitMs,
			since: gate.since,
		};
	}

	/** Clears the peak/wait counters (for measuring one run). */
	async resetStats(): Promise<GateStats> {
		const gate = await this.load();
		gate.peakActive = gate.active;
		gate.waited = 0;
		gate.totalWaitMs = 0;
		gate.since = Date.now();
		return this.stats();
	}
}
