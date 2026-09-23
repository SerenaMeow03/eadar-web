-- V12: clients / translators 表启用 RLS + 清掉旧 policy
-- 设计：所有 CRUD 走 Netlify Functions（service_role bypass RLS），前端永不直查这两张表
-- RLS 开 = 消除 Supabase Linter 警告 + 防御性深度（前端若意外直查，policy 兜底 deny）
--
-- service_role bypass 不变 → 后端所有 Netlify Function（get-/create-/update-/delete-/register-/login-*）照常工作

-- 1) 启用 RLS
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE translators ENABLE ROW LEVEL SECURITY;

-- 2) DROP 全部遗留 policy（不依赖具体名字，循环 DROP 防止漏掉）
DO $$
DECLARE
    pol record;
BEGIN
    FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'clients' LOOP
        EXECUTE format('DROP POLICY %I ON public.clients', pol.policyname);
    END LOOP;
    FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'translators' LOOP
        EXECUTE format('DROP POLICY %I ON public.translators', pol.policyname);
    END LOOP;
END $$;

-- 验证
SELECT 'clients' AS table_name, COUNT(*) AS policy_count FROM pg_policies WHERE schemaname = 'public' AND tablename = 'clients'
UNION ALL
SELECT 'translators', COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'translators';
-- 期望：两个 COUNT 都是 0
