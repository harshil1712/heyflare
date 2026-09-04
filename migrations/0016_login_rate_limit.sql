-- Password login rate limits (keyed by IP and by email).
CREATE TABLE login_rate_limits (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
