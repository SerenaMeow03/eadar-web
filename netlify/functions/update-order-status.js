// netlify/functions/update-order-status.js
// 更新订单状态（接单 / 完成）
//
// 角色：
//   - 译员 (translator)：只能更新自己被分配的订单，且必须走状态机
//     pending → progress  (接单)
//     progress → completed (完成)
//     其他流转不允许（包括任意 → cancelled 都不行，避免误操作）
//   - 管理员 (admin)：可更新任意订单任意状态
//
// body: { id, status, translator_note? }
//   - id: 订单 ID（必填）
//   - status: pending | progress | completed | cancelled（必填）
//   - translator_note: 译员完成时填的备注，可选。映射到 orders.remark 字段（避免 schema 变更）

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate, requireMethod, parseBody } = require('./_shared/auth');
const { writeAudit } = require('./_shared/audit');

// 状态机白名单
const ALLOWED_STATUSES = ['pending', 'progress', 'completed', 'cancelled'];

// 译员允许的状态流转
const TRANSLATOR_TRANSITIONS = {
  'pending':   ['progress'],
  'progress':  ['completed'],
  // completed / cancelled → 终态，译员不能再动
};

exports.handler = async (event, context) => {
  const pre = preflight(event);
  if (pre) return pre;

  const methodErr = requireMethod(event, 'POST');
  if (methodErr) return methodErr;

  const auth = await authenticate(event);
  if (auth.error) return auth.error;

  const body = parseBody(event);
  if (!body || !body.id || !body.status) {
    return corsResponse(400, { error: '缺少必填字段 id / status' });
  }

  if (!ALLOWED_STATUSES.includes(body.status)) {
    return corsResponse(400, { error: `非法 status: ${body.status}` });
  }

  const service = getServiceClient();

  try {
    // 1. 读订单，确认存在 + 拿到当前 status / translator_id
    const { data: order, error: fetchErr } = await service
      .from('orders')
      .select('id, status, translator_id')
      .eq('id', body.id)
      .single();

    if (fetchErr || !order) {
      return corsResponse(404, { error: '订单不存在' });
    }

    // 2. 权限 + 状态机校验
    if (auth.role === 'translator') {
      if (!auth.translatorId) {
        return corsResponse(403, { error: '译员档案未找到' });
      }
      if (order.translator_id !== auth.translatorId) {
        // 防越权：译员 A 不能操作译员 B 的订单
        return corsResponse(403, { error: '无权操作他人订单' });
      }

      const allowed = TRANSLATOR_TRANSITIONS[order.status] || [];
      if (!allowed.includes(body.status)) {
        return corsResponse(400, {
          error: `状态非法流转: ${order.status} → ${body.status}。译员允许: pending→progress, progress→completed`
        });
      }
    } else if (auth.role === 'admin') {
      // admin 任意流转，不校验
    } else {
      return corsResponse(403, { error: 'Unknown role' });
    }

    // 3. 构造更新 payload
    const updatePayload = { status: body.status };
    if (body.translator_note !== undefined && body.translator_note !== null) {
      // 译员备注写到 remark 字段（和 admin 备注共用，不引入新字段）
      // 如果以后需要分离，再加 admin_note 字段做迁移
      updatePayload.remark = body.translator_note;
    }

    // 4. 执行更新
    const { data: updated, error: updateErr } = await service
      .from('orders')
      .update(updatePayload)
      .eq('id', body.id)
      .select(`
        id, project_name, word_count, rate, amount, deadline,
        status, payment_status, description, remark,
        created_at, updated_at, translator_id,
        translators:translator_id ( id, name, email )
      `)
      .single();

    if (updateErr) {
      console.error('update-order-status update error:', updateErr);
      return corsResponse(500, { error: updateErr.message });
    }

    // A7: 写审计日志（失败不阻塞主流程）
    await writeAudit(service, {
      user_email: auth.user?.email || (auth.role === 'translator' ? 'translator:' + auth.translatorId : 'unknown'),
      user_role: auth.role,
      action: 'update_status',
      target_type: 'order',
      target_id: body.id,
      details: {
        from_status: order.status,
        to_status: body.status,
        note: body.translator_note || null,
      },
    });

    // C4: 接单通知 admin（pending → progress）
    // 后端 fire-and-forget：用 context.waitUntil() 保证 handler return 后继续执行
    if (order.status === 'pending' && body.status === 'progress') {
      const protocol = event.headers['x-forwarded-proto'] || 'https';
      const host = event.headers.host;
      const authHeader = event.headers.authorization || event.headers.Authorization || '';
      const triggerUrl = `${protocol}://${host}/.netlify/functions/send-order-response-email`;
      console.log('[update-order-status] C4 trigger firing, url:', triggerUrl);
      if (context && typeof context.waitUntil === 'function') {
        context.waitUntil(
          fetch(triggerUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': authHeader,
            },
            body: JSON.stringify({ orderId: body.id, action: 'accepted' }),
          })
            .then(r => console.log('[update-order-status] C4 trigger response:', r.status))
            .catch(err => console.warn('send-order-response-email trigger failed (non-blocking):', err.message))
        );
      } else {
        // 兜底：不用 waitUntil（旧版 Netlify Functions）
        fetch(triggerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
          body: JSON.stringify({ orderId: body.id, action: 'accepted' }),
        }).catch(err => console.warn('send-order-response-email trigger failed (non-blocking):', err.message));
      }
    }

    // C3: 完成通知 admin（progress → completed）
    // 后端 fire-and-forget：用 context.waitUntil() 保证 handler return 后继续执行
    if (order.status === 'progress' && body.status === 'completed') {
      const protocol = event.headers['x-forwarded-proto'] || 'https';
      const host = event.headers.host;
      const authHeader = event.headers.authorization || event.headers.Authorization || '';
      const triggerUrl = `${protocol}://${host}/.netlify/functions/send-completion-email`;
      console.log('[update-order-status] C3 trigger firing, url:', triggerUrl);
      if (context && typeof context.waitUntil === 'function') {
        context.waitUntil(
          fetch(triggerUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': authHeader,
            },
            body: JSON.stringify({ orderId: body.id }),
          })
            .then(r => console.log('[update-order-status] C3 trigger response:', r.status))
            .catch(err => console.warn('send-completion-email trigger failed (non-blocking):', err.message))
        );
      } else {
        // 兜底：不用 waitUntil（旧版 Netlify Functions）
        fetch(triggerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
          body: JSON.stringify({ orderId: body.id }),
        }).catch(err => console.warn('send-completion-email trigger failed (non-blocking):', err.message));
      }
    }

    return corsResponse(200, { data: updated });
  } catch (e) {
    console.error('update-order-status unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};