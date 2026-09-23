// netlify/functions/rebind-translator-auth.js
// 重新绑定译员的 auth_user_id：用于早期手动插入的 translators 行
// 该行 auth_user_id 为 NULL，导致登录时被 _shared/login.js 判定"译员业务记录不存在"
//
// 流程：
//   1. 接收 translatorId（如 T446934）
//   2. 查 translators 行 email
//   3. 用 service_role admin.listUsers() 查 auth.users 取该邮箱的 auth user.id
//   4. UPDATE translators.auth_user_id
//   5. 写审计日志

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate, requireMethod, parseBody } = require('./_shared/auth');
const { writeAudit } = require('./_shared/audit');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const methodErr = requireMethod(event, 'POST');
  if (methodErr) return methodErr;

  const auth = await authenticate(event, 'admin');
  if (auth.error) return auth.error;
  const admin = auth.user;

  const body = parseBody(event);
  if (!body || !body.translatorId) {
    return corsResponse(400, { error: 'translatorId 必填' });
  }
  const translatorId = String(body.translatorId).trim();

  const service = getServiceClient();

  try {
    // 1. 查 translators 行
    const { data: t, error: tErr } = await service
      .from('translators')
      .select('id, email, name, auth_user_id, status')
      .eq('id', translatorId)
      .maybeSingle();

    if (tErr) {
      return corsResponse(500, { error: '查询译员失败：' + tErr.message });
    }
    if (!t) {
      return corsResponse(404, { error: `译员 ${translatorId} 不存在` });
    }
    if (t.auth_user_id) {
      return corsResponse(200, {
        data: {
          alreadyLinked: true,
          translatorId: t.id,
          email: t.email,
          authUserId: t.auth_user_id,
          message: '该译员已绑定 auth_user_id，无需重绑',
        },
      });
    }

    if (!t.email) {
      return corsResponse(400, { error: '译员邮箱为空，无法反查 auth user' });
    }

    // 2. 列 auth.users 找该邮箱的 auth user
    //    service_role getUserByEmail() 一次只能查一个；用 listUsers 翻页找
    let authUserId = null;
    let page = 1;
    const perPage = 200;
    // 安全护栏：最多翻 10 页（2000 个用户）
    for (let i = 0; i < 10; i++) {
      const { data: list, error: listErr } = await service.auth.admin.listUsers({ page, perPage });
      if (listErr) {
        return corsResponse(500, { error: '查询 auth users 失败：' + listErr.message });
      }
      const match = (list?.users || []).find(u => String(u.email).toLowerCase() === t.email.toLowerCase());
      if (match) {
        authUserId = match.id;
        break;
      }
      if (!list?.users?.length || list.users.length < perPage) break;
      page++;
    }

    if (!authUserId) {
      return corsResponse(404, {
        error: `auth.users 中找不到邮箱 ${t.email}，该译员可能还没在 Supabase Auth 创建账号`,
        hint: '请先用 admin 后台删除该译员，再通过译员管理 → 添加译员重建',
      });
    }

    // 3. UPDATE auth_user_id
    const { error: upErr } = await service
      .from('translators')
      .update({ auth_user_id: authUserId })
      .eq('id', translatorId);

    if (upErr) {
      return corsResponse(500, { error: 'UPDATE 失败：' + upErr.message });
    }

    // 4. 审计日志
    await writeAudit(service, {
      user_email: admin.email,
      user_role: 'admin',
      action: 'rebind_translator_auth',
      target_type: 'translator',
      target_id: translatorId,
      details: { email: t.email, authUserId, source: 'rebind-translator-auth' },
    }).catch(() => {});

    return corsResponse(200, {
      data: {
        alreadyLinked: false,
        translatorId: t.id,
        email: t.email,
        authUserId,
        message: '已重新绑定 auth_user_id，可登录译员工作台',
      },
    });
  } catch (err) {
    console.error('rebind-translator-auth unhandled:', err);
    return corsResponse(500, { error: err.message });
  }
};
