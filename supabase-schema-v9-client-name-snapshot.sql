-- V9: orders 表加 client_name_snapshot 字段
-- 需求：客户被删除后，订单仍能追溯到原客户名（之前只能看到 UUID 前 8 位）
-- 设计：写订单时从 clients 表 snapshot 客户名到 orders 表
-- 老订单 client_name_snapshot = NULL（已知丢失无法回填），保持现状

ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_name_snapshot VARCHAR(200) DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_client_name_snapshot ON orders(client_name_snapshot);

COMMENT ON COLUMN orders.client_name_snapshot IS '下单时客户名快照（company_name 优先，否则 contact_name）。客户被删除后订单仍可追溯';