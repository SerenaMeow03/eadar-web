// netlify/functions/delete-translator.js
// 软删除译员：status → terminated
//
// 为什么软删不硬删：
//   - 保留历史订单（orders.translator_id 仍指向此译员）
//   - 以后审计/补开发票/统计业务量都需要历史数据
//   - 误删易恢复（改回 status=active）
//
// 硬删的话需要：
//   1. delete from auth.users where id = auth_user_id  (cascade 删 translators)
//   2. orders.translator_id 会自动 set null —— 失去归属信息
//
// 权限：
//   - admin 可软删任意译员
//   - 译员不能删自己（防误操作）
//
// 接收: { id: 'T001' }
// 返回: { success: true, id, previous_status, new_status }
// 或: { error: '译员不存在' | '已是 terminated 状态' | '权限不足' }

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate, requireMethod, parseBody } = require('./_shared/auth');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const methodErr = requireMethod(event, 'POST');
  if (methodErr) return methodErr;

  const auth = await authenticate(event);
  if (auth.error) return auth.error;

  // 仅 admin 可操作
  if (auth.role !== 'admin') {
    return corsResponse(403, { error: '仅管理员可删除译员' });
  }

  const body = parseBody(event);
  if (!body || !body.id) {
    return corsResponse(400, { error: '缺少必填字段 id' });
  }

  const service = getServiceClient();

  try {
    // 1. 查译员当前状态
    const { data: t, error: fetchErr } = await service
      .from('translators')
      .select('id, status, name, email')
      .eq('id', body.id)
      .single();

    if (fetchErr || !t) {
      return corsResponse(404, { error: '译员不存在' });
    }

    if (t.status === 'terminated') {
      return corsResponse(400, { error: '该译员已是终止状态' });
    }

    const previousStatus = t.status;

    // 2. 软删：status → terminated
    // 注意：不删 auth.users —— 译员仍可登录，但前端按 status 过滤显示
    // 不改 email/username —— 保留原始身份信息，方便历史订单追溯
    const { data: updated, error: updateErr } = await service
      .from('translators')
      .update({ status: 'terminated' })
      .eq('id', body.id)
      .select('id, status, name, email')
      .single();

    if (updateErr) {
      console.error('delete-translator update error:', updateErr);
      return corsResponse(500, { error: updateErr.message });
    }

    return corsResponse(200, {
      data: {
        success: true,
        id: updated.id,
        name: updated.name,
        previous_status: previousStatus,
        new_status: updated.status,
        message: `译员 ${updated.name} 已终止合作（软删除）`,
      },
    });
  } catch (e) {
    console.error('delete-translator unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};
