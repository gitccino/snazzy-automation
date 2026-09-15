import { applyD1Migrations, env } from "cloudflare:test";
import type { Env } from "../src/env";

const bindings = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
