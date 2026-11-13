import { describe, expect, it } from 'vitest';
import { testEnv, createTestEnv } from '../helpers/env';
import { handleSettingsBootstrap } from '../../src/routes/settings-bootstrap';
import { readSettings } from '../../src/db/settings-repository';

describe('settings bootstrap', () => {
  it('requires the admin token and seeds exactly once from effective legacy settings without secrets', async () => {
    const env = { ...testEnv(), ...createTestEnv(), WORKFLOW_RETRY_LIMIT: '0' };
    await env.DB.prepare('DELETE FROM app_settings').run();
    const request = (token: string) => new Request('https://example.test/setup/settings-bootstrap', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect((await handleSettingsBootstrap(request('wrong'), env)).status).toBe(401);
    expect(await readSettings(env.DB)).toBeNull();
    const response = await handleSettingsBootstrap(request(env.ADMIN_ROUTE_TOKEN), env);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(env.GOOGLE_REFRESH_TOKEN);
    expect(JSON.parse(body).publicBaseUrl).toBe('https://example.workers.dev');
    const saved = await readSettings(env.DB);
    expect(saved?.settings).toMatchObject({ LINE_ALLOWED_GROUP_IDS: ['CtestGroup'], IMPORT_RETRY_LIMIT: 0, PUBLICATION_RETRY_LIMIT: 0, AIRTABLE_BASE_ID: 'appTest' });
    const changed = { ...env, APP_CONFIG_JSON: env.APP_CONFIG_JSON.replace('appTest', 'anotherBase') };
    expect((await handleSettingsBootstrap(request(env.ADMIN_ROUTE_TOKEN), changed)).status).toBe(200);
    expect(await readSettings(env.DB)).toEqual(saved);
  });
  it('leaves the database empty when legacy settings are invalid', async () => {
    const env = { ...testEnv(), ...createTestEnv({ APP_CONFIG_JSON: '{}' }) };
    await env.DB.prepare('DELETE FROM app_settings').run();
    const response = await handleSettingsBootstrap(new Request('https://example.test/setup/settings-bootstrap', { method: 'POST', headers: { authorization: `Bearer ${env.ADMIN_ROUTE_TOKEN}` } }), env);
    expect(response.status).toBe(503);
    expect(await readSettings(env.DB)).toBeNull();
  });
});
