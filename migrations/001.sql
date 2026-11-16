CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, revision INTEGER NOT NULL,
 phase TEXT NOT NULL, document TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_owner_date ON jobs(owner_id, created_at DESC);
CREATE TABLE IF NOT EXISTS transcripts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), parent_id TEXT REFERENCES versions(id), document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operations (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), type TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','running','waiting_provider','succeeded','failed','cancelled')),
 idempotency_key TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
 lease_owner TEXT, lease_until INTEGER, cancel_requested_at INTEGER,
 attempt INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, document TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS operations_pending ON operations(state,lease_until,created_at);
CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), version_id TEXT NOT NULL REFERENCES versions(id), output_asset_id TEXT NOT NULL REFERENCES assets(id), document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS uploads (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), owner_id TEXT NOT NULL,
 lease_hash TEXT NOT NULL, expected_bytes INTEGER NOT NULL, part_size INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('uploading','completing','completed','cancelled')),
 expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, file_name TEXT NOT NULL, mime TEXT NOT NULL, asset_id TEXT REFERENCES assets(id)
);
CREATE TABLE IF NOT EXISTS upload_parts (
 upload_id TEXT NOT NULL REFERENCES uploads(id), part_no INTEGER NOT NULL, bytes INTEGER NOT NULL, checksum TEXT NOT NULL,
 PRIMARY KEY(upload_id,part_no)
);
CREATE TABLE IF NOT EXISTS usage_events (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), operation_id TEXT NOT NULL REFERENCES operations(id),
 provider_request_id TEXT NOT NULL, document TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_job ON usage_events(job_id);
CREATE TABLE IF NOT EXISTS outbox (
 id TEXT PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL REFERENCES jobs(id), operation_id TEXT NOT NULL REFERENCES operations(id),
 state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 payload TEXT NOT NULL, telegram_message_id TEXT, next_attempt_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS telegram_updates (update_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS worker_heartbeat (id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
