// netlify/functions/delete-order.js
// 管理员：删除订单

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate, requireMethod, parseBody } = require('./_shared/auth');
const { writeAudit } = require('./_shared/audit');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const methodErr = requireMethod(event, 'POST');
  if (methodErr) return methodErr;

  const auth = await authenticate(event, 'admin');
  if (auth.error) return auth.error;

  const body = parseBody(event);
  if (!body || !body.id) {
    return corsResponse(400, { error: '缺少订单 ID' });
  }

  const service = getServiceClient();

  try {
    // 1. 先查订单，检查是否已结算/已开发票
    const { data: order, error: fetchErr } = await service
      .from('orders')
      .select('id, payment_status, invoice_status')
      .eq('id', body.id)
      .single();

    if (fetchErr || !order) {
      return corsResponse(404, { error: '订单不存在' });
    }

    // 2. 数据保护：已结算或已开发票的订单不能删除
    if (order.payment_status === 'paid') {
      return corsResponse(400, {
        error: '订单已结算给译员（payment_status=paid），不能删除。如需撤销，请先在订单详情里改回"未结算"。'
      });
    }
    if (order.invoice_status === 'issued') {
      return corsResponse(400, {
        error: '订单已开发票（invoice_status=issued），不能删除。如需撤销，请先在订单详情里改回"未开票"。'
      });
    }

    // 3. 执行删除
    const { error } = await service
      .from('orders')
      .delete()
      .eq('id', body.id);

    if (error) {
      console.error('delete-order error:', error);
      return corsResponse(500, { error: error.message });
    }

    // A7: 审计日志
    await writeAudit(service, {
      user_email: auth.user?.email || 'unknown',
      user_role: auth.role,
      action: 'delete_order',
      target_type: 'order',
      target_id: body.id,
      details: { payment_status: order.payment_status, invoice_status: order.invoice_status },
    });

    return corsResponse(200, { message: '订单已删除' });
  } catch (e) {
    console.error('delete-order unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};
