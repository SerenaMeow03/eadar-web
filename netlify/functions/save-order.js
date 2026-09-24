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
  // 手动登记场景：项目名称/字数/费率/截止日期 + 译员 必填
  // 批量导入场景（带 batch_id）：译员允许空（不会派单也不发邮件，由 admin 后续用「登记订单」单条补派）
  if (!project_name || !word_count || !rate || !deadline) {
    return corsResponse(400, { error: '项目名称、字数、费率、截止日期为必填' });
  }
  if (!translator_id && !batch_id) {
    return corsResponse(400, { error: '译员为必填（批量导入可留空，但不会发送派单邮件）' });
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
    let oldPaymentStatus = null;  // C5: 用于检测 unpaid → paid 触发结算通知
    let oldStatus = null;          // C7: 用于检测 progress → pending 触发收回通知
    let oldTranslatorId = null;    // C7 修复（2026-09-24）：原译员 — admin 改派时通知原译员而非新译员
    if (id) {
      // 一次读旧 status + payment_status + translator_id（避免 SELECT 再 UPDATE 多一轮 RT）
      const { data: prev } = await service
        .from('orders')
        .select('status, payment_status, translator_id')
        .eq('id', id)
        .single();
      oldPaymentStatus = prev?.payment_status || null;
      oldStatus = prev?.status || null;
      oldTranslatorId = prev?.translator_id || null;

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

    // 邮件触发结果收集器（修复 2026-09-24 P1#3：之前 try-catch 吞错，前端 toast「订单已创建」绿色
    // 完全不知道邮件失败。现在把每个 trigger 的状态写入 response.data.emailNotifications，
    // 前端拿到后追加 secondary warning toast：admin 能看到「订单已创建，但 X 封邮件失败」。
    // 保留「主流程优先」语义：邮件失败不阻塞订单创建/更新。
    //
    // 2026-09-24 P1：trigger 改并发（之前 C2-resign + C7 + C7-reassign 串行 await，3 个触发时
    // 串行 4.5s + 业务 200ms ≈ 4.7s，接近 Netlify 同步函数 10s 阈值，用户实测连续改派场景
    // （progress→progress + translator 改）撞 504 Gateway Timeout）
    // 修法：fetch 收集到 promises 数组，最后 Promise.all 并发；每个 fetch 加 AbortController 5s 兜底
    const emailNotifications = [];
    const fireAndAwait = []; // 各 trigger 的 promise，最后统一 Promise.all

    // 通用 trigger：fetch + 5s 超时 + 异常吞错 + 写 emailNotifications
    // 故意 await fetch 但不阻塞外部逻辑（外部 await Promise.all）
    const fireEmailTrigger = async (type, body) => {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5000);
      try {
        const protocol = event.headers['x-forwarded-proto'] || 'https';
        const host = event.headers.host;
        const authHeader = event.headers.authorization || event.headers.Authorization || '';
        const resp = await fetch(`${protocol}://${host}/.netlify/functions/${type === 'C2' ? 'send-order-email' : type === 'C5' ? 'send-translator-payment-email' : 'send-order-cancel-email'}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        emailNotifications.push({ type, status: resp.ok ? 'sent' : 'failed', code: resp.status });
      } catch (err) {
        emailNotifications.push({ type, status: 'failed', error: err.message });
      } finally {
        clearTimeout(tid);
      }
    };

    // C2: 派单通知译员（仅创建时 + 仅待处理状态触发）
    // 用户诉求：只有"待处理"才通知译员，进行中/已完成/取消不通知
    // - 编辑路径永远不重发
    // - 创建但 status ≠ pending（极端场景：admin 补登历史已完成的单子）也不发
    // V11 批量导入：带 batch_id 的订单不在这条链路发单条邮件，由 send-batch-import-email 按译员聚合发汇总
    if (!id && status === 'pending' && !batch_id) {
      fireAndAwait.push(fireEmailTrigger('C2', { orderId: result.id }));
    } else if (!id) {
      console.log('[save-order] C2 trigger skipped: status=', status, 'orderId=', result.id);
    }

    // C2 编辑模式转派通知（admin 把 translator_id 改成新译员）
    // 与上面创建 trigger 区分（创建是 !id && status='pending' && !batch_id，编辑改派是 id && translator 变了）
    // 触发条件放宽：status in [pending, progress]
    //   - pending：用户说"收回后重新派给 C" → C 收「新派单」
    //   - progress：用户说"连续改派"（admin 在译员已接单时直接换译员）→ C 收「新派单」
    // 包括 oldTranslatorId=null 的场景：批量导入时译员空，admin 后续补指定译员
    // send-order-email 内部用 translators:translator_id JOIN 查关联译员，编辑后 order.translator_id 是新值，
    // 所以会发对新译员（无需再传 originalTranslatorId）
    if (id && oldTranslatorId !== translator_id && translator_id !== null && ['pending', 'progress'].includes(status) && !batch_id) {
      fireAndAwait.push(fireEmailTrigger('C2-resign', { orderId: result.id }));
    }

    // C5: 结算通知译员（仅编辑模式 + payment_status: unpaid → paid 才触发）
    // 用户诉求：admin 改"已结算"时通知译员
    // - 仅 unpaid → paid 变化触发，避免重复打扰
    // - 编辑路径独有（创建路径 payment_status 默认 unpaid，不会触发）
    if (id && oldPaymentStatus === 'unpaid' && payment_status === 'paid') {
      fireAndAwait.push(fireEmailTrigger('C5', { orderId: result.id }));
    } else if (id && payment_status === 'paid') {
      console.log('[save-order] C5 trigger skipped: oldPaymentStatus=', oldPaymentStatus);
    }

    // C7: 收回通知译员（admin 把 progress → pending —— 收回已接订单改派他人）
    // 触发条件：admin 编辑订单时，把 status 从 progress 改成 pending（收回已接单）
    // 不触发：pending → pending（无效）；completed → pending（已完成被收回是 admin 误操作）
    // 之前 1d67f62b 错把 trigger 放到 update-order-status.js，但 admin 改状态走 save-order，不是 update-order-status
    //
    // 关键（2026-09-24 用户反馈修复）：必须传 originalTranslatorId 通知**原译员**，不能从 order.translator_id 读
    // ——save-order 触发时 order 已是 UPDATE 后的新值（B），如果按 order.translator_id 查就发给 B 错
    // oldTranslatorId 是 UPDATE 前的旧值（A），传过去通知 A 才正确
    if (id && oldStatus === 'progress' && status === 'pending') {
      fireAndAwait.push(fireEmailTrigger('C7', {
        orderId: result.id,
        previousStatus: oldStatus,
        action: 'recalled',
        originalTranslatorId: oldTranslatorId,  // C7 修复：通知原译员，不是新译员
      }));
    }

    // C7-reassign: 连续改派通知（progress → progress + translator_id 改了）
    // 用户反馈（2026-09-24 第 2 次）："B译员接单后，直接admin在系统中将订单从B译员改为C译员"
    //   → B 应该收到「订单收回通知」+ C 应该收到「新派单通知」（C2-resign 已覆盖）
    // 跟上面 C7 trigger 不冲突：上面是 progress→pending（status 改），这里是 progress→progress（status 不变）
    if (id && oldTranslatorId && oldTranslatorId !== translator_id && oldStatus === 'progress' && status === 'progress') {
      fireAndAwait.push(fireEmailTrigger('C7-reassign', {
        orderId: result.id,
        previousStatus: oldStatus,
        action: 'recalled',
        originalTranslatorId: oldTranslatorId,
      }));
    }

    // 并发执行所有触发的邮件 trigger（之前串行 await，3 个触发时 ~4.5s 撞 Netlify 10s 超时）
    if (fireAndAwait.length > 0) {
      await Promise.all(fireAndAwait);
      console.log('[save-order] all triggers done:', emailNotifications.map(n => `${n.type}:${n.status}`).join(', '));
    }

    return corsResponse(200, {
      data: { ...result, emailNotifications },
      message: id ? '订单已更新' : '订单已创建',
    });
  } catch (e) {
    console.error('save-order unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};
