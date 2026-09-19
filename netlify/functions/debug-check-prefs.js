// netlify/functions/debug-check-prefs.js
// 临时诊断：直接查 notification_preferences 表里某个用户的偏好
// 用法：POST /.netlify/functions/debug-check-prefs  body={ email: 'serena@eadartrans.com' }
// 鉴权：admin only

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate } = require('./_shared/auth');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  if (event.httpMethod !== 'POST') {
    return corsResponse(405, { error: 'Method not allowed' });
  }

  const auth = await authenticate(event);
  if (auth.error) return auth.error;
  if (auth.role !== 'admin') {
    return corsResponse(403, { error: 'admin only' });
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const targetEmail = body.email || auth.user?.email;
  if (!targetEmail) return corsResponse(400, { error: 'email 必填' });

  const service = getServiceClient();
  const { data, error } = await service
    .from('notification_preferences')
    .select('*')
    .eq('user_email', targetEmail);

  if (error) {
    return corsResponse(500, { error: error.message });
  }

  return corsResponse(200, {
    data: {
      target_email: targetEmail,
      rows: data,
      auth_user_email: auth.user?.email,
      auth_user_role: auth.user?.app_metadata?.role,
    },
  });
};