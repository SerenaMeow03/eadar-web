-- V8: orders 表加 language_pair 字段
-- 需求：用户列出字段包含「语言对」，当前 schema 没有该字段
-- 设计：text，4 个预设值（中↔英/中↔日/中↔韩/英↔日），但允许自由输入做兜底
-- 应用层做 enum，前端 select

ALTER TABLE orders ADD COLUMN IF NOT EXISTS language_pair VARCHAR(32) DEFAULT NULL;

-- 索引：方便按语言对统计
CREATE INDEX IF NOT EXISTS idx_orders_language_pair ON orders(language_pair);

COMMENT ON COLUMN orders.language_pair IS '翻译语言对（如：中→英 / 中→日 / 中→韩 / 英→日）';