-- v7: orders 表加 client_word_count 字段
-- 业务需求：客户字数与译员字数分开统计
-- - word_count：译员字数，用于 amount = word_count * rate / 1000
-- - client_word_count：客户字数，用于 client_amount = client_word_count * client_rate / 1000
-- 默认 NULL：保持历史数据兼容，NULL 时前端 fallback 到 word_count

-- 1. 加列
alter table orders
  add column if not exists client_word_count numeric default null;

-- 2. 历史数据回填（可选）：如果 client_id 不为空但 client_word_count 为 NULL，复制 word_count
-- 这样历史订单的客户金额不会变成 0
update orders
set client_word_count = word_count
where client_id is not null
  and client_word_count is null;

-- 3. 加索引（按客户字数查询场景少，加可选）
create index if not exists idx_orders_client_word_count
  on orders(client_word_count)
  where client_word_count is not null;

-- 4. GRANT（参考 v4 写法）
grant select, insert, update, delete on public.orders to service_role;

-- 5. 校验
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_name = 'orders' and column_name = 'client_word_count';