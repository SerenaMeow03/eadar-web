// netlify/functions/update-password.js
// 当前用户修改自己的密码（译员和管理员都能用）
// 通过 Supabase Auth 的 updateUserById 实现

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate, requireMethod, parseBody } = require('./_shared/auth');
const { writeAudit } = require('./_shared/audit');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const methodErr = requireMethod(event, 'POST');
  if (methodErr) return methodErr;

  const auth = await authenticate(event);
  if (auth.error) return auth.error;

  const body = parseBody(event);
  if (!body) {
    return corsResponse(400, { error: 'Invalid JSON body' });
  }

  const { newPassword } = body;
  if (!newPassword || newPassword.length < 6) {
    return corsResponse(400, { error: '新密码至少 6 位' });
  }

  const service = getServiceClient();

  try {
    // 注意：service_role 调用 admin.updateUserById 会直接改密码，不需要当前密码
    // 如果想强制验证当前密码，前端用 signInWithPassword 试一下即可
    const { data, error } = await service.auth.admin.updateUserById(
      auth.user.id,
      { password: newPassword }
    );

    if (error) {
      console.error('update-password error:', error);
      return corsResponse(500, { error: error.message });
    }

    await writeAudit(service, {
      action: 'change_password',
      actorEmail: auth.user.email,
      actorRole: auth.role,
      targetId: auth.role === 'translator' ? auth.translatorId : null,
      targetEmail: auth.user.email,
      targetRole: auth.role,
      details: { self: true },
    }).catch((e) => console.warn('[update-password] writeAudit failed:', e.message));

    return corsResponse(200, { message: '密码修改成功' });
  } catch (e) {
    console.error('update-password unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};
