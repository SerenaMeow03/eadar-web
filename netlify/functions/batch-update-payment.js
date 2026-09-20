// netlify/functions/batch-update-payment.js
// 管理员：批量更新订单的付款/发票字段（仿 batch-assign 模式）
// 适用：admin 客户一次付 N 笔款 / 一次性给客户开 N 张发票时
//
// 入参：{ orderIds: [], client_payment_status?, invoice_status?, invoice_number?, invoice_date? }
//   - 至少传 1 个字段（其他字段保持原值）
//   - invoice_date 格式 YYYY-MM-DD，传 null/空则清空
//   - invoice_number 传 null/空则清空
// 返回：{ data: { updated: [...], failed: [...], summary: {...} } }
//
// 字段语义：与 update-order-payment 一致
//   client_payment_status = 'unpaid' | 'paid'
//   invoice_status        = 'not_issued' | 'issued'
//   invoice_number        = 发票号（文本，null 清空）
//   invoice_date          = 开票日期（YYYY-MM-DD，null 清空）

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

  const auth = await authenticate(event, 'admin');
  if (auth.error) return auth.error;

  const body = parseBody(event);
  if (!body || !Array.isArray(body.orderIds) || body.orderIds.length === 0) {
    return corsResponse(400, { error: '缺少订单 ID 数组 (orderIds[])' });
  }
  if (body.orderIds.length > 50) {
    return corsResponse(400, { error: '单次最多更新 50 条' });
  }

  const {
    client_payment_status,
    invoice_status,
    invoice_number,
    invoice_date,
  } = body;

  // 至少要传一个字段
  const hasAny =
    client_payment_status !== undefined ||
    invoice_status !== undefined ||
    invoice_number !== undefined ||
    invoice_date !== undefined;
  if (!hasAny) {
    return corsResponse(400, { error: '至少传一个要更新的字段' });
  }

  // 字段值校验
  if (client_payment_status !== undefined && !['unpaid', 'paid'].includes(client_payment_status)) {
    return corsResponse(400, { error: '客户付款状态值无效（只接受 unpaid/paid）' });
  }
  if (invoice_status !== undefined && !['not_issued', 'issued'].includes(invoice_status)) {
    return corsResponse(400, { error: '开票状态值无效（只接受 not_issued/issued）' });
  }
  if (invoice_date !== undefined && invoice_date !== null && invoice_date !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(invoice_date)) {
      return corsResponse(400, { error: '开票日期格式无效（应为 YYYY-MM-DD）' });
    }
  }

  const service = getServiceClient();

  try {
    // 1. 一次性查所有订单（确认存在）
    const { data: orders, error: fetchErr } = await service
      .from('orders')
      .select('id, status, payment_status, invoice_status')
      .in('id', body.orderIds);

    if (fetchErr) {
      console.error('batch-update-payment fetch error:', fetchErr);
      return corsResponse(500, { error: fetchErr.message });
    }

    const foundMap = {};
    (orders || []).forEach(o => { foundMap[o.id] = o; });

    const updatable = [];
    const failed = [];
    for (const id of body.orderIds) {
      if (!foundMap[id]) {
        failed.push({ id, reason: '订单不存在' });
      } else {
        updatable.push(id);
      }
    }

    // 2. 构造 update payload（只更新传入的字段）
    const updateData = {};
    if (client_payment_status !== undefined) updateData.client_payment_status = client_payment_status;
    if (invoice_status !== undefined) updateData.invoice_status = invoice_status;
    if (invoice_number !== undefined) updateData.invoice_number = invoice_number || null;
    if (invoice_date !== undefined) updateData.invoice_date = invoice_date || null;

    // 3. 一次性 UPDATE
    const updated = [];
    if (updatable.length > 0) {
      const { data: updatedRows, error: updErr } = await service
        .from('orders')
        .update(updateData)
        .in('id', updatable)
        .select('id');

      if (updErr) {
        console.error('batch-update-payment update error:', updErr);
        return corsResponse(500, { error: updErr.message });
      }
      updated.push(...(updatedRows || []).map(r => r.id));
    }

    // 4. 审计日志（一条总记录 + 失败明细）
    await writeAudit(service, {
      user_email: auth.user?.email || 'unknown',
      user_role: auth.role,
      action: 'batch_update_payment',
      target_type: 'order',
      target_id: null,
      details: {
        requested: body.orderIds.length,
        updated_count: updated.length,
        updated_ids: updated,
        update_fields: updateData,
        failed: failed,
      },
    });

    return corsResponse(200, {
      data: {
        updated,
        failed,
        summary: {
          total: body.orderIds.length,
          updated: updated.length,
          failed: failed.length,
        },
      },
    });
  } catch (e) {
    console.error('batch-update-payment unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};