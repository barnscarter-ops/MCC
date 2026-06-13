-- metrics table: one row per node, upserted every 5s by prometheus-sync
create table if not exists metrics (
  node_id   text primary key,
  values    jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- realtime
alter publication supabase_realtime add table metrics;
