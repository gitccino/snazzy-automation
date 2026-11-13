import { parseStoredSettings, type SettingsRecord, type StoredSettings } from '../settings/schema';

type Row = { schema_version: number; settings_json: string; revision: number; updated_at: string };
function parseRow(row: Row): SettingsRecord {
  if (row.schema_version !== 1 || !Number.isSafeInteger(row.revision) || row.revision < 1 || !Number.isFinite(Date.parse(row.updated_at))) throw new Error('Invalid settings record');
  return { schemaVersion: 1, revision: row.revision, updatedAt: row.updated_at, settings: parseStoredSettings(JSON.parse(row.settings_json)) };
}
export async function readSettings(db: D1Database): Promise<SettingsRecord | null> {
  const row = await db.prepare('SELECT schema_version, settings_json, revision, updated_at FROM app_settings WHERE id = 1').first<Row>();
  return row ? parseRow(row) : null;
}
export async function initializeSettings(db: D1Database, settings: StoredSettings, now: string): Promise<SettingsRecord> {
  const parsed = parseStoredSettings(settings);
  await db.prepare('INSERT INTO app_settings (id, schema_version, settings_json, revision, updated_at) VALUES (1, 1, ?, 1, ?) ON CONFLICT(id) DO NOTHING').bind(JSON.stringify(parsed), now).run();
  const record = await readSettings(db);
  if (!record) throw new Error('Settings initialization failed');
  return record;
}
export async function compareAndSetSettings(db: D1Database, expectedRevision: number, candidate: StoredSettings, now: string): Promise<SettingsRecord | null> {
  const parsed = parseStoredSettings(candidate);
  const row = await db.prepare('UPDATE app_settings SET settings_json = ?, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ? RETURNING schema_version, settings_json, revision, updated_at').bind(JSON.stringify(parsed), now, expectedRevision).first<Row>();
  return row ? parseRow(row) : null;
}
