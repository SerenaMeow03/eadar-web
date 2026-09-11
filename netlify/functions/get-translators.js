// netlify/functions/get-translators.js
// 仅管理员：返回译员列表
//
// 排序规则（字母序恰好对应业务优先级）：
//   active      → 正常运营译员（最上）
//   suspended   → 暂停合作（中间）
//   terminated  → 已终止合作（最下，便于审计）
//
// 所有译员都返回（包括 terminated），admin 可看到完整历史。

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
      // 字母序：active → suspended → terminated
      .order('status', { ascending: true })
      // 同一状态内，按注册时间倒序（最新在前）
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
