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
    client_amount,       // 客户金额（可选，不填则按 client_rate * word_count / 1000 自动算）
  } = body;

  // 必填校验
  if (!project_name || !word_count || !rate || !deadline || !translator_id) {
    return corsResponse(400, { error: '项目名称、字数、费率、截止日期、译员为必填' });
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

  const service = getServiceClient();

  if (client_id) {
    // 验证客户存在
    const { data: c } = await service.from('clients').select('id').eq('id', client_id).single();
    if (!c) {
      return corsResponse(400, { error: '客户不存在' });
    }
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
      client_amount: client_amount !== undefined && client_amount !== null
        ? Number(client_amount)
        : (client_rate ? Number((word_count * client_rate).toFixed(2)) : null),
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
      },
    });

    return corsResponse(200, { data: result, message: id ? '订单已更新' : '订单已创建' });
  } catch (e) {
    console.error('save-order unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};
