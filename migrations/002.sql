CREATE TABLE IF NOT EXISTS telegram_replies (
 update_id TEXT PRIMARY KEY REFERENCES telegram_updates(update_id),
 payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0
);
