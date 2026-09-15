-- ============================================================
-- 谊达翻译 一键迁移脚本（R2 客户系统 + 审计/通知）
-- 2026-09-15
-- ============================================================
-- 合并 v3 (clients) + v4 (payments) + v5 (audit) + v6 (notifications)
-- 全部 DDL 都是 idempotent（IF NOT EXISTS / drop if exists），可重复执行
--
-- 用法：
--   1. 打开 https://supabase.com/dashboard/project/zyawwjxjdloubvcnyvtp/sql
--   2. New query → 粘贴本文件全部内容 → Run
--   3. 等执行成功（无报错即 OK，warning 可忽略）
--
-- 验证：
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema='public'
--      AND table_name IN ('clients','audit_logs','notification_preferences');
--   应返回 3 行
-- ============================================================


-- ============================================================
-- v3: clients 表 + orders 加客户字段 + RLS
-- ============================================================
-- 1. clients 表
create table if not exists clients (
  id uuid default gen_random_uuid() primary key,
  user_id uuid unique references auth.users(id) on delete cascade,
  company_name text,
  contact_name text not null,
  email text not null unique,
  phone text,
  status text default 'active' check (status in ('active', 'archived')),
  remark text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 2. orders 表加客户字段
alter table orders
  add column if not exists client_id uuid references clients(id) on delete set null,
  add column if not exists client_rate numeric(10,2) check (client_rate is null or client_rate > 0),
  add column if not exists client_amount numeric(10,2) check (client_amount is null or client_amount >= 0);

-- 3. RLS：clients 表
alter table clients enable row level security;

drop policy if exists "clients read own row" on clients;
drop policy if exists "admins read all clients" on clients;

create policy "clients read own row"
  on clients for select
  using (user_id = auth.uid());

create policy "admins read all clients"
  on clients for select
  using (
    exists (
      select 1 from auth.users 
      where id = auth.uid() 
      and raw_app_meta_data->>'role' = 'admin'
    )
  );

-- 4. RLS：orders 表新增客户策略
drop policy if exists "clients read own orders" on orders;

create policy "clients read own orders"
  on orders for select
  using (
    client_id in (
      select id from clients where user_id = auth.uid()
    )
  );

-- 5. updated_at 触发器
drop trigger if exists trg_clients_updated on clients;
create trigger trg_clients_updated
  before update on clients
  for each row execute function update_updated_at();

-- 6. 索引
create index if not exists idx_clients_user_id on clients(user_id);
create index if not exists idx_clients_email on clients(email);
create index if not exists idx_clients_status on clients(status);
create index if not exists idx_orders_client_id on orders(client_id);


-- ============================================================
-- v4: 重命名孤儿 settlement_status → client_payment_status
-- ============================================================
-- 注：如果 v4 已跑过（settlement_status 已重命名为 client_payment_status），
--    下行 rename 会报"列不存在"——直接忽略即可，去看 v5/v6 生效情况。

-- 重命名（如果还没重命名）
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'orders' and column_name = 'settlement_status'
  ) then
    alter table orders rename column settlement_status to client_payment_status;
  end if;
end $$;

-- 索引
create index if not exists idx_orders_client_payment_status on orders(client_payment_status);

-- GRANT service_role（避免 permission denied）
grant select, insert, update, delete on public.orders to service_role;
grant usage, update on all sequences in schema public to service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;


-- ============================================================
-- v5: audit_logs 表 + RLS + GRANT
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    user_email VARCHAR(255) NOT NULL,
    user_role VARCHAR(20) NOT NULL,
    action VARCHAR(50) NOT NULL,
    target_type VARCHAR(30) NOT NULL,
    target_id VARCHAR(100),
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs (user_email, created_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own audit logs" ON audit_logs;
CREATE POLICY "Users read own audit logs" ON audit_logs
    FOR SELECT
    TO authenticated
    USING (user_email = (auth.jwt() ->> 'email'));

GRANT ALL PRIVILEGES ON TABLE audit_logs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO service_role;


-- ============================================================
-- v6: notification_preferences 表 + RLS + 默认偏好
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_preferences (
    id BIGSERIAL PRIMARY KEY,
    user_email VARCHAR(255) NOT NULL,
    preference_key VARCHAR(50) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_email, preference_key)
);

CREATE INDEX IF NOT EXISTS idx_notif_pref_user ON notification_preferences (user_email);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own preferences" ON notification_preferences;
CREATE POLICY "Users read own preferences" ON notification_preferences
    FOR SELECT
    TO authenticated
    USING (user_email = (auth.jwt() ->> 'email'));

DROP POLICY IF EXISTS "Users update own preferences" ON notification_preferences;
CREATE POLICY "Users update own preferences" ON notification_preferences
    FOR UPDATE
    TO authenticated
    USING (user_email = (auth.jwt() ->> 'email'))
    WITH CHECK (user_email = (auth.jwt() ->> 'email'));

GRANT ALL PRIVILEGES ON TABLE notification_preferences TO service_role;
GRANT USAGE, SELECT ON SEQUENCE notification_preferences_id_seq TO service_role;

-- 为所有现有用户写入默认偏好（全开）
INSERT INTO notification_preferences (user_email, preference_key, enabled)
SELECT u.email, pref.preference_key, true
FROM auth.users u
CROSS JOIN (
    VALUES
        ('order_assigned'),
        ('order_completed'),
        ('payment_received'),
        ('invoice_issued')
) AS pref(preference_key)
WHERE u.email IS NOT NULL
ON CONFLICT (user_email, preference_key) DO NOTHING;


-- ============================================================
-- 验证查询
-- ============================================================
-- 执行完后请单独跑一次这个查询确认 3 张表都建好：
--
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema='public'
--      AND table_name IN ('clients','audit_logs','notification_preferences');
--
-- 应返回 3 行。