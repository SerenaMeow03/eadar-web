# R1 安全加固 + 统一登录 - 完成

## 做了什么

把 `E:\DY\eadar` 的翻译管理后台从"前端裸调 Supabase + RLS 全开"改成"前端 → Netlify Functions → Supabase（service_role）"的正规三层架构。

### 解决了什么

| 问题 | 修复 |
|------|------|
| RLS 全开，任何人可读 admin/translators/orders | 重写为基于 auth.uid() + 角色 + 所有权 |
| anon key 暴露在前端 HTML | service_role 移到 Netlify Functions 环境变量 |
| 管理员两条登录入口（Netlify Identity + Supabase） | 废弃 `/admin/index.html`，统一到 `/translator/admin/login.html` |
| `translators.id`（T001）和 `auth.users.id`（UUID）错配 | 加 `auth_user_id` 字段关联 |
| 改密码走明文 `translators.password` 字段，跟 Supabase Auth 不通 | 改用 Supabase Auth `updateUser` |
| `translator/admin/orders.html` 缺少 IIFE 闭合 bug | 修复 |
| `profile.html` 重复加载 supabase-js | 删除 |

### 交付文件

- **新 schema**：`supabase-schema-v2.sql`（旧版备份为 `supabase-schema-v1-backup.sql`）
- **后端 9 个 functions**（`netlify/functions/`）：
  - `_shared/{supabase,auth}.js` —— 共享模块
  - `get-orders / get-translators / get-translator-me` —— 查询
  - `save-order / delete-order` —— 订单增删改
  - `update-translator-bank / update-password` —— 译员/通用
  - 重写 `create-translator` —— 写入 auth_user_id 关联
- **前端 5 个 HTML 改造**：`orders.html / profile.html / admin/{dashboard,orders,translators}.html`
- **登录页修复**：`translator/login.html` 和 `translator/admin/login.html` 存 email 而非 username
- **废弃提示**：`admin/index.html` 改为废弃提示 + 重定向
- **工程文件**：`.gitignore` / `.env.example` / `netlify-env-setup.md` / `README-R1.md`

## 关键决策

1. **不绕 Supabase Auth**——Netlify Functions 就是后端，supabase.js 暴露 `getServiceClient`（后端用）和 `getUserClient`（受 RLS 约束）
2. **RLS 写操作不开放给前端**——所有 insert/update/delete 走 service_role，避免前端误改数据
3. **改密码用"旧密码再登一次"**——避免明文存密码字段，又不需要自己实现密码哈希

## 你需要做的事

按 `E:\DY\eadar\netlify-env-setup.md` 的清单：

1. Netlify 后台配 3 个环境变量（`SUPABASE_URL` / `SUPABASE_SERVICE_KEY_EADARTRANS` / `SUPABASE_ANON_KEY`）
2. Supabase SQL Editor 执行 `supabase-schema-v2.sql`（**先备份数据**）
3. Supabase Auth 创建 admin 账号，记下 UUID
4. SQL Editor 插入 admin 行
5. 用管理后台的"添加译员"功能创建测试译员
6. `git add . && git commit && git push`
7. 按 `README-R1.md` 验证清单挨个测试

## 遗留（不阻塞上线）

- `order-detail.html` 是死代码（写死 `ordersData` 字典）—— R2 修
- 删译员功能占位 —— R2 加 `delete-translator` function
- Decap CMS（`/admin/cms.html`）—— R3 决定保留或迁移
- 函数级单元测试 —— R2 加

## 怎么回滚

- Netlify：Deploys → 选上一个版本 → Publish
- Schema：手动 drop policy + 重建旧 `for all using (true)`
- 代码：`git revert HEAD && git push`
