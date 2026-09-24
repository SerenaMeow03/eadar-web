// netlify/functions/batch-assign-orders.js
// 管理员：批量把多个订单指派给同一个译员（C1）
// 与 batch-delete 模式一致：一次查 → 逐条校验 → 一次性 UPDATE
// 派单成功后由前端触发 send-batch-order-email.js 发一封汇总通知给译员
//
// C7 改派通知：原译员 ≠ 新译员时，调 send-order-cancel-email（action='recalled'）
// 通知原译员「订单被改派他人」。与 save-order.js 的 C7（progress→pending 收回）共用模板和偏好开关。

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
  if (!body || !Array.isArray(body.orderIds) || body.orderIds.length === 0) {
    return corsResponse(400, { error: '缺少订单 ID 数组 (orderIds[])' });
  }
  if (!body.translatorId) {
    return corsResponse(400, { error: '缺少译员 ID (translatorId)' });
  }
  if (body.orderIds.length > 50) {
    return corsResponse(400, { error: '单次最多派单 50 条' });
  }

  const service = getServiceClient();
  const assigned = [];
  const failed = [];

  try {
    // 验证译员存在 + 邮箱可用
    const { data: translator, error: tErr } = await service
      .from('translators')
      .select('id, name, email, status')
      .eq('id', body.translatorId)
      .single();

    if (tErr || !translator) {
      return corsResponse(404, { error: '译员不存在' });
    }
    if (!translator.email) {
      return corsResponse(400, { error: '该译员没有邮箱，无法发送派单通知' });
    }
    if (translator.status === 'terminated') {
      return corsResponse(400, { error: '该译员已终止合作，不能派单' });
    }

    // 一次查所有订单
    const { data: orders, error: fetchErr } = await service
      .from('orders')
      .select('id, status, payment_status, invoice_status, translator_id')
      .in('id', body.orderIds);

    if (fetchErr) {
      console.error('batch-assign-orders fetch error:', fetchErr);
      return corsResponse(500, { error: fetchErr.message });
    }

    const foundMap = {};
    (orders || []).forEach(o => { foundMap[o.id] = o; });

    // 逐条校验：已完成/已取消的不派（已开始的订单不允许改派）
    const assignable = [];
    for (const id of body.orderIds) {
      const o = foundMap[id];
      if (!o) {
        failed.push({ id, reason: '订单不存在' });
        continue;
      }
      if (o.status === 'completed') {
        failed.push({ id, reason: '订单已完成，不能改派' });
        continue;
      }
      if (o.status === 'cancelled') {
        failed.push({ id, reason: '订单已取消，不能派单' });
        continue;
      }
      assignable.push(id);
    }

    // 一次性 UPDATE translator_id（in 操作）
    if (assignable.length > 0) {
      const { error: updErr } = await service
        .from('orders')
        .update({ translator_id: body.translatorId })
        .in('id', assignable);

      if (updErr) {
        console.error('batch-assign-orders update error:', updErr);
        return corsResponse(500, { error: updErr.message });
      }
      assigned.push(...assignable);
    }

    // C7 改派通知：原译员 ≠ 新译员时，调 send-order-cancel-email（action='recalled'）通知原译员
    // 一个订单一封邮件（简单方案，批量改派单译员多个订单是小概率场景，UX 可接受）
    // 后端 await 同步调用：与 save-order C7 同模式，100% 可靠
    //
    // 修复（2026-09-24）：原本 for...of 串行 await，30 单 C7 = 30 秒，会撞 Netlify 异步 26s 超时
    // 改为 Promise.allSettled 并发：sub-function 启动开销 ~300ms，但 30 单实际 ~5-10s
    // SMTP 限流在 email-transport.js 的 maxConnections=2 + rateLimit=2（commit 2dc751a6），并发安全
    const orderMap = new Map((orders || []).map(o => [o.id, o]));
    const c7Tasks = assigned
      .map(id => ({ id, o: orderMap.get(id) }))
      .filter(({ o }) => o && o.translator_id && o.translator_id !== body.translatorId);

    if (c7Tasks.length > 0) {
      const protocol = event.headers['x-forwarded-proto'] || 'https';
      const host = event.headers.host;
      const authHeader = event.headers.authorization || event.headers.Authorization || '';

      const c7Results = await Promise.allSettled(c7Tasks.map(({ id, o }) =>
        fetch(`${protocol}://${host}/.netlify/functions/send-order-cancel-email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader,
          },
          body: JSON.stringify({
            orderId: id,
            previousStatus: o.status,
            action: 'recalled',
            originalTranslatorId: o.translator_id,  // C7 修复（2026-09-24）：通知原译员不是新译员
          }),
        }).then(r => ({ id, status: r.status }))
          .catch(err => ({ id, status: 'failed', error: err.message }))
      ));
      c7Results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          console.log('[batch-assign-orders] C7 trigger response:', r.value.status, 'orderId=', c7Tasks[i].id);
        } else {
          console.warn('[batch-assign-orders] C7 trigger failed (non-blocking):', r.reason?.message);
        }
      });
    }

    // A7: 审计日志
    await writeAudit(service, {
      user_email: auth.user?.email || 'unknown',
      user_role: auth.role,
      action: 'batch_assign',
      target_type: 'order',
      target_id: null,
      details: {
        translator_id: body.translatorId,
        translator_name: translator.name,
        requested: body.orderIds.length,
        assigned_count: assigned.length,
        assigned_ids: assigned,
        failed: failed,
      },
    });

    return corsResponse(200, {
      assigned,
      failed,
      translator: {
        id: translator.id,
        name: translator.name,
        email: translator.email,
      },
      summary: {
        total: body.orderIds.length,
        assigned: assigned.length,
        failed: failed.length,
      },
    });
  } catch (e) {
    console.error('batch-assign-orders unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};