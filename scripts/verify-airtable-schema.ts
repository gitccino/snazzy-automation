import { z } from "zod";

const SetupReportSchema = z.object({
  ok: z.boolean(),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })),
});

async function main(): Promise<void> {
  const baseUrl = process.env.WORKER_BASE_URL;
  const token = process.env.ADMIN_ROUTE_TOKEN;
  if (!baseUrl || !token) throw new Error("Set WORKER_BASE_URL and ADMIN_ROUTE_TOKEN");
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/setup`, { headers: { authorization: `Bearer ${token}` } });
  const report = SetupReportSchema.parse(await response.json());
  for (const check of report.checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  if (!response.ok || !report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
