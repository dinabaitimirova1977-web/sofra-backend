-- ─── ЛОГ ДЕЙСТВИЙ АДМИНА ──────────────────────────────────
CREATE TABLE admin_logs (
  id          SERIAL PRIMARY KEY,
  admin_id    INT NOT NULL REFERENCES users(id),
  action      VARCHAR(100) NOT NULL,  -- 'block_user', 'cancel_order', 'update_user' ...
  target_id   INT,
  target_type VARCHAR(50),            -- 'user', 'order', 'dish'
  reason      TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_admin_logs_admin  ON admin_logs(admin_id);
CREATE INDEX idx_admin_logs_action ON admin_logs(action);
CREATE INDEX idx_admin_logs_date   ON admin_logs(created_at DESC);
