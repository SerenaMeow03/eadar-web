// netlify/functions/get-translators.js
// 仅管理员：返回所有译员列表

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate, requireMethod } = require('./_shared/auth');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const methodErr = requireMethod(event, 'GET');
  if (methodErr) return methodErr;

  const auth = await authenticate(event, 'admin');
  if (auth.error) return auth.error;

  const service = getServiceClient();

  try {
    const { data, error } = await service
      .from('translators')
      .select(`
        id, name, username, email, phone,
        bank_info, languages, specialties, standard_rate, urgent_rate,
        status, remark, created_at, updated_at
      `)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('get-translators error:', error);
      return corsResponse(500, { error: error.message });
    }

    return corsResponse(200, { data: data || [] });
  } catch (e) {
    console.error('get-translators unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};
