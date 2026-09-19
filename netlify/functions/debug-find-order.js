// netlify/functions/debug-find-order.js
// 临时诊断：返回指定状态的订单完整 UUID（前端 admin/orders.html 只显示前 8 位）
// POST { status?: 'progress' | 'pending' | 'completed' }
// admin only

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
  const status = body.status || 'progress';

  const service = getServiceClient();
  const { data, error } = await service
    .from('orders')
    .select('id, project_name, status, updated_at')
    .eq('status', status)
    .order('updated_at', { ascending: false })
    .limit(5);

  if (error) return corsResponse(500, { error: error.message });

  return corsResponse(200, {
    data: {
      status_filter: status,
      count: data?.length || 0,
      orders: data || [],
    },
  });
};