export async function recordUsage(
  db: D1Database,
  metricName: string,
  value: number,
  metricDate: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO usage_metrics (metric_date, metric_name, metric_value, created_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(metric_date, metric_name)
       DO UPDATE SET metric_value = metric_value + excluded.metric_value`,
    )
    .bind(metricDate, metricName, value, new Date().toISOString())
    .run();
}

export async function getMonthlyUsage(
  db: D1Database,
  yearMonth: string,
): Promise<Record<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT metric_name, SUM(metric_value) AS total
       FROM usage_metrics
       WHERE metric_date LIKE ?1
       GROUP BY metric_name`,
    )
    .bind(`${yearMonth}-%`)
    .all<{ metric_name: string; total: number }>();

  return Object.fromEntries(results.map((row) => [row.metric_name, row.total]));
}

export async function getUsageTotal(
  db: D1Database,
  metricName: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(metric_value), 0) AS total
       FROM usage_metrics
       WHERE metric_name = ?1`,
    )
    .bind(metricName)
    .first<{ total: number }>();

  return row?.total ?? 0;
}
