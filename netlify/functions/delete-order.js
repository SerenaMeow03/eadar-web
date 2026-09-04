// netlify/functions/delete-order.js
// 管理员：删除订单

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
  if (!body || !body.id) {
    return corsResponse(400, { error: '缺少订单 ID' });
  }

  const service = getServiceClient();

  try {
    const { error } = await service
      .from('orders')
      .delete()
      .eq('id', body.id);

    if (error) {
      console.error('delete-order error:', error);
      return corsResponse(500, { error: error.message });
    }

    return corsResponse(200, { message: '订单已删除' });
  } catch (e) {
    console.error('delete-order unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};
