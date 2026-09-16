// netlify/functions/get-audit-logs.js
// 管理员：分页查询审计日志（A7）
//
// 入参（GET query 或 POST body）：
//   page        默认 1
//   pageSize    默认 50，max 200
//   action      可选，按 action 类型过滤
//   user_email  可选，按用户邮箱过滤
//   target_id   可选，按目标 ID 过滤
//   dateFrom    可选（YYYY-MM-DD），按 created_at >= dateFrom
//   dateTo      可选（YYYY-MM-DD），按 created_at < dateTo+1
//
// 返回：
//   { logs: [...], total, page, pageSize }

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate } = require('./_shared/auth');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return corsResponse(405, { error: 'Method not allowed' });
  }

  const auth = await authenticate(event, 'admin');
  if (auth.error) return auth.error;

  // 解析参数（GET 用 queryStringParameters，POST 用 body）
  const params = event.httpMethod === 'GET'
    ? (event.queryStringParameters || {})
    : (() => { try { return JSON.parse(event.body || '{}'); } catch (e) { return {}; } })();

  const page = Math.max(1, parseInt(params.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(params.pageSize) || 50));
  const offset = (page - 1) * pageSize;

  const service = getServiceClient();

  try {
    let query = service
      .from('audit_logs')
      .select('*', { count: 'exact' });

    if (params.action) query = query.eq('action', params.action);
    if (params.user_email) query = query.eq('user_email', params.user_email);
    if (params.target_id) query = query.eq('target_id', params.target_id);
    if (params.dateFrom) query = query.gte('created_at', params.dateFrom);
    if (params.dateTo) query = query.lt('created_at', params.dateTo + 'T23:59:59');

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (error) {
      console.error('get-audit-logs error:', error);
      return corsResponse(500, { error: error.message });
    }

    return corsResponse(200, {
      data: {
        logs: data || [],
        total: count || 0,
        page,
        pageSize,
      },
    });
  } catch (e) {
    console.error('get-audit-logs unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};