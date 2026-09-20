-- V10: orders 表加 accepted_at / submitted_at 字段
-- 需求：v8 副行展开里"接单日期/提交日期"用 updated_at 近似，admin 改其他字段会污染显示
-- 设计：状态机对应转换时单独写时间戳（pending→progress 写 accepted_at，→completed 写 submitted_at）
-- 方案 A：admin 强制改单也算时间戳，不区分是译员还是 admin 操作

ALTER TABLE orders ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP DEFAULT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMP DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_accepted_at ON orders(accepted_at);
CREATE INDEX IF NOT EXISTS idx_orders_submitted_at ON orders(submitted_at);

COMMENT ON COLUMN orders.accepted_at IS '接单时间（pending→progress 时写入，不受 admin 改其他字段影响）';
COMMENT ON COLUMN orders.submitted_at IS '提交时间（→completed 时写入，不受 admin 改其他字段影响）';

-- 历史数据回填（已知不精确：admin 改其他字段刷新的 updated_at 也算在这里，但比 NULL 好）
UPDATE orders SET accepted_at = updated_at WHERE status IN ('progress','completed') AND accepted_at IS NULL;
UPDATE orders SET submitted_at = updated_at WHERE status = 'completed' AND submitted_at IS NULL;