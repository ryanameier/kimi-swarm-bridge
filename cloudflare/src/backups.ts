/**
 * Backup objects in R2. The Sandbox SDK stores each backup under
 * `backups/<id>/` (`data.sqsh` + `meta.json`). Backup names start with the
 * sandbox id so admins can attribute, list and delete them.
 */

const PREFIX = "backups/";
const METADATA = "meta.json";

export interface BackupBucket {
	list(options: { prefix: string; cursor?: string }): Promise<{ objects: { key: string; size: number }[]; truncated: boolean; cursor?: string }>;
	get(key: string): Promise<{ json<T>(): Promise<T> } | null>;
	delete(keys: string | string[]): Promise<void>;
}

export interface BackupInfo {
	id: string;
	name: string | null;
	dir: string | null;
	sandboxId: string | null;
	sizeBytes: number;
	createdAt: string | null;
}

export function backupName(sandboxId: string, dir: string, now = new Date()): string {
	return `${sandboxId}${dir.replace(/\//g, "_")}-${now.toISOString()}`;
}

export function sandboxOfBackup(name: string | null): string | null {
	return /^(user-[0-9a-f]{40})_/.exec(name ?? "")?.[1] ?? null;
}

async function listKeys(bucket: BackupBucket, prefix: string): Promise<{ key: string; size: number }[]> {
	const objects: { key: string; size: number }[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor });
		objects.push(...page.objects);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return objects;
}

/** All backups in the bucket, newest first. */
export async function listBackups(bucket: BackupBucket): Promise<BackupInfo[]> {
	const objects = await listKeys(bucket, PREFIX);
	const sizes = new Map<string, number>();
	for (const { key, size } of objects) {
		const id = key.slice(PREFIX.length).split("/")[0];
		sizes.set(id, (sizes.get(id) ?? 0) + size);
	}
	const backups: BackupInfo[] = [];
	for (const id of sizes.keys()) {
		let meta: { name?: string | null; dir?: string; createdAt?: string } = {};
		try {
			meta = (await (await bucket.get(`${PREFIX}${id}/${METADATA}`))?.json()) ?? {};
		} catch {
			// Incomplete backup without readable metadata.
		}
		backups.push({
			id,
			name: meta.name ?? null,
			dir: meta.dir ?? null,
			sandboxId: sandboxOfBackup(meta.name ?? null),
			sizeBytes: sizes.get(id) ?? 0,
			createdAt: meta.createdAt ?? null,
		});
	}
	return backups.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/** Delete every object of one backup. Returns the number of objects removed. */
export async function deleteBackup(bucket: BackupBucket, id: string): Promise<number> {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid backup id: ${id}`);
	const keys = (await listKeys(bucket, `${PREFIX}${id}/`)).map((o) => o.key);
	if (keys.length) await bucket.delete(keys);
	return keys.length;
}
