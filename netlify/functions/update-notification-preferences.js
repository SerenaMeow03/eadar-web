// netlify/functions/update-notification-preferences.js
// 当前用户更新某项通知偏好（A9）
// 2026-09-17 升级：role-aware 白名单，防止越权（admin 改不到译员项）
//
// 入参：{ preferences: [{ key, enabled }, ...] }
// 返回：{ success: true, updated }
// 错误码：
//   400 - 非法 key（不属于该角色）/ enabled 类型错
//   500 - DB 失败

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate, requireMethod, parseBody } = require('./_shared/auth');
const { ROLE_PREFERENCES, getUserRole } = require('./_shared/notifications');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const methodErr = requireMethod(event, 'POST');
  if (methodErr) return methodErr;

  const auth = await authenticate(event);
  if (auth.error) return auth.error;

  const userEmail = auth.user?.email;
  if (!userEmail) {
    return corsResponse(400, { error: '无法获取用户邮箱' });
  }

  // 拿当前用户的 role + 该角色适用的偏好 key 集合
  const userRole = getUserRole(auth.user);
  const allowedKeys = (ROLE_PREFERENCES[userRole] || []).map(p => p.key);

  const body = parseBody(event);
  if (!body || !Array.isArray(body.preferences)) {
    return corsResponse(400, { error: 'preferences[] 必填' });
  }

  // 校验 key 在用户角色白名单内 + enabled 类型
  for (const p of body.preferences) {
    if (!p.key || !allowedKeys.includes(p.key)) {
      return corsResponse(400, { error: `非法 preference_key: ${p.key}（该角色不适用）` });
    }
    if (typeof p.enabled !== 'boolean') {
      return corsResponse(400, { error: `enabled 必须是 boolean: ${p.key}` });
    }
  }

  const service = getServiceClient();

  try {
    // upsert 每一条
    for (const p of body.preferences) {
      const { error } = await service
        .from('notification_preferences')
        .upsert({
          user_email: userEmail,
          preference_key: p.key,
          enabled: p.enabled,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_email,preference_key' });

      if (error) {
        console.error('update-notification-preferences upsert error:', error);
        return corsResponse(500, { error: error.message });
      }
    }

    return corsResponse(200, { data: { success: true, updated: body.preferences.length } });
  } catch (e) {
    console.error('update-notification-preferences unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};
