// netlify/functions/get-orders.js
// 译员：返回自己所有订单
// 管理员：返回所有订单（可选按 translator_id / status 过滤）

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
      `)
      .order('created_at', { ascending: false });

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

    const { data, error } = await query;
    if (error) {
      console.error('get-orders error:', error);
      return corsResponse(500, { error: error.message });
    }

    return corsResponse(200, { data: data || [] });
  } catch (e) {
    console.error('get-orders unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};
