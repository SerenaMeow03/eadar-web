-- V11: orders 表加 batch_id 字段（批量导入追溯）
-- 需求：admin 批量导入 N 个订单时，全部带同一个 batch_id，便于：
--   1) 查询/追溯"这批订单是哪次 Excel 导入的"
--   2) save-order.js 检测到 batch_id 时跳过单条派单邮件（C2 trigger），由新链路 send-batch-import-email 按译员聚合发汇总邮件
--   3) 译员反馈"我这批没收到通知"时可按 batch_id 反查
--
-- 设计：
--   - batch_id 为 UUID 字符串（如 'import-20260921-abc123'），批量导入时前端生成、每条都带上
--   - 单条创建订单不传，batch_id = NULL（保持已有 C2 单条派单邮件链路）
--   - NULL 索引：CREATE INDEX 用 NULLS FIRST / WHERE batch_id IS NOT NULL 限定（小数据量全索引也可）
--
-- 不需要回填老数据，老订单 batch_id 全为 NULL

ALTER TABLE orders ADD COLUMN IF NOT EXISTS batch_id VARCHAR(64) DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_batch_id ON orders(batch_id) WHERE batch_id IS NOT NULL;

COMMENT ON COLUMN orders.batch_id IS '批量导入批次 ID（UUID 字符串）。带 batch_id 的订单由 send-batch-import-email 统一按译员发汇总通知，跳过单条派单邮件';