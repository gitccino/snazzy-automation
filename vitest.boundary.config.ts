import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
export default defineConfig({plugins:[cloudflareTest(async () => ({wrangler:{configPath:'test/runtime-fixture/wrangler.jsonc'},miniflare:{bindings:{TEST_MIGRATIONS:await readD1Migrations(path.resolve('migrations'))}}}))],test:{include:['test/runtime-fixture/boundary.test.ts'],setupFiles:['./test/apply-migrations.ts']}});
