// netlify/functions/get-clients.js
// admin 调用：查客户列表（支持 status 筛选 + 搜索）
//
// 入参：?status=active&q=keyword（GET）
// 返回：{ data: [...] }

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate } = require('./_shared/auth');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const auth = await authenticate(event, 'admin');
  if (auth.error) return auth.error;

  const service = getServiceClient();

  try {
    const params = event.queryStringParameters || {};
    const status = params.status; // 'active' | 'archived' | undefined
    const q = params.q; // 搜索关键词

    let query = service.from('clients').select('*').order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }
    if (q) {
      // 模糊搜索：公司名/联系人/邮箱
      query = query.or(`company_name.ilike.%${q}%,contact_name.ilike.%${q}%,email.ilike.%${q}%`);
    }

    const { data, error } = await query;
    if (error) {
      console.error('get-clients error:', error);
      return corsResponse(500, { error: error.message });
    }

    return corsResponse(200, { data: data || [] });
  } catch (e) {
    console.error('get-clients unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};