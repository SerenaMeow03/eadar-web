-- 译员登录失败排查 + 一键修复（Supabase Studio → SQL Editor）
-- 适用：登录报"译员业务记录不存在"，但 auth 登录本身成功的情况

-- 第 1 步：查看所有译员的 auth_user_id 匹配情况
SELECT
  t.id,
  t.email,
  t.name,
  t.status,
  CASE
    WHEN t.auth_user_id IS NULL THEN '❌ 译员行 auth_user_id 为空'
    WHEN au.id IS NULL THEN '❌ auth_user_id 指向的 UUID 不存在（孤儿）'
    ELSE '✅ 匹配'
  END AS diagnosis,
  t.auth_user_id AS t_auth_id,
  au.id AS au_uuid,
  au.email AS au_email
FROM translators t
LEFT JOIN auth.users au ON au.id = t.auth_user_id
ORDER BY t.created_at DESC;

-- 第 2 步：如果有"❌ 译员行 auth_user_id 为空"，用下方 UPDATE 修复（每个空行一次）
-- ⚠️ 修复前先看第 1 步结果，确认 au_uuid 列的 UUID 来自 auth.users 中对应的 email
-- 假设 610237573@qq.com 是 T446934，复制第 1 步中该行的 au_uuid 值替换下面 <UUID>：

-- UPDATE translators
-- SET auth_user_id = '<UUID-粘贴这里>'
-- WHERE id = 'T446934' AND auth_user_id IS NULL;

-- 第 3 步：批量回填（更安全——只回填 auth_user_id 为空的行）
-- UPDATE translators t
-- SET auth_user_id = au.id
-- FROM auth.users au
-- WHERE t.email = au.email
--   AND t.auth_user_id IS NULL;