# Netlify 环境变量配置指南

R1 部署前必须配置以下环境变量，否则 Netlify Functions 会全部返回 500 错误。

## 在 Netlify 配置

1. 登录 https://app.netlify.com/
2. 选中站点 `eadar-web`
3. **Site settings** → **Environment variables** → **Add a variable**
4. 添加以下 3 个变量：

| 变量名 | 值 | 用途 |
|--------|-----|------|
| `SUPABASE_URL` | `https://zyawwjxjdloubvcnyvtp.supabase.co` | Supabase 项目 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role 密钥（从 Supabase Dashboard 复制）| 后端 service client 用，**绝不能进前端** |
| `SUPABASE_ANON_KEY` | anon 密钥（从 Supabase Dashboard 复制） | 前端登录用 |

## 在哪里取密钥

- Supabase Dashboard：https://supabase.com/dashboard/project/zyawwjxjdloubvcnyvtp/settings/api
- **service_role** 那行点 `Reveal` 后复制（**保密！**）
- **anon / public** 那行直接复制（公开，安全）

## 本地开发

在项目根目录 `E:\DY\eadar` 下创建 `.env` 文件（注意是点开头，无扩展名）：

```
SUPABASE_URL=https://zyawwjxjdloubvcnyvtp.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
SUPABASE_ANON_KEY=your-anon-key-here
```

> 说明：上面是占位符示例，真实密钥在你本地 `.env` 文件里。
> ⚠️ 占位符里不用 `eyJhbGciOi...`，避免 Netlify secret scanner 误判为 JWT 密钥。

`.env` 已在 `.gitignore` 中，绝不会被提交到 Git。

## 验证

部署完成后访问：

```
https://eadar-web.netlify.app/.netlify/functions/get-orders
```

应该返回 401 Unauthorized（因为没带 token），**不是 500**。如果是 500，说明环境变量没配对。

## 部署清单

- [ ] Netlify 配置 3 个环境变量
- [ ] 本地创建 .env 文件
- [ ] Supabase SQL Editor 执行 `supabase-schema-v2.sql`（**生产部署前先备份数据**）
- [ ] 在 Supabase Auth 创建管理员账号
- [ ] 在 Supabase SQL Editor 插入 admin 行，关联 auth_user_id
- [ ] 验证 `/portal/admin/login.html` 能登录
- [ ] 验证 `/.netlify/functions/get-orders` 返回 401
- [ ] git push 触发自动部署
