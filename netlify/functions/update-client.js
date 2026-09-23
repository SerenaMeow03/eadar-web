// netlify/functions/update-client.js
// admin 调用：更新客户信息
//
// 入参：{ id, company_name?, contact_name?, phone?, status?, remark? }
// 返回：{ data: {...} }

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate, parseBody } = require('./_shared/auth');
const { writeAudit } = require('./_shared/audit');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const auth = await authenticate(event, 'admin');
  if (auth.error) return auth.error;

  const body = parseBody(event);
  if (!body) return corsResponse(400, { error: 'Invalid JSON body' });

  const { id, company_name, contact_name, phone, status, remark } = body;

  if (!id) return corsResponse(400, { error: 'id 必填' });

  const update = {};
  if (company_name !== undefined) update.company_name = company_name || null;
  if (contact_name !== undefined) update.contact_name = String(contact_name).trim();
  if (phone !== undefined) update.phone = phone || null;
  if (status !== undefined) {
    if (!['active', 'archived'].includes(status)) {
      return corsResponse(400, { error: '非法状态' });
    }
    update.status = status;
  }
  if (remark !== undefined) update.remark = remark || null;

  if (Object.keys(update).length === 0) {
    return corsResponse(400, { error: '没有要更新的字段' });
  }

  const service = getServiceClient();

  try {
    const { data, error } = await service
      .from('clients')
      .update(update)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('update-client error:', error);
      return corsResponse(500, { error: error.message });
    }
    if (!data) return corsResponse(404, { error: '客户不存在' });

    // A7: 审计日志（客户信息变动留痕，含归档/联系方式变更）
    await writeAudit(service, {
      user_email: auth.user?.email || 'unknown',
      user_role: auth.role,
      action: 'update_client',
      target_type: 'client',
      target_id: id,
      details: update,
    });

    return corsResponse(200, { data, message: '客户已更新' });
  } catch (e) {
    console.error('update-client unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};