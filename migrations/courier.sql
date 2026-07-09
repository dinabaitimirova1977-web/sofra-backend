-- ─── ПРОФИЛЬ КУРЬЕРА ───────────────────────────────────────
CREATE TABLE courier_profiles (
  user_id            INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  is_online          BOOLEAN      DEFAULT false,
  total_deliveries   INT          DEFAULT 0,
  total_earned       NUMERIC(12,2) DEFAULT 0,
  vehicle_type       VARCHAR(50),  -- 'bike', 'scooter', 'car', 'foot'
  updated_at         TIMESTAMPTZ  DEFAULT NOW()
);

-- Добавляем поля в orders (если ещё не добавлены)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivery_fee    NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivered_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS proof_photo_url TEXT;

-- Индекс для аналитики курьера
CREATE INDEX IF NOT EXISTS idx_orders_courier_delivered
  ON orders(courier_id, delivered_at)
  WHERE status = 'delivered';

-- Триггер обновления updated_at для courier_profiles
CREATE TRIGGER trg_courier_profiles_updated
  BEFORE UPDATE ON courier_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
