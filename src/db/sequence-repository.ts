export interface SequenceRepository {
  isBootstrapped(name: string): Promise<boolean>;
  bootstrap(name: string, initialNextValue: number): Promise<void>;
  allocateNext(name: string): Promise<number>;
}

export function createSequenceRepository(db: D1Database): SequenceRepository {
  return {
    async isBootstrapped(name) {
      const row = await db
        .prepare(`SELECT bootstrapped_at FROM sequences WHERE name = ?`)
        .bind(name)
        .first<{ bootstrapped_at: string | null }>();
      return row !== null && row.bootstrapped_at !== null;
    },

    async bootstrap(name, initialNextValue) {
      const now = new Date().toISOString();
      await db
        .prepare(
          `INSERT INTO sequences (name, next_value, bootstrapped_at) VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             next_value = excluded.next_value,
             bootstrapped_at = excluded.bootstrapped_at
           WHERE sequences.bootstrapped_at IS NULL`
        )
        .bind(name, initialNextValue, now)
        .run();
    },

    async allocateNext(name) {
      const result = await db
        .prepare(
          `UPDATE sequences SET next_value = next_value + 1
           WHERE name = ? AND bootstrapped_at IS NOT NULL
           RETURNING next_value - 1 AS allocated`
        )
        .bind(name)
        .first<{ allocated: number }>();
      if (result === null) {
        throw new Error(`sequence "${name}" not bootstrapped`);
      }
      return result.allocated;
    },
  };
}
