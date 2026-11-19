import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { testEnv } from "../helpers/env";

it("preserves regeneration bindings while allowing create bindings", async () => {
  const db = testEnv().DB;
  const migrations = (env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS;
  const rename = (sql: string) => sql.replaceAll("publication_regeneration_events", "fixture_publication_events").replaceAll("publication_events_new", "fixture_publication_events_new");
  for (const name of ["0016_publication_regeneration_events.sql", "0017_publication_handoff.sql"]) {
    await db.batch(migrations.find(m => m.name === name)!.queries.map(sql => db.prepare(rename(sql))));
  }
  try {
    await db.prepare("INSERT INTO fixture_publication_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind("old", "run", 2, 1, "workflow", "regenerate", "{}", "regenerating").run();
    await db.batch(migrations.find(m => m.name === "0018_publication_create_events.sql")!.queries.map(sql => db.prepare(rename(sql))));
    expect(await db.prepare("SELECT * FROM fixture_publication_events WHERE event_id = 'old'").first()).toMatchObject({ action: "regenerate", handoff_status: "regenerating", workflow_id: "workflow" });
    await db.prepare("INSERT INTO fixture_publication_events (event_id, publication_run_id, generation, notification_cycle, workflow_id, action, job_json) VALUES ('new', 'run', 1, 1, 'workflow', 'create', '{}')").run();
    await expect(db.prepare("INSERT INTO fixture_publication_events (event_id, publication_run_id, generation, notification_cycle, workflow_id, action, job_json) VALUES ('bad', 'run', 1, 1, 'workflow', 'other', '{}')").run()).rejects.toThrow();
    await expect(db.prepare("INSERT INTO fixture_publication_events (event_id, publication_run_id, generation, notification_cycle, workflow_id, action, job_json) VALUES ('old', 'run', 1, 1, 'workflow', 'create', '{}')").run()).rejects.toThrow();
  } finally {
    await db.exec("DROP TABLE IF EXISTS fixture_publication_events");
  }
});
