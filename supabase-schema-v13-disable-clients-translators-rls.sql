-- V13: 关闭 clients / translators 表的 RLS
-- 背景：
--   V12 SQL 启用 RLS 后，译员/客户登录报"业务记录不存在"，但 admin 登录 OK
--   根因排查中（service_role 应默认 bypass，但现象是 bypass 没生效——可能是项目里某个 GRANT/REVOKE 或 FORCE RLS 设置干扰）
--   当前架构是 BFF（前端 → Netlify Function → service_role），所有权限在函数层实现（authenticate + role 校验 + .eq 过滤）
--   RLS 在这个架构下不是必须的，关掉是最稳的兜底
--
-- 未来若需要前端直连 Supabase（PostgREST / supabase-js from 浏览器），再启用 RLS 并配 policy
--
-- 注：service_role 默认不需显式 GRANT——Postgres 中 service_role 是 superuser-like，已 bypass RLS

-- 1) 关闭 RLS
ALTER TABLE public.clients DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.translators DISABLE ROW LEVEL SECURITY;

-- 2) 顺手 DROP 残留 policy（V12 DROP 了，但保险起见再清一次）
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

-- 3) 验证
SELECT
  t.tablename,
  t.rowsecurity AS rls_enabled,
  COALESCE(p.pg_count, 0) AS policy_count
FROM pg_tables t
LEFT JOIN (
  SELECT tablename, COUNT(*) AS pg_count
  FROM pg_policies
  WHERE schemaname = 'public'
  GROUP BY tablename
) p ON p.tablename = t.tablename
WHERE t.schemaname = 'public'
  AND t.tablename IN ('clients', 'translators');
-- 期望：
--   clients    | false | 0
--   translators | false | 0