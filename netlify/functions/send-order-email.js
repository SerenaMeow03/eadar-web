// netlify/functions/send-order-email.js
// 内部接口：发送订单通知邮件给指派译员
// 由 save-order.js 在订单创建成功后异步触发
//
// S3 重构：邮件内容由 _shared/email-templates.js 统一管理

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate } = require('./_shared/auth');
const { buildOrderAssignedEmail } = require('./_shared/email-templates');
const { checkPreference } = require('./_shared/notifications');
const nodemailer = require('nodemailer');

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
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = Number(process.env.SMTP_PORT || 465);
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpHost || !smtpUser || !smtpPass) {
    return corsResponse(500, { error: 'SMTP 未配置（SMTP_HOST/SMTP_USER/SMTP_PASS 缺失）' });
  }

  const service = getServiceClient();

  try {
    // 查询订单 + 关联译员邮箱
    const { data: order, error: orderErr } = await service
      .from('orders')
      .select(`
        id, project_name, word_count, rate, amount, deadline, status, description,
        language_pair,
        created_at, remark,
        translators:translator_id ( id, name, email )
      `)
      .eq('id', orderId)
      .single();

    if (orderErr || !order) {
      return corsResponse(404, { error: '订单不存在：' + (orderErr?.message || '') });
    }

    // 调用共享模板（S3）
    const tpl = buildOrderAssignedEmail({
      order,
      translator: order.translators,
      smtpUser,
    });

    if (!tpl.to) {
      return corsResponse(400, { error: '该订单指派的译员没有邮箱' });
    }

    // A9: 检查译员是否启用了该类通知（role=translator 是收件人固定角色）
    const enabled = await checkPreference(service, tpl.to, 'translator', 'order_assigned');
    if (!enabled) {
      console.log('send-order-email skipped: translator disabled order_assigned notification:', tpl.to);
      return corsResponse(200, {
        success: true,
        skipped: true,
        reason: '译员已关闭"订单分配"通知',
        to: tpl.to,
      });
    }

    // 发送
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465, // 465 用 SSL，587 用 STARTTLS
      auth: { user: smtpUser, pass: smtpPass },
    });

    const info = await transporter.sendMail({
      from: `"${tpl.fromName}" <${smtpUser}>`,
      to: tpl.to,
      subject: tpl.subject,
      text: tpl.text,
      html: tpl.html,
    });

    console.log('send-order-email sent:', info.messageId, 'to:', tpl.to);

    return corsResponse(200, {
      success: true,
      messageId: info.messageId,
      to: tpl.to,
    });
  } catch (e) {
    console.error('send-order-email error:', e);
    return corsResponse(500, { error: '邮件发送失败：' + e.message });
  }
};