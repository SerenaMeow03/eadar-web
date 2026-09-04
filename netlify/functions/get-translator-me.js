// netlify/functions/get-translator-me.js
// 译员：返回自己的 profile（不含其他译员信息）
// 管理员：返回自己的 admin profile

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
    if (auth.role === 'translator') {
      if (!auth.translatorId) {
        return corsResponse(403, { error: '译员档案未找到' });
      }

      const { data, error } = await service
        .from('translators')
        .select(`
          id, name, email, phone, bank_info, languages, specialties,
          standard_rate, urgent_rate, status, remark, created_at
        `)
        .eq('id', auth.translatorId)
        .single();

      if (error) {
        console.error('get-translator-me (translator) error:', error);
        return corsResponse(500, { error: error.message });
      }

      return corsResponse(200, { data });
    }

    if (auth.role === 'admin') {
      const { data, error } = await service
        .from('admin')
        .select('id, username, email, display_name, created_at')
        .eq('auth_user_id', auth.user.id)
        .single();

      if (error) {
        console.error('get-translator-me (admin) error:', error);
        return corsResponse(500, { error: error.message });
      }

      return corsResponse(200, { data });
    }

    return corsResponse(403, { error: 'Unknown role' });
  } catch (e) {
    console.error('get-translator-me unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};
