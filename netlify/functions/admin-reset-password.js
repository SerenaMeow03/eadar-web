// netlify/functions/admin-reset-password.js
// admin 调用：重置客户或译员的登录密码
// 入参：{ email, role, new_password? }
//  - email: 必填，目标用户的登录邮箱
//  - role: 必填，'client' 或 'translator'，用于防止角色误重置
//  - new_password: 可选，自定义新密码（>=6 位）；不传则自动生成 12 位临时密码
// 返回：{ data: { email, role, new_password, message } }

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate, parseBody } = require('./_shared/auth');
const { writeAudit } = require('./_shared/audit');

function generateTempPassword() {
  // 12 位临时密码：大写+小写+数字，避免容易混淆的字符（I/O/0/1/l）
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pwd = '';
  for (let i = 0; i < 12; i++) {
    pwd += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pwd;
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  // 仅 admin 可调用
  const auth = await authenticate(event, 'admin');
  if (auth.error) return auth.error;

  const body = parseBody(event);
  if (!body) return corsResponse(400, { error: 'Invalid JSON body' });

  const { email, role, new_password } = body;

  // 1) 校验入参
  if (!email || !role) {
    return corsResponse(400, { error: '邮箱和角色为必填' });
  }
  if (!['client', 'translator'].includes(role)) {
    return corsResponse(400, { error: '角色必须是 client 或 translator' });
  }
  if (new_password && new_password.length < 6) {
    return corsResponse(400, { error: '自定义密码至少需要 6 位' });
  }
  if (new_password && new_password.length > 72) {
    return corsResponse(400, { error: '密码过长（最多 72 位）' });
  }

  const service = getServiceClient();

  try {
    // 2) 查 auth user
    const { data: existingList, error: listErr } = await service.auth.admin.listUsers();
    if (listErr) {
      console.error('listUsers error:', listErr);
      return corsResponse(500, { error: '查询用户失败：' + listErr.message });
    }
    const targetUser = existingList?.users?.find(u => u.email === email);
    if (!targetUser) {
      return corsResponse(404, { error: `找不到邮箱 ${email} 对应的登录账号` });
    }

    // 3) 校验角色匹配（防止重置错对象）
    //    出于安全考虑：不向调用方透露账号实际角色，仅提示"不匹配"
    const userRole = targetUser.app_metadata?.role;
    if (userRole !== role) {
      console.warn('[admin-reset-password] role mismatch:', { email, required: role, actual: userRole });
      return corsResponse(400, {
        error: '邮箱与角色不匹配',
      });
    }

    // 4) 重置密码
    const finalPassword = new_password || generateTempPassword();
    const { error: updateErr } = await service.auth.admin.updateUserById(
      targetUser.id,
      { password: finalPassword }
    );
    if (updateErr) {
      console.error('updateUserById error:', updateErr);
      return corsResponse(500, { error: '密码重置失败：' + updateErr.message });
    }

    console.log(`password reset: ${email} (${role}) by admin ${auth.user.email} at ${new Date().toISOString()}`);

    await writeAudit(service, {
      action: 'reset_password',
      actorEmail: auth.user.email,
      actorRole: 'admin',
      targetEmail: email,
      targetRole: role,
      details: {
        custom: !!new_password,
        // 不写明文密码，只记"是否自定义"
      },
    }).catch((e) => console.warn('[admin-reset-password] writeAudit failed:', e.message));

    return corsResponse(200, {
      data: {
        email,
        role,
        new_password: finalPassword,
        message: new_password
          ? '密码已重置为自定义密码'
          : '已生成新的临时密码，请转告用户并建议首次登录后自行修改',
      },
    });
  } catch (e) {
    console.error('admin-reset-password unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};