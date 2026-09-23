// netlify/functions/save-order.js
// 管理员：创建或更新订单

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
  if (!body) {
    return corsResponse(400, { error: 'Invalid JSON body' });
  }

  const {
    id,
    project_name,
    word_count,
    rate,
    amount,
    deadline,
    translator_id,
    status = 'pending',
    payment_status = 'unpaid',
    client_payment_status = 'unpaid',
    description,
    remark,
    client_id,           // 客户（可选）
    client_rate,         // 客户单价（可选）
    client_word_count,   // 客户字数（可选，NULL 时 fallback 到 word_count）
    client_amount,       // 客户金额（可选，不填则按 client_rate * client_word_count / 1000 自动算）
    language_pair,       // 语言对（可选：'zh-en' / 'zh-ja' / 'zh-ko' / 'en-ja'）
    batch_id,            // 批量导入批次 ID（V11，可选）。带此字段的订单由 send-batch-import-email 统一发汇总邮件，跳过下方 C2 单条派单邮件
  } = body;

  // 必填校验
  if (!project_name || !word_count || !rate || !deadline || !translator_id) {
    return corsResponse(400, { error: '项目名称、字数、费率、截止日期、译员为必填' });
  }
  // 客户字段必填（手动登记订单场景）；批量导入场景（带 batch_id）允许空
  if (!client_id && !batch_id) {
    return corsResponse(400, { error: '所属客户为必填（批量导入除外）' });
  }
  if (Number(word_count) <= 0 || Number(rate) <= 0) {
    return corsResponse(400, { error: '字数和费率必须大于 0' });
  }
  if (!['pending', 'progress', 'completed', 'cancelled'].includes(status)) {
    return corsResponse(400, { error: '非法订单状态' });
  }
  if (!['unpaid', 'paid'].includes(payment_status)) {
    return corsResponse(400, { error: '非法结算状态' });
  }
  if (!['unpaid', 'paid'].includes(client_payment_status)) {
    return corsResponse(400, { error: '非法客户付款状态' });
  }
  // 客户字段校验
  if (client_rate !== undefined && client_rate !== null && Number(client_rate) < 0) {
    return corsResponse(400, { error: '客户单价不能为负数' });
  }
  if (client_word_count !== undefined && client_word_count !== null && Number(client_word_count) < 0) {
    return corsResponse(400, { error: '客户字数不能为负数' });
  }
  // 语言对校验（可选，但必须是预设值或自定义字符串 ≤ 32 字符）
  if (language_pair !== undefined && language_pair !== null && language_pair !== '') {
    const validPairs = ['zh-en', 'zh-ja', 'zh-ko', 'en-ja', 'en-ko', 'ja-ko'];
    if (!validPairs.includes(language_pair) && language_pair.length > 32) {
      return corsResponse(400, { error: '非法语言对' });
    }
  }

  const service = getServiceClient();

  let clientNameSnapshot = null;
  if (client_id) {
    // 验证客户存在 + snapshot 客户名（v9：客户被删仍能展示原名）
    const { data: c } = await service
      .from('clients')
      .select('id, company_name, contact_name')
      .eq('id', client_id)
      .single();
    if (!c) {
      return corsResponse(400, { error: '客户不存在' });
    }
    clientNameSnapshot = (c.company_name || c.contact_name || '').trim() || null;
  }

  try {
    // 验证译员存在
    const { data: t } = await service
      .from('translators')
      .select('id')
      .eq('id', translator_id)
      .single();
    if (!t) {
      return corsResponse(400, { error: '译员不存在' });
    }

    const orderData = {
      project_name: String(project_name).trim(),
      word_count: Number(word_count),
      rate: Number(rate),
      amount: Number(amount ?? (word_count * rate).toFixed(2)),
      deadline: deadline,
      translator_id: translator_id,
      status: status,
      payment_status: payment_status,
      client_payment_status: client_payment_status,
      description: description || null,
      remark: remark || null,
      client_id: client_id || null,
      client_rate: client_rate !== undefined && client_rate !== null ? Number(client_rate) : null,
      // v7：客户字数与译员字数分开；NULL 时写入 word_count 保持等价（不存 NULL 避免前端 fallback 逻辑复杂化）
      client_word_count: Number(
        client_word_count !== undefined && client_word_count !== null
          ? client_word_count
          : word_count
      ),
      // v7：客户金额用客户字数算
      client_amount: client_amount !== undefined && client_amount !== null
        ? Number(client_amount)
        : (client_rate
            ? Number(((client_word_count !== undefined && client_word_count !== null
                ? Number(client_word_count)
                : Number(word_count)) * client_rate).toFixed(2))
            : null),
      // v8：语言对
      language_pair: language_pair || null,
      // v9：客户名快照（写时固化，客户被删仍可追溯）
      client_name_snapshot: clientNameSnapshot,
      // v11：批量导入批次 ID（带 batch_id 的订单跳过 C2 单条派单邮件，由新链路统一发汇总）
      batch_id: batch_id || null,
    };

    let result;
    if (id) {
      // 更新
      const { data, error } = await service
        .from('orders')
        .update(orderData)
        .eq('id', id)
        .select()
        .single();
      if (error) {
        console.error('save-order update error:', error);
        return corsResponse(500, { error: error.message });
      }
      result = data;
    } else {
      // 创建 - 生成订单号
      const newId = 'YD' + new Date().toISOString().slice(0, 10).replace(/-/g, '') +
        String(Math.floor(Math.random() * 1000)).padStart(3, '0');
      const { data, error } = await service
        .from('orders')
        .insert({ id: newId, ...orderData })
        .select()
        .single();
      if (error) {
        console.error('save-order insert error:', error);
        return corsResponse(500, { error: error.message });
      }
      result = data;
    }

    // A7: 审计日志
    await writeAudit(service, {
      user_email: auth.user?.email || 'unknown',
      user_role: auth.role,
      action: id ? 'update_order' : 'create_order',
      target_type: 'order',
      target_id: result.id,
      details: {
        project_name,
        translator_id,
        word_count,
        rate,
        amount,
        deadline,
        status,
        // V11：批量导入批次 ID（便于审计追溯"这批是 admin 哪次 Excel 导入的"）
        batch_id: batch_id || null,
      },
    });

    // C2: 派单通知译员（仅创建时 + 仅待处理状态触发）
    // 用户诉求：只有"待处理"才通知译员，进行中/已完成/取消不通知
    // - 编辑路径永远不重发
    // - 创建但 status ≠ pending（极端场景：admin 补登历史已完成的单子）也不发
    // 后端 await 同步调用：100% 可靠，前端 UI 已 closeModal 不阻塞感官
    // 改前：context.waitUntil() — Netlify 不支持，throw error
    // 改前：裸 fetch() — 实测丢失（38s 延迟 + 第二次完全没发出）
    // V11 批量导入：带 batch_id 的订单不在这条链路发单条邮件，由 send-batch-import-email 按译员聚合发汇总
    if (!id && status === 'pending' && !batch_id) {
      try {
        const protocol = event.headers['x-forwarded-proto'] || 'https';
        const host = event.headers.host;
        const authHeader = event.headers.authorization || event.headers.Authorization || '';
        const resp = await fetch(`${protocol}://${host}/.netlify/functions/send-order-email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader,
          },
          body: JSON.stringify({ orderId: result.id }),
        });
        console.log('[save-order] C2 trigger response:', resp.status, 'status=pending');
      } catch (err) {
        console.warn('[save-order] C2 trigger failed (non-blocking):', err.message);
      }
    } else if (!id) {
      console.log('[save-order] C2 trigger skipped: status=', status, 'orderId=', result.id);
    }

    return corsResponse(200, { data: result, message: id ? '订单已更新' : '订单已创建' });
  } catch (e) {
    console.error('save-order unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};
