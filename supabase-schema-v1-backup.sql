-- Supabase 数据库表结构

-- 译员表
create table translators (
  id text primary key,
  name text not null,
  username text unique not null,
  password text not null,
  bank_info jsonb default null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 订单表
create table orders (
  id text primary key,
  project_name text not null,
  word_count integer not null,
  rate numeric not null,
  amount numeric not null,
  deadline date not null,
  translator_id text references translators(id),
  status text default 'pending',
  payment_status text default 'unpaid',
  remark text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 管理员表
create table admin (
  id integer primary key default 1,
  username text not null,
  password text not null
);

-- 插入默认数据
insert into admin (username, password) values ('admin', '123456');

-- 插入默认译员
insert into translators (id, name, username, password) values
('T001', '张三', 'translator1', '123456'),
('T002', '李四', 'translator2', '123456'),
('T003', '王五', 'translator3', '123456');

-- 设置 RLS (Row Level Security) 策略
alter table translators enable row level security;
alter table orders enable row level security;
alter table admin enable row level security;

-- 允许匿名访问 (简化版，生产环境应该使用认证)
create policy "Allow anonymous access" on translators for all using (true);
create policy "Allow anonymous access" on orders for all using (true);
create policy "Allow anonymous access" on admin for all using (true);
