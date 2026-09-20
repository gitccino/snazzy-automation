CREATE TABLE usage_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_date TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  metric_value INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(metric_date, metric_name)
);

CREATE INDEX idx_usage_metrics_date ON usage_metrics(metric_date);
CREATE INDEX idx_usage_metrics_name ON usage_metrics(metric_name);
