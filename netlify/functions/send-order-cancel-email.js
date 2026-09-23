// netlify/functions/send-order-cancel-email.js
// 内部接口：发送订单取消通知邮件给译员（C6）
// 由 update-order-status.js 在 admin 把订单改为 cancelled 时触发
//
// 触发条件：admin 把 progress/completed 改为 cancelled
// 不触发：pending → cancelled（译员没接单不知道，没必要打扰）
//
// 鉴权：translator 或 admin 都可触发（内部接口）

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate } = require('./_shared/auth');
const { buildOrderCancelledEmail } = require('./_shared/email-templates');
const { checkPreference } = require('./_shared/notifications');
const { logEmailFailed } = require('./_shared/email-log');
const nodemailer = require('nodemailer');

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

  const { orderId, previousStatus } = body;
  if (!orderId) {
    return corsResponse(400, { error: 'orderId 必填' });
  }
  if (!['progress', 'completed'].includes(previousStatus)) {
    // 防御：pending → cancelled 不通知译员
    return corsResponse(200, { data: { skipped: true, reason: 'pending status, no notify needed' } });
  }

  const service = getServiceClient();

  try {
    // 1. 查订单 + 关联译员
    const { data: order, error: fetchErr } = await service
      .from('orders')
      .select(`
        id, project_name, word_count, rate, amount, deadline,
        status, remark, language_pair,
        translators:translator_id ( id, name, email )
      `)
      .eq('id', orderId)
      .single();

    if (fetchErr || !order) {
      console.error('[send-order-cancel-email] order not found:', orderId);
      return corsResponse(404, { error: '订单不存在' });
    }

    const translator = order.translators;
    if (!translator || !translator.email) {
      console.warn('[send-order-cancel-email] no translator/email for order', orderId);
      return corsResponse(200, { data: { skipped: true, reason: 'no translator email' } });
    }

    // 2. 检查译员偏好（order_cancelled 开关）
    const enabled = await checkPreference(service, 'translator', translator.email, 'order_cancelled');
    if (!enabled) {
      console.log('[send-order-cancel-email] skipped: translator disabled order_cancelled notification:', translator.email);
      return corsResponse(200, { data: { skipped: true, reason: 'translator disabled order_cancelled notification' } });
    }

    // 3. 构造邮件
    const tpl = buildOrderCancelledEmail({
      order: { ...order, previous_status: previousStatus },
      translator,
      smtpUser: process.env.SMTP_USER,
    });

    // 4. 发送
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = Number(process.env.SMTP_PORT || 465);
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;

    if (!smtpHost || !smtpUser || !smtpPass) {
      return corsResponse(500, { error: 'SMTP 未配置' });
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });

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
        emailType: 'order_cancelled',
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
