// netlify/functions/send-translator-payment-email.js
// 内部接口：发送结算通知邮件给译员
// 由 save-order.js 在 payment_status: unpaid → paid 变化时异步触发
//
// C5: 结算通知
//   - 触发条件：admin 把订单 payment_status 改为 paid（已结算给译员）
//   - 收件人：订单关联的译员
//   - 邮件类型：translator_payment（用于 resend + 偏好筛选）

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate } = require('./_shared/auth');
const { buildTranslatorPaymentEmail } = require('./_shared/email-templates');
const { checkPreference } = require('./_shared/notifications');
const { logEmailFailed } = require('./_shared/email-log');
const { createEmailTransport, validateSmtpEnv } = require('./_shared/email-transport');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  if (event.httpMethod !== 'POST') {
    return corsResponse(405, { error: 'Method not allowed' });
  }

  // 鉴权：仅管理员可触发
  const auth = await authenticate(event, 'admin');
  if (auth.error) return auth.error;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return corsResponse(400, { error: 'Invalid JSON' }); }

  const { orderId } = body;
  if (!orderId) {
    return corsResponse(400, { error: 'orderId 必填' });
  }

  // 检查 SMTP 配置
  const envCheck = validateSmtpEnv();
  if (!envCheck.ok) return corsResponse(500, { error: envCheck.error });
  const { smtpUser } = envCheck;

  const service = getServiceClient();

  let tpl;
  try {
    // 查询订单 + 关联译员邮箱
    const { data: order, error: orderErr } = await service
      .from('orders')
      .select(`
        id, project_name, word_count, rate, amount, deadline, status,
        payment_status, language_pair, remark,
        translators:translator_id ( id, name, email )
      `)
      .eq('id', orderId)
      .single();

    if (orderErr || !order) {
      return corsResponse(404, { error: '订单不存在：' + (orderErr?.message || '') });
    }

    // 仅结算状态 = paid 才发
    if (order.payment_status !== 'paid') {
      return corsResponse(200, {
        success: true,
        skipped: true,
        reason: `payment_status=${order.payment_status}（非 paid，跳过）`,
      });
    }

    tpl = buildTranslatorPaymentEmail({
      order,
      translator: order.translators,
      smtpUser,
    });

    if (!tpl.to) {
      return corsResponse(400, { error: '该订单指派的译员没有邮箱' });
    }

    // A9: 检查译员是否启用了该类通知
    const enabled = await checkPreference(service, tpl.to, 'translator', 'translator_payment');
    if (!enabled) {
      console.log('send-translator-payment-email skipped: translator disabled translator_payment notification:', tpl.to);
      return corsResponse(200, {
        success: true,
        skipped: true,
        reason: '译员已关闭"结算通知"开关',
        to: tpl.to,
      });
    }

    // 发送（connectionTimeout/socketTimeout 由 helper 统一设为 8s）
    const transporter = createEmailTransport();

    const info = await transporter.sendMail({
      from: `"${tpl.fromName}" <${smtpUser}>`,
      to: tpl.to,
      subject: tpl.subject,
      text: tpl.text,
      html: tpl.html,
    });

    console.log('send-translator-payment-email sent:', info.messageId, 'to:', tpl.to);

    return corsResponse(200, {
      success: true,
      messageId: info.messageId,
      to: tpl.to,
    });
  } catch (e) {
    console.error('send-translator-payment-email error:', e);
    await logEmailFailed(service, { orderId, emailType: 'translator_payment', to: tpl?.to, error: e });
    return corsResponse(500, { error: '邮件发送失败：' + e.message });
  }
};