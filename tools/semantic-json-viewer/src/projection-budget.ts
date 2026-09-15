// Consumers must keep canEvict read-only. evict may only release the already
// accounted projection and must not synchronously admit or load another one.
export type ProjectionEvict = () => void;

type BudgetEntry = {
  bytes: number;
  evict: ProjectionEvict;
  canEvict: () => boolean;
};

export class ProjectionBudget {
  private readonly limit: number;
  private used = 0;
  private readonly entries = new Map<object, BudgetEntry>();

  constructor(limitBytes = 32 * 1024 * 1024) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
      throw new RangeError("Projection budget must be a non-negative safe integer.");
    }
    this.limit = limitBytes;
  }

  get usedBytes(): number {
    return this.used;
  }

  admit(key: object, bytes: number, evict: ProjectionEvict, canEvict: () => boolean = () => true): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit) return false;
    const existing = this.entries.get(key);
    const baseUsed = this.used - (existing?.bytes ?? 0);
    let available = this.limit - baseUsed;
    const victims: Array<[object, BudgetEntry]> = [];
    if (available < bytes) {
      for (const [candidateKey, candidate] of this.entries) {
        if (candidateKey === key || !candidate.canEvict()) continue;
        victims.push([candidateKey, candidate]);
        available += candidate.bytes;
        if (available >= bytes) break;
      }
    }
    if (available < bytes) return false;

    if (existing) {
      this.entries.delete(key);
      this.used -= existing.bytes;
    }
    for (const [victimKey, victim] of victims) {
      this.entries.delete(victimKey);
      this.used -= victim.bytes;
    }
    this.entries.set(key, { bytes, evict, canEvict });
    this.used += bytes;
    for (const [, victim] of victims) victim.evict();
    return true;
  }

  touch(key: object): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  release(key: object): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.used -= entry.bytes;
  }
}
