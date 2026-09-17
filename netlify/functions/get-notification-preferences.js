// netlify/functions/get-notification-preferences.js
// 当前用户查询自己的通知偏好（A9）
// 2026-09-17 升级：按 role 过滤，仅返回该角色适用的项
//
// 入参：无（从 token 推导 email + role）
// 返回：
//   { data: { email, role, preferences: [{ key, label, desc, enabled }] } }

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate } = require('./_shared/auth');
const { ROLE_PREFERENCES, getUserRole } = require('./_shared/notifications');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  if (event.httpMethod !== 'GET') {
    return corsResponse(405, { error: 'Method not allowed' });
  }

  const auth = await authenticate(event);
  if (auth.error) return auth.error;

  const userEmail = auth.user?.email;
  if (!userEmail) {
    return corsResponse(400, { error: '无法获取用户邮箱' });
  }

  const userRole = getUserRole(auth.user);
  const rolePrefs = ROLE_PREFERENCES[userRole] || [];

  const service = getServiceClient();

  try {
    const { data, error } = await service
      .from('notification_preferences')
      .select('preference_key, enabled')
      .eq('user_email', userEmail);

    if (error) {
      console.error('get-notification-preferences error:', error);
      return corsResponse(500, { error: error.message });
    }

    // 合并：DB 没记录 = 默认 true
    const setMap = {};
    (data || []).forEach(r => { setMap[r.preference_key] = r.enabled; });

    const preferences = rolePrefs.map(p => ({
      key: p.key,
      label: p.label,
      desc: p.desc,
      enabled: setMap[p.key] !== false, // undefined / true → true；显式 false → false
    }));

    return corsResponse(200, {
      data: {
        email: userEmail,
        role: userRole,
        preferences,
      },
    });
  } catch (e) {
    console.error('get-notification-preferences unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};
