-- ============================================================
-- Sofra Database Schema
-- ============================================================

-- Расширения
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";  -- для геолокации

-- ─── ПОЛЬЗОВАТЕЛИ ──────────────────────────────────────────
CREATE TYPE user_role AS ENUM ('client', 'cook', 'courier', 'admin');

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  phone         VARCHAR(20)  UNIQUE NOT NULL,
  name          VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          user_role    NOT NULL DEFAULT 'client',
  avatar_url    TEXT,
  rating        NUMERIC(3,2) DEFAULT 0,
  is_active     BOOLEAN      DEFAULT true,
  fcm_token     TEXT,          -- Firebase push token
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

-- ─── ПРОФИЛЬ ПОВАРА ────────────────────────────────────────
CREATE TABLE cook_profiles (
  user_id       INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bio           TEXT,
  speciality    VARCHAR(200),
  is_online     BOOLEAN     DEFAULT false,
  work_start    TIME        DEFAULT '08:00',
  work_end      TIME        DEFAULT '20:00',
  total_orders  INT         DEFAULT 0,
  total_earned  NUMERIC(12,2) DEFAULT 0
);

-- ─── БЛЮДА ─────────────────────────────────────────────────
CREATE TABLE dishes (
  id                 SERIAL PRIMARY KEY,
  cook_id            INT     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               VARCHAR(200) NOT NULL,
  description        TEXT,
  price              NUMERIC(10,2) NOT NULL,
  category           VARCHAR(100),
  cook_time_minutes  INT     DEFAULT 30,
  image_url          TEXT,
  is_available       BOOLEAN DEFAULT true,
  total_ordered      INT     DEFAULT 0,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_dishes_cook ON dishes(cook_id);
CREATE INDEX idx_dishes_category ON dishes(category);

-- ─── ЗАКАЗЫ ────────────────────────────────────────────────
CREATE TYPE order_status AS ENUM (
  'pending',    -- ожидает подтверждения повара
  'confirmed',  -- повар принял
  'cooking',    -- готовится
  'ready',      -- готово, ждёт курьера
  'picked_up',  -- курьер забрал
  'delivered',  -- доставлено
  'cancelled'   -- отменён
);

CREATE TABLE orders (
  id               SERIAL PRIMARY KEY,
  client_id        INT NOT NULL REFERENCES users(id),
  cook_id          INT NOT NULL REFERENCES users(id),
  courier_id       INT REFERENCES users(id),
  status           order_status NOT NULL DEFAULT 'pending',
  total_price      NUMERIC(10,2) NOT NULL,
  delivery_address TEXT NOT NULL,
  delivery_lat     NUMERIC(10,8),
  delivery_lng     NUMERIC(11,8),
  comment          TEXT,
  rating           SMALLINT CHECK (rating BETWEEN 1 AND 5),
  rating_comment   TEXT,
  estimated_time   INT,   -- минуты
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_orders_client  ON orders(client_id);
CREATE INDEX idx_orders_cook    ON orders(cook_id);
CREATE INDEX idx_orders_courier ON orders(courier_id);
CREATE INDEX idx_orders_status  ON orders(status);

-- ─── ПОЗИЦИИ ЗАКАЗА ────────────────────────────────────────
CREATE TABLE order_items (
  id             SERIAL PRIMARY KEY,
  order_id       INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  dish_id        INT NOT NULL REFERENCES dishes(id),
  quantity       INT NOT NULL DEFAULT 1,
  price_at_order NUMERIC(10,2) NOT NULL
);

CREATE INDEX idx_order_items_order ON order_items(order_id);

-- ─── АДРЕСА КЛИЕНТОВ ───────────────────────────────────────
CREATE TABLE client_addresses (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label      VARCHAR(100),  -- "Дом", "Работа"
  address    TEXT NOT NULL,
  lat        NUMERIC(10,8),
  lng        NUMERIC(11,8),
  is_default BOOLEAN DEFAULT false
);

-- ─── ТРЕКИНГ КУРЬЕРА ───────────────────────────────────────
CREATE TABLE courier_locations (
  courier_id  INT PRIMARY KEY REFERENCES users(id),
  lat         NUMERIC(10,8),
  lng         NUMERIC(11,8),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── УВЕДОМЛЕНИЯ ───────────────────────────────────────────
CREATE TABLE notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      VARCHAR(200),
  body       TEXT,
  type       VARCHAR(50),
  is_read    BOOLEAN DEFAULT false,
  data       JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notif_user ON notifications(user_id, is_read);

-- ─── АВТООБНОВЛЕНИЕ updated_at ─────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated    BEFORE UPDATE ON users    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_dishes_updated   BEFORE UPDATE ON dishes   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_orders_updated   BEFORE UPDATE ON orders   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
