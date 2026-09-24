// netlify/functions/get-orders.js
// 译员：返回自己所有订单
// 管理员：返回所有订单（可选按 translator_id / status 过滤）
//
// 分页（2026-09-24）：page + limit 参数，默认第 1 页 / 50 条/页
//   - 避免 1000+ 订单时一次返回 6MB 超 Netlify Function body limit
//   - 返回 data + pagination { page, limit, total, totalPages } 让前端知道是否还有下一页
//   - 后端用 range(from, to) 实现，count: 'exact' 取总数（带 JOIN 稍慢但可接受）

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate, requireMethod } = require('./_shared/auth');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const methodErr = requireMethod(event, 'GET');
  if (methodErr) return methodErr;

  const auth = await authenticate(event);
  if (auth.error) return auth.error;

  const service = getServiceClient();

  try {
    // 解析分页参数（page=1-based, limit=每页条数，limit 上限 200 防止恶意拉全表）
    const page = Math.max(1, parseInt(event.queryStringParameters?.page, 10) || 1);
    const rawLimit = parseInt(event.queryStringParameters?.limit, 10) || 50;
    const limit = Math.min(200, Math.max(1, rawLimit));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = service
      .from('orders')
      .select(`
        id, project_name, word_count, rate, amount, deadline,
        status, payment_status, client_payment_status,
        invoice_status, invoice_number, invoice_date,
        client_id, client_rate, client_word_count, client_amount,
        language_pair, client_name_snapshot,
        description, remark,
        created_at, updated_at, translator_id,
        accepted_at, submitted_at,
        translators:translator_id ( id, name, email ),
        clients:client_id ( id, contact_name, company_name, email )
      `, { count: 'estimated' })
      .order('created_at', { ascending: false })
      .range(from, to);

    // 译员只能看自己的
    if (auth.role === 'translator') {
      if (!auth.translatorId) {
        return corsResponse(403, { error: '译员档案未找到' });
      }
      query = query.eq('translator_id', auth.translatorId);
    }
    // 管理员可以加 query 参数过滤
    else if (auth.role === 'admin') {
      const filterTranslatorId = event.queryStringParameters?.translator_id;
      const filterStatus = event.queryStringParameters?.status;
      if (filterTranslatorId) query = query.eq('translator_id', filterTranslatorId);
      if (filterStatus && filterStatus !== 'all') query = query.eq('status', filterStatus);
    } else {
      return corsResponse(403, { error: 'Unknown role' });
    }

    const { data, error, count } = await query;
    if (error) {
      console.error('get-orders error:', error);
      return corsResponse(500, { error: error.message });
    }

    const total = count || 0;
    return corsResponse(200, {
      data: data || [],
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
      },
    });
  } catch (e) {
    console.error('get-orders unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};
