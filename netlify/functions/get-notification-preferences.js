// netlify/functions/get-notification-preferences.js
// 当前用户查询自己的通知偏好（A9）
// 返回 4 项默认偏好 + 用户实际设置
//
// 入参：无（从 token 推导 email）
// 返回：
//   { email, preferences: [{ key, label, enabled }] }

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate } = require('./_shared/auth');

// 4 类通知及其展示标签
const ALL_PREFERENCES = [
  { key: 'order_assigned', label: '订单分配通知', desc: '当有订单指派给您时发送邮件' },
  { key: 'order_completed', label: '订单完成通知', desc: '当您完成的订单被标记完成时发送邮件' },
  { key: 'payment_received', label: '付款到账通知', desc: '当您收到译费付款时发送邮件' },
  { key: 'invoice_issued', label: '发票开具通知', desc: '当您相关的订单开具发票时发送邮件' },
];

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

    const preferences = ALL_PREFERENCES.map(p => ({
      key: p.key,
      label: p.label,
      desc: p.desc,
      enabled: setMap[p.key] !== false, // undefined / true → true；显式 false → false
    }));

    return corsResponse(200, {
      data: {
        email: userEmail,
        preferences,
      },
    });
  } catch (e) {
    console.error('get-notification-preferences unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};