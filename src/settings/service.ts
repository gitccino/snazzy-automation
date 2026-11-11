import { compareAndSetSettings, readSettings } from "../db/settings-repository";
import {
  parseSaveSectionRequest,
  parseStoredSettings,
  type SettingsRecord,
  type SettingsResult,
  type StoredSettings,
} from "./schema";

type ValidateChanges = (
  current: StoredSettings,
  candidate: StoredSettings,
  changedKeys: string[],
) => Promise<SettingsResult<void>>;
const airtableKeys = [
  "AIRTABLE_BASE_ID",
  "AIRTABLE_PRODUCTS_TABLE_ID",
  "AIRTABLE_PUBLICATION_RUNS_TABLE_ID",
];

export async function saveSettingsSection(
  db: D1Database,
  input: unknown,
  now: string,
  validate: ValidateChanges,
): Promise<SettingsResult<SettingsRecord>> {
  let request;
  try {
    request = parseSaveSectionRequest(input);
  } catch {
    return { ok: false, code: "invalid_settings" };
  }
  try {
    const current = await readSettings(db);
    if (!current) return { ok: false, code: "settings_unavailable" };
    if (current.revision !== request.expectedRevision)
      return { ok: false, code: "revision_conflict" };
    const candidate = parseStoredSettings({
      ...current.settings,
      ...request.changes,
    });
    const changedKeys = Object.keys(request.changes).filter(
      (key) =>
        JSON.stringify(candidate[key as keyof StoredSettings]) !==
        JSON.stringify(current.settings[key as keyof StoredSettings]),
    );
    if (
      changedKeys.some((key) => airtableKeys.includes(key)) &&
      !request.acknowledgeAirtableChange
    )
      return { ok: false, code: "confirmation_required" };
    const result = await validate(current.settings, candidate, changedKeys);
    if (!result.ok) return result;
    const updated = await compareAndSetSettings(
      db,
      request.expectedRevision,
      candidate,
      now,
    );
    return updated
      ? { ok: true, value: updated }
      : { ok: false, code: "revision_conflict" };
  } catch {
    return { ok: false, code: "settings_unavailable" };
  }
}
