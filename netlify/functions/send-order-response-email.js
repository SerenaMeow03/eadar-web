// netlify/functions/send-order-response-email.js
// 内部接口：发送译员接单/拒单通知邮件给管理员
// 由 update-order-status.js 在 pending → progress 转换后异步触发
//
// 鉴权：translator 或 admin 都可触发（内部接口）
//
// S3 重构：邮件内容由 _shared/email-templates.js 统一管理
// C4 重构：admin 接收译员响应（接单/拒单）的 order_response 通知

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate } = require('./_shared/auth');
const { buildOrderResponseEmail } = require('./_shared/email-templates');
const { checkPreference } = require('./_shared/notifications');
const nodemailer = require('nodemailer');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  if (event.httpMethod !== 'POST') {
    return corsResponse(405, { error: 'Method not allowed' });
  }

  // 鉴权：译员或管理员都可触发
  const auth = await authenticate(event);
  if (auth.error) return auth.error;
  if (!['translator', 'admin'].includes(auth.role)) {
    return corsResponse(403, { error: '无权访问' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return corsResponse(400, { error: 'Invalid JSON' }); }

  const { orderId, action } = body;
  if (!orderId) {
    return corsResponse(400, { error: 'orderId 必填' });
  }
  if (!['accepted', 'rejected'].includes(action)) {
    return corsResponse(400, { error: 'action 必须是 accepted 或 rejected' });
  }

  // SMTP 配置
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = Number(process.env.SMTP_PORT || 465);
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpHost || !smtpUser || !smtpPass) {
    return corsResponse(500, { error: 'SMTP 未配置' });
  }

  const service = getServiceClient();

  try {
    // 查询订单 + 译员 + 客户
    const { data: order, error: orderErr } = await service
      .from('orders')
      .select(`
        id, project_name, word_count, rate, amount, deadline, status, remark,
        updated_at, description,
        translators:translator_id ( id, name, email ),
        clients:client_id ( contact_name, company_name )
      `)
      .eq('id', orderId)
      .single();

    if (orderErr || !order) {
      return corsResponse(404, { error: '订单不存在' });
    }

    // 调用共享模板（C4）
    const tpl = buildOrderResponseEmail({
      order,
      translator: order.translators,
      client: order.clients,
      smtpUser,
      action,
    });

    // A9: 检查管理员是否启用了该类通知
    const enabled = await checkPreference(service, tpl.to, 'admin', 'order_response');
    if (!enabled) {
      console.log('send-order-response-email skipped: admin disabled order_response notification:', tpl.to);
      return corsResponse(200, {
        success: true,
        skipped: true,
        reason: '管理员已关闭"译员响应派单"通知',
      });
    }

    // 发送
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });

    const info = await transporter.sendMail({
      from: `"${tpl.fromName}" <${smtpUser}>`,
      to: tpl.to, // 发给管理员本人（serena@eadartrans.com）
      subject: tpl.subject,
      text: tpl.text,
      html: tpl.html,
    });

    console.log('send-order-response-email sent:', info.messageId, 'action:', action);

    return corsResponse(200, {
      success: true,
      messageId: info.messageId,
    });
  } catch (e) {
    console.error('send-order-response-email error:', e);
    return corsResponse(500, { error: '邮件发送失败：' + e.message });
  }
};