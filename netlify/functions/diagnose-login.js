// netlify/functions/diagnose-login.js
// 一次性诊断：用 service_role 直接查 translators 表 + auth.users 联表
// 看 RLS 启用后 service_role 到底能不能读到 translators 行
// 调用：POST /.netlify/functions/diagnose-login  body: { email }
// 返回：service_role 查到的结果 + auth.users JOIN 结果 + role 等

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate, requireMethod, parseBody } = require('./_shared/auth');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const methodErr = requireMethod(event, 'POST');
  if (methodErr) return methodErr;

  const auth = await authenticate(event, 'admin');
  if (auth.error) return auth.error;

  const body = parseBody(event);
  const email = body?.email;
  if (!email) {
    return corsResponse(400, { error: 'email 必填' });
  }

  const service = getServiceClient();

  try {
    // 1. 先在 auth.users 找到这个邮箱的 user.id
    let authUserId = null;
    let page = 1;
    const perPage = 200;
    for (let i = 0; i < 10; i++) {
      const { data: list } = await service.auth.admin.listUsers({ page, perPage });
      const match = (list?.users || []).find(u => String(u.email).toLowerCase() === email.toLowerCase());
      if (match) {
        authUserId = match.id;
        break;
      }
      if (!list?.users?.length || list.users.length < perPage) break;
      page++;
    }

    if (!authUserId) {
      return corsResponse(404, { error: `auth.users 找不到 ${email}` });
    }

    // 2. service_role 查 translators 表（按 auth_user_id）
    const { data: t, error: tErr } = await service
      .from('translators')
      .select('id, name, email, auth_user_id, status')
      .eq('auth_user_id', authUserId)
      .maybeSingle();

    // 3. service_role 不带过滤查（看表是否真能读）
    const { data: all, error: allErr } = await service
      .from('translators')
      .select('id, name, email, auth_user_id')
      .eq('email', email)
      .maybeSingle();

    // 4. 测试 getUserClient + anon 受 RLS 影响的情况
    const userClient = getUserClientFake(authUserId);  // 模拟 user JWT

    return corsResponse(200, {
      data: {
        email,
        authUserId,
        queryByAuthId: {
          data: t,
          error: tErr ? { message: tErr.message, code: tErr.code } : null,
        },
        queryByEmail: {
          data: all,
          error: allErr ? { message: allErr.message, code: allErr.code } : null,
        },
        diagnosis: t
          ? '✅ service_role 能读到 translators 行，login.js 应该能查到'
          : '❌ service_role 查不到！可能 RLS 没正常 bypass，需要 pg_policy 检查',
      },
    });
  } catch (err) {
    console.error('diagnose-login unhandled:', err);
    return corsResponse(500, { error: err.message });
  }
};

function getUserClientFake(_userId) {
  return null; // 占位，不实现
}