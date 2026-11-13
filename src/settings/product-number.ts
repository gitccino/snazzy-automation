import { nextProductNumberRequest } from "./schema";
import type { Env, Fetcher } from "../env";
import { readSettings } from "../db/settings-repository";
import { hasAirtableSequenceDrift } from "../routes/setup";
import { toRuntimeSettings } from "./runtime";
import type { SettingsResult } from "./schema";

export async function saveNextProductNumber(
  env: Env,
  input: unknown,
  fetcher: Fetcher = fetch.bind(globalThis),
): Promise<SettingsResult<{ nextProductNumber: number }>> {
  const parsed = nextProductNumberRequest.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_settings" };
  if (env.CONFIGURATION_MODE !== "d1") return { ok: false, code: "settings_unavailable" };
  const { expectedRevision, expectedNextValue, nextValue } = parsed.data;
  if (nextValue < expectedNextValue) return {
    ok: false, code: "invalid_settings",
    fieldErrors: { nextProductNumber: "The next number cannot move backward. Reload to see the current number." },
  };
  try {
    const record = await readSettings(env.DB);
    if (!record) return { ok: false, code: "settings_unavailable" };
    if (record.revision !== expectedRevision) return { ok: false, code: "revision_conflict" };
    try {
      if (await hasAirtableSequenceDrift(env, fetcher, nextValue,
        toRuntimeSettings(record.settings, env.PUBLIC_BASE_URL ?? ""))) return {
        ok: false, code: "invalid_settings",
        fieldErrors: { nextProductNumber: "Enter a number greater than every A- product number in Airtable." },
      };
    } catch { return { ok: false, code: "connection_validation_failed" }; }
    // A single guarded write prevents concurrent allocation or a base change from being overwritten.
    const row = await env.DB.prepare(`UPDATE sequences SET next_value = ?
      WHERE name = 'product_id' AND bootstrapped_at IS NOT NULL AND next_value = ? AND next_value <= ?
      AND EXISTS (SELECT 1 FROM app_settings WHERE id = 1 AND revision = ?)
      RETURNING next_value`).bind(nextValue, expectedNextValue, nextValue, expectedRevision).first<{ next_value: number }>();
    return row ? { ok: true, value: { nextProductNumber: row.next_value } }
      : { ok: false, code: "sequence_conflict" };
  } catch { return { ok: false, code: "settings_unavailable" }; }
}
