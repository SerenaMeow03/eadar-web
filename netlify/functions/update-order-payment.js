// netlify/functions/update-order-payment.js
// admin 调用：更新订单的付款/发票字段
// 适用场景：admin 在订单详情弹窗编辑"客户付款状态/发票信息"
//
// 入参：{ id, client_payment_status?, invoice_status?, invoice_number?, invoice_date? }
// 返回：{ data: { id, ... } } - 更新后的订单行
//
// 字段语义：
//   client_payment_status = 'unpaid' | 'paid'         // 客户付钱给公司
//   invoice_status        = 'not_issued' | 'issued'   // 公司开票给客户
//   invoice_number        = 发票号（文本）
//   invoice_date          = 开票日期（date 格式 YYYY-MM-DD）
//
// 注意：本函数不更新 payment_status（旧字段，给译员结算用，由 save-order 处理）

const { getServiceClient } = require('./_shared/supabase');
const {
  corsResponse,
  preflight,
  authenticate,
  requireMethod,
  parseBody,
} = require('./_shared/auth');
const { writeAudit } = require('./_shared/audit');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const methodErr = requireMethod(event, 'POST');
  if (methodErr) return methodErr;

  // 仅 admin 可调用
  const auth = await authenticate(event, 'admin');
  if (auth.error) return auth.error;

  const body = parseBody(event);
  if (!body) return corsResponse(400, { error: 'Invalid JSON body' });

  const { id, client_payment_status, invoice_status, invoice_number, invoice_date } = body;

  if (!id) {
    return corsResponse(400, { error: '订单 ID 必填' });
  }

  // 字段值校验
  if (client_payment_status !== undefined && !['unpaid', 'paid'].includes(client_payment_status)) {
    return corsResponse(400, { error: '客户付款状态值无效（只接受 unpaid/paid）' });
  }
  if (invoice_status !== undefined && !['not_issued', 'issued'].includes(invoice_status)) {
    return corsResponse(400, { error: '开票状态值无效（只接受 not_issued/issued）' });
  }

  // invoice_date 必须是 YYYY-MM-DD 格式或 null
  if (invoice_date !== undefined && invoice_date !== null && invoice_date !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(invoice_date)) {
      return corsResponse(400, { error: '开票日期格式无效（应为 YYYY-MM-DD）' });
    }
  }

  const service = getServiceClient();

  try {
    // 组装 update payload（只更新传入的字段）
    const updateData = {};
    if (client_payment_status !== undefined) updateData.client_payment_status = client_payment_status;
    if (invoice_status !== undefined) updateData.invoice_status = invoice_status;
    if (invoice_number !== undefined) updateData.invoice_number = invoice_number || null;
    if (invoice_date !== undefined) updateData.invoice_date = invoice_date || null;

    if (Object.keys(updateData).length === 0) {
      return corsResponse(400, { error: '没有要更新的字段' });
    }

    const { data, error } = await service
      .from('orders')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('update-order-payment error:', error);
      return corsResponse(500, { error: error.message });
    }

    if (!data) {
      return corsResponse(404, { error: '订单不存在' });
    }

    console.log('order payment/invoice updated:', id, 'by admin:', auth.user.email);

    // A7: 写审计日志
    await writeAudit(service, {
      user_email: auth.user?.email || 'unknown',
      user_role: auth.role,
      action: 'update_payment',
      target_type: 'order',
      target_id: id,
      details: updateData,
    });

    return corsResponse(200, { data });
  } catch (e) {
    console.error('update-order-payment unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};