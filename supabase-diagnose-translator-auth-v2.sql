-- 译员登录失败诊断 v2：检查 auth_user_id 指向是否真在 auth.users 里有对应账号
SELECT
  t.id AS translator_id,
  t.email AS t_email,
  t.name,
  t.auth_user_id AS t_auth_id,
  au.id AS au_uuid,
  au.email AS au_email,
  CASE
    WHEN au.id IS NULL THEN '❌ 孤儿 UUID（auth.users 里没这个账号）'
    WHEN LOWER(t.email) <> LOWER(au.email) THEN '⚠️ UUID 指向了别的邮箱（不是这个译员的账号）'
    ELSE '✅ 匹配（应该能登录）'
  END AS diagnosis
FROM translators t
LEFT JOIN auth.users au ON au.id = t.auth_user_id
WHERE t.id IN ('T377119', 'T918854', 'T446934')
ORDER BY t.id;

-- 第二步：如果上面是 ✅，再看 auth.users 里这三个邮箱的角色是不是 'translator'
SELECT
  au.id,
  au.email,
  au.raw_app_meta_data->>'role' AS app_role,
  au.raw_user_meta_data->>'role' AS user_role,
  au.email_confirmed_at IS NOT NULL AS email_confirmed,
  au.created_at
FROM auth.users au
WHERE au.email IN ('sandyyangyang@163.com', '610237573@qq.com', 'celeney@126.com')
ORDER BY au.email;