// netlify/functions/batch-delete-orders.js
// 管理员：批量删除订单（A6）
// 校验规则同 delete-order：payment_status=paid 或 invoice_status=issued 时拒绝

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
  if (!body || !Array.isArray(body.ids) || body.ids.length === 0) {
    return corsResponse(400, { error: '缺少订单 ID 数组 (ids[])' });
  }
  if (body.ids.length > 50) {
    return corsResponse(400, { error: '单次最多删除 50 条' });
  }

  const service = getServiceClient();
  const deleted = [];
  const failed = [];

  try {
    // 一次查所有订单，避免 N 次往返
    const { data: orders, error: fetchErr } = await service
      .from('orders')
      .select('id, payment_status, invoice_status')
      .in('id', body.ids);

    if (fetchErr) {
      console.error('batch-delete-orders fetch error:', fetchErr);
      return corsResponse(500, { error: fetchErr.message });
    }

    const foundMap = {};
    (orders || []).forEach(o => { foundMap[o.id] = o; });

    // 逐条校验 + 标记
    const deletable = [];
    for (const id of body.ids) {
      const o = foundMap[id];
      if (!o) {
        failed.push({ id, reason: '订单不存在' });
        continue;
      }
      if (o.payment_status === 'paid') {
        failed.push({ id, reason: '已结算给译员（payment_status=paid），不能删除' });
        continue;
      }
      if (o.invoice_status === 'issued') {
        failed.push({ id, reason: '已开发票（invoice_status=issued），不能删除' });
        continue;
      }
      deletable.push(id);
    }

    // 一次性 DELETE（delete 不支持 in 后的 returning 精简字段；用 in）
    if (deletable.length > 0) {
      const { error: delErr } = await service
        .from('orders')
        .delete()
        .in('id', deletable);

      if (delErr) {
        console.error('batch-delete-orders delete error:', delErr);
        return corsResponse(500, { error: delErr.message });
      }
      deleted.push(...deletable);
    }

    // A7: 审计日志（一条总记录 + 失败明细）
    await writeAudit(service, {
      user_email: auth.user?.email || 'unknown',
      user_role: auth.role,
      action: 'batch_delete',
      target_type: 'order',
      target_id: null,
      details: {
        requested: body.ids.length,
        deleted_count: deleted.length,
        deleted_ids: deleted,
        failed: failed,
      },
    });

    return corsResponse(200, {
      deleted,
      failed,
      summary: {
        total: body.ids.length,
        deleted: deleted.length,
        failed: failed.length
      }
    });
  } catch (e) {
    console.error('batch-delete-orders unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};