import { expect, it } from 'vitest';
import { testEnv, createTestEnv } from '../helpers/env';
import { loadSettingsSnapshot } from '../../src/settings/runtime';
import { readImportContext, saveImportContextIfAbsent } from '../../src/db/execution-context-repository';

it('pins the first import context and cannot replace it with a later setting', async () => {
  const db = testEnv().DB;
  await db.prepare("INSERT INTO import_runs (id, source_album_id, trigger, status, started_at) VALUES (?, ?, 'line', 'running', ?)").bind('settings-context-run', 'settings-context-album', '2026-11-11').run();
  const settings = await loadSettingsSnapshot({ ...testEnv(), ...createTestEnv(), CONFIGURATION_MODE: 'legacy' });
  const first = { settings, replyGroupId: 'C1' };
  const later = { settings: { ...settings, config: { ...settings.config, airtableBaseId: 'another' } }, replyGroupId: 'C2' };
  expect(await readImportContext(db, 'settings-context-run')).toBeNull();
  expect(await saveImportContextIfAbsent(db, 'settings-context-run', first)).toEqual(first);
  expect(await saveImportContextIfAbsent(db, 'settings-context-run', later)).toEqual(first);
  expect(await readImportContext(db, 'settings-context-run')).toEqual(first);
});
