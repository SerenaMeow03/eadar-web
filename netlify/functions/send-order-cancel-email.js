// netlify/functions/send-order-cancel-email.js
// 内部接口：发送订单收回通知邮件给译员（C7）
// 由 save-order.js（admin 把 progress → pending）或 batch-assign-orders.js（直接改派）触发
//
// 触发条件：admin 收回已接订单（status 从 progress 改回 pending，或改派给其他译员）
// 不触发：pending → pending（无效）；completed → pending（已完成被收回是 admin 误操作）
//
// 鉴权：translator 或 admin 都可触发（内部接口）
//
// 注：原 ACTION_CONFIG 表 + 删除（C6 砍了，C7 收回是唯一用例）

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate } = require('./_shared/auth');
const { buildOrderRecalledEmail } = require('./_shared/email-templates');
const { checkPreference } = require('./_shared/notifications');
const { logEmailFailed } = require('./_shared/email-log');
const { createEmailTransport, validateSmtpEnv } = require('./_shared/email-transport');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  if (event.httpMethod !== 'POST') {
    return corsResponse(405, { error: 'Method not allowed' });
  }

  const auth = await authenticate(event);
  if (auth.error) return auth.error;
  if (!['translator', 'admin'].includes(auth.role)) {
    return corsResponse(403, { error: '无权访问' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return corsResponse(400, { error: 'Invalid JSON' }); }

  const { orderId, previousStatus, originalTranslatorId } = body;
  if (!orderId) {
    return corsResponse(400, { error: 'orderId 必填' });
  }

  // 防御：仅 progress 状态的收回才通知（completed 收回是 admin 误操作，pending 收回没意义）
  if (previousStatus !== 'progress') {
    return corsResponse(200, { data: { skipped: true, reason: `previousStatus=${previousStatus}, no notify` } });
  }

  const service = getServiceClient();

  try {
    // 1. 查订单（不带 translator JOIN —— 译员由下面 originalTranslatorId 决定）
    const { data: order, error: fetchErr } = await service
      .from('orders')
      .select(`
        id, project_name, word_count, rate, amount, deadline,
        status, remark, language_pair
      `)
      .eq('id', orderId)
      .single();

    if (fetchErr || !order) {
      console.error('[send-order-cancel-email] order not found:', orderId);
      return corsResponse(404, { error: '订单不存在' });
    }

    // 2. 选译员：优先用调用方传的 originalTranslatorId（C7 修复 2026-09-24）
    // ——save-order 触发时 order.translator_id 已是 UPDATE 后新值，必须用旧值
    // ——batch-assign-orders 不传 originalTranslatorId，fallback 到 order.translator_id
    let translator;
    if (originalTranslatorId) {
      const { data: t, error: tErr } = await service
        .from('translators')
        .select('id, name, email')
        .eq('id', originalTranslatorId)
        .single();
      if (tErr || !t) {
        console.warn('[send-order-cancel-email] originalTranslatorId not found:', originalTranslatorId);
      } else {
        translator = t;
      }
    }
    if (!translator) {
      const { data: t } = await service
        .from('translators')
        .select('id, name, email')
        .eq('id', order.translator_id)
        .single();
      translator = t;
    }

    if (!translator || !translator.email) {
      console.warn('[send-order-cancel-email] no translator/email for order', orderId);
      return corsResponse(200, { data: { skipped: true, reason: 'no translator email' } });
    }

    // SMTP 配置检查
    const envCheck = validateSmtpEnv();
    if (!envCheck.ok) return corsResponse(500, { error: envCheck.error });
    const { smtpUser } = envCheck;

    // 2. 检查译员偏好（'order_cancelled' 偏好项——文案已改为「订单取消/收回通知」）
    // 注：参数顺序 = (service, email, role, key) — 2026-09-24 修正（之前 role/email 互换，无害但不一致）
    const enabled = await checkPreference(service, translator.email, 'translator', 'order_cancelled');
    if (!enabled) {
      console.log('[send-order-cancel-email] skipped: translator disabled order_cancelled notification:', translator.email);
      return corsResponse(200, { data: { skipped: true, reason: 'translator disabled order_cancelled notification' } });
    }

    // 3. 构造邮件
    const tpl = buildOrderRecalledEmail({
      order: { ...order, previous_status: previousStatus },
      translator,
      smtpUser,
    });

    // 4. 发送（connectionTimeout/socketTimeout 由 helper 统一设为 8s）
    const transporter = createEmailTransport();

    try {
      const info = await transporter.sendMail({
        from: tpl.fromName + ' <' + smtpUser + '>',
        to: tpl.to,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });
      console.log('[send-order-cancel-email] sent:', info.messageId, 'to:', tpl.to, 'previousStatus:', previousStatus);
      return corsResponse(200, { data: { sent: true, messageId: info.messageId } });
    } catch (mailErr) {
      await logEmailFailed(service, {
        orderId,
        emailType: 'order_recalled',
        to: tpl.to,
        error: mailErr,
        translatorId: translator.id,
      });
      console.error('[send-order-cancel-email] mail failed:', mailErr.message);
      return corsResponse(500, { error: '邮件发送失败：' + mailErr.message });
    }
  } catch (e) {
    console.error('[send-order-cancel-email] unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};