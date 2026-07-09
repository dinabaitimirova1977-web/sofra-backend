-- ─── ПЛАТЕЖИ ──────────────────────────────────────────────
CREATE TYPE payment_status AS ENUM (
  'pending', 'paid', 'failed', 'expired', 'refunded'
);

CREATE TYPE payment_provider AS ENUM ('kaspi', 'halyk');

CREATE TABLE payments (
  id           SERIAL PRIMARY KEY,
  order_id     INT NOT NULL REFERENCES orders(id),
  provider     payment_provider NOT NULL,
  provider_id  VARCHAR(200),       -- ID платежа у провайдера
  invoice_id   VARCHAR(200),       -- invoice/order ID у провайдера
  amount       NUMERIC(12,2) NOT NULL,
  currency     VARCHAR(3) DEFAULT 'KZT',
  status       payment_status DEFAULT 'pending',
  payment_url  TEXT,               -- ссылка для оплаты
  qr_code      TEXT,               -- base64 QR (Kaspi)
  raw_response JSONB,              -- сырой ответ провайдера
  paid_at      TIMESTAMPTZ,
  refunded_at  TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_payments_order    ON payments(order_id);
CREATE INDEX idx_payments_provider ON payments(provider, provider_id);
CREATE INDEX idx_payments_status   ON payments(status);

-- Добавляем поле payment_method в orders
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_method  VARCHAR(20) DEFAULT 'cash',
  ADD COLUMN IF NOT EXISTS payment_status  VARCHAR(20) DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS payment_id      INT REFERENCES payments(id);

CREATE TRIGGER trg_payments_updated
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
