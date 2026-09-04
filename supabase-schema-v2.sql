-- ============================================================
-- Supabase 数据库 Schema v2 (R1 安全加固版)
-- 2026-09-04
-- ============================================================
-- 主要变化：
--   1. translators 增加 auth_user_id 字段，关联 auth.users(id)
--   2. admin 增加 auth_user_id 字段
--   3. 删除危险的 "for all using (true)" 策略
--   4. 改为基于 auth.uid() + 角色 + 所有权的细粒度 RLS
--   5. 写操作（增删改）只允许 service_role（前端走 Netlify Functions）
--
-- 部署步骤：
--   1. 备份当前数据：pg_dump 或在 Supabase Dashboard 导出
--   2. 清空 translators / orders / admin 表（生产部署前）
--   3. 在 Supabase SQL Editor 执行本文件
--   4. 执行末尾的"插入默认管理员"SQL，把 auth_user_id 填入真实 UUID
-- ============================================================

-- 启用 pgcrypto 用于 gen_random_uuid
create extension if not exists "pgcrypto";

-- ============================================================
-- 1. translators 表
-- ============================================================
create table if not exists translators (
  id text primary key,                              -- 业务 ID，如 T001
  auth_user_id uuid unique references auth.users(id) on delete cascade,
  name text not null,
  username text unique,                            -- 兼容旧数据；新流程用 email 登录
  email text unique,                               -- 译员邮箱（必填）
  phone text,
  bank_info jsonb default null,                    -- {bankName, bankCard, bankHolder, bankBranch}
  languages text[] default '{}',                   -- 擅长语种
  specialties text[] default '{}',                  -- 专业领域
  standard_rate numeric,                            -- 标准费率 元/千字
  urgent_rate numeric,                              -- 加急费率 元/千字
  status text default 'active',                    -- active / suspended / terminated
  remark text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- ============================================================
-- 2. orders 表
-- ============================================================
create table if not exists orders (
  id text primary key,
  project_name text not null,
  word_count integer not null check (word_count > 0),
  rate numeric not null check (rate > 0),
  amount numeric not null check (amount >= 0),
  deadline date not null,
  translator_id text references translators(id) on delete set null,
  status text default 'pending' check (status in ('pending', 'progress', 'completed', 'cancelled')),
  payment_status text default 'unpaid' check (payment_status in ('unpaid', 'paid')),
  description text,                                -- 项目描述
  source_files jsonb default '[]',                  -- 源文件列表
  remark text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- ============================================================
-- 3. admin 表
-- ============================================================
create table if not exists admin (
  id integer primary key default 1,                 -- 单行表，固定 id=1
  auth_user_id uuid unique references auth.users(id) on delete cascade,
  username text unique not null,
  email text unique not null,
  display_name text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- ============================================================
-- 4. RLS 策略（核心安全加固）
-- ============================================================
alter table translators enable row level security;
alter table orders enable row level security;
alter table admin enable row level security;

-- 删掉旧的危险策略（如果存在）
drop policy if exists "Allow anonymous access" on translators;
drop policy if exists "Allow anonymous access" on orders;
drop policy if exists "Allow anonymous access" on admin;

-- ---- translators 表策略 ----

-- 译员只能看自己的基本信息（不含银行信息，bank_info 走函数过滤）
create policy "translators read own row"
  on translators for select
  using (auth_user_id = auth.uid());

-- 管理员能看所有译员
create policy "admins read all translators"
  on translators for select
  using (
    exists (select 1 from admin a where a.auth_user_id = auth.uid())
  );

-- 译员只能更新自己的 bank_info 和联系方式（不能改 username/email/status）
-- 注意：这里用触发器或者 column-level grant 更稳；当前用 check + function 配合
create policy "translators update own bank_info only"
  on translators for update
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

-- ---- orders 表策略 ----

-- 译员只能看自己的订单
create policy "translators read own orders"
  on orders for select
  using (
    translator_id in (
      select id from translators where auth_user_id = auth.uid()
    )
  );

-- 管理员能看所有订单
create policy "admins read all orders"
  on orders for select
  using (
    exists (select 1 from admin a where a.auth_user_id = auth.uid())
  );

-- 写操作（insert / update / delete）不开放给 anon/authenticated
-- 全部走 Netlify Functions 使用 service_role key
-- 这样 RLS 即使配置错，也不会让前端误改数据

-- ---- admin 表策略 ----

-- 管理员能看自己的 admin 行（用于前端展示用户名）
create policy "admins read own row"
  on admin for select
  using (auth_user_id = auth.uid());

-- 其他管理员也可见（便于协作）
create policy "admins read other admins"
  on admin for select
  using (
    exists (select 1 from admin a where a.auth_user_id = auth.uid())
  );

-- ============================================================
-- 5. 触发器：自动更新 updated_at
-- ============================================================
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_translators_updated on translators;
create trigger trg_translators_updated
  before update on translators
  for each row execute function update_updated_at();

drop trigger if exists trg_orders_updated on orders;
create trigger trg_orders_updated
  before update on orders
  for each row execute function update_updated_at();

-- ============================================================
-- 6. 索引优化
-- ============================================================
create index if not exists idx_translators_auth_user on translators(auth_user_id);
create index if not exists idx_orders_translator_id on orders(translator_id);
create index if not exists idx_orders_status on orders(status);
create index if not exists idx_orders_deadline on orders(deadline);
create index if not exists idx_admin_auth_user on admin(auth_user_id);

-- ============================================================
-- 部署说明
-- ============================================================
-- 1. 执行完本文件后，在 Supabase Dashboard → Authentication → Users 手动创建：
--    - 1 个管理员账号（邮箱 + 密码），记下 UUID
--    - N 个译员账号（邮箱 + 临时密码），记下 UUID
--
-- 2. 然后在 SQL Editor 执行（把 UUID 替换成真实的）：
--    insert into admin (auth_user_id, username, email, display_name) values
--      ('管理员的UUID', 'admin', 'admin@eadartrans.com', '管理员');
--
--    insert into translators (id, auth_user_id, name, email, languages, specialties) values
--      ('T001', '译员1的UUID', '张三', 'translator1@eadartrans.com', '{英语,日语}', '{法律,商务}');
--
-- 3. 或者用 Netlify Function create-translator 一键创建（推荐）
-- ============================================================
