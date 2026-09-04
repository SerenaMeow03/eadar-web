# R1 完成总结

## 已交付

### 1. 数据库（Supabase）
- `supabase-schema-v1-backup.sql` —— 旧 schema 备份
- `supabase-schema-v2.sql` —— 新 schema，含：
  - `translators` 表加 `auth_user_id` 关联 `auth.users`
  - `admin` 表加 `auth_user_id` 关联
  - **删掉危险的 `for all using (true)` 策略**
  - 改为基于 `auth.uid()` + role + 所有权的细粒度 RLS
  - 写操作（insert/update/delete）走 service_role key，不开放给前端
  - 触发器自动更新 `updated_at`
  - 索引优化

### 2. 后端（Netlify Functions）
- `_shared/supabase.js` —— 服务端 client 工厂（service_role + user-scoped）
- `_shared/auth.js` —— 通用鉴权（解析 JWT、校验 role、CORS、错误处理）
- `get-orders.js` —— 译员看自己 / 管理员看全部
- `get-translators.js` —— 仅管理员
- `get-translator-me.js` —— 当前用户自己的 profile
- `save-order.js` —— 管理员创建/更新订单（含校验）
- `delete-order.js` —— 管理员删除订单
- `update-translator-bank.js` —— 译员改银行信息
- `update-password.js` —— 改自己密码（统一走 Supabase Auth）
- `create-translator.js` —— 改写：创建 Auth 用户后写 `translators` 表关联

### 3. 前端
- `translator/orders.html` —— 改用 fetch API
- `translator/profile.html` —— 改用 fetch API + 修复密码 bug
- `translator/admin/dashboard.html` —— 改用 fetch API + 修复密码 bug
- `translator/admin/orders.html` —— 改用 fetch API（增删改查全部）
- `translator/admin/translators.html` —— 改用 fetch API
- `translator/admin/login.html` —— 登录后存 email（修旧 bug）
- `translator/login.html` —— 登录后存 email
- `admin/index.html` —— 标记为废弃，重定向到新入口
- `admin/confirmation.html` —— 链接修正

### 4. 工程
- `.gitignore` —— 加 `.env` 防护
- `.env.example` —— 占位符模板
- `netlify-env-setup.md` —— Netlify 部署清单

## 部署前必做

1. **Netlify 配置 3 个环境变量**（见 `netlify-env-setup.md`）：
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY_EADARTRANS`
   - `SUPABASE_ANON_KEY`

2. **Supabase 执行 schema**：
   - 备份数据（Supabase Dashboard → Database → Backups）
   - SQL Editor 执行 `supabase-schema-v2.sql`
   - **数据清空：旧 T001/T002/T003 译员和 orders 测试数据会被新 RLS 限制**——执行前清空 `translators` 和 `orders` 表

3. **创建管理员账号**：
   - Supabase Dashboard → Authentication → Users → Add user
   - 邮箱：`admin@eadartrans.com`（或你喜欢的）
   - 密码：你的管理员密码
   - **记下 UUID**
   - 改 Auth 用户的 `app_metadata.role` 为 `admin`（在 SQL Editor 执行）：
     ```sql
     update auth.users
     set raw_app_meta_data = raw_app_meta_data || '{"role": "admin"}'::jsonb
     where email = 'admin@eadartrans.com';
     ```
   - 在 SQL Editor 插入 admin 行：
     ```sql
     insert into admin (auth_user_id, username, email, display_name)
     values ('上一步的UUID', 'admin', 'admin@eadartrans.com', '管理员');
     ```

4. **创建测试译员**：
   - 在管理后台 `/translator/admin/login.html` 登录
   - 进入"译员管理" → "添加译员"
   - 填邮箱、临时密码、姓名、语种
   - 创建后会自动发邮件（如果配了 SMTP），否则把账号信息手动发给译员

5. **git push**：
   ```bash
   cd E:\DY\eadar
   git add .
   git commit -m "R1: RLS 加固 + 统一登录入口 + 密钥移到后端"
   git push
   ```
   Netlify 自动部署，约 1-2 分钟。

## 验证清单

部署完成后挨个测试：

- [ ] `https://eadar-web.netlify.app/.netlify/functions/get-orders` 返回 **401**（不是 500）
- [ ] `/translator/admin/login.html` 用 admin 账号能登入
- [ ] 管理员看 dashboard：能看译员数和订单统计
- [ ] 管理员看订单管理：能增删改查
- [ ] 管理员看译员管理：能看列表、创建新译员
- [ ] 译员账号能登录 `/translator/login.html`
- [ ] 译员看自己的订单：只能看自己的（**测试方法**：用译员 A 账号登，看不到译员 B 的订单）
- [ ] 译员改银行信息：保存后能 reload 看到
- [ ] 译员改密码：旧密码正确能改成新密码
- [ ] 管理员改密码：同上

## 已知遗留（R2/R3 处理）

1. **`order-detail.html` 是死代码** —— 第 380 行有写死的 `ordersData` 字典，没接 Supabase。R2 改成动态加载。
2. **删除译员功能未实现** —— R1 translators.html 删按钮只是占位。需要 R2 加 `delete-translator.js` function。
3. **CMS (Decap/Netlify Identity) 死路** —— `admin/cms.html` 还在用 Netlify Identity。R3 决定要不要保留（用于编辑 news 文章）还是迁移。
4. **生产环境 RLS 风险**：所有写操作都靠 service_role 在后端做。如果 functions 写错，**可能误改数据**。R2 加函数级单元测试。
5. **密码验证改成了"用旧密码再登一次"**——增加了一次登录调用，但避免了明文存密码字段。

## 回滚方案

如果 R1 上线出问题：

1. **回滚 Netlify 部署**：Netlify 后台 → Deploys → 选上一个版本 → "Publish deploy"
2. **回滚 schema**：
   ```sql
   -- 删 RLS 重建
   drop policy "translators read own row" on translators;
   drop policy "admins read all translators" on translators;
   -- ...（其他策略）
   -- 改回原来的 for all using (true)
   create policy "Allow anonymous access" on translators for all using (true);
   -- 同理 orders 和 admin
   ```
3. **回滚代码**：`git revert HEAD && git push`
