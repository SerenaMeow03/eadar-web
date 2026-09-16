// netlify/functions/update-notification-preferences.js
// 当前用户更新某项通知偏好（A9）
//
// 入参：{ preferences: [{ key, enabled }, ...] }
// 返回：{ success: true }

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate, requireMethod, parseBody } = require('./_shared/auth');

const ALLOWED_KEYS = ['order_assigned', 'order_completed', 'payment_received', 'invoice_issued'];

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

  const body = parseBody(event);
  if (!body || !Array.isArray(body.preferences)) {
    return corsResponse(400, { error: 'preferences[] 必填' });
  }

  // 校验 key 白名单
  for (const p of body.preferences) {
    if (!p.key || !ALLOWED_KEYS.includes(p.key)) {
      return corsResponse(400, { error: `非法 preference_key: ${p.key}` });
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