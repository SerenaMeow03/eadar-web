// netlify/functions/send-batch-order-email.js
// 内部接口：批量派单后给译员发一封汇总通知邮件
// 由 admin/orders.html 在 batch-assign-orders 成功后触发
//
// 设计：一封邮件内列出所有新订单简表（订单号 + 项目名 + 字数 + 截止日期 + 语言对）
// 避免一个订单一封邮件淹没译员收件箱

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate } = require('./_shared/auth');
const { buildBatchOrderAssignedEmail } = require('./_shared/email-templates');
const { checkPreference } = require('./_shared/notifications');
const nodemailer = require('nodemailer');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  if (event.httpMethod !== 'POST') {
    return corsResponse(405, { error: 'Method not allowed' });
  }

  const auth = await authenticate(event, 'admin');
  if (auth.error) return auth.error;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return corsResponse(400, { error: 'Invalid JSON' }); }

  const { orderIds } = body;
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return corsResponse(400, { error: 'orderIds[] 必填且非空' });
  }

  // SMTP 配置检查
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = Number(process.env.SMTP_PORT || 465);
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpHost || !smtpUser || !smtpPass) {
    return corsResponse(500, { error: 'SMTP 未配置' });
  }

  const service = getServiceClient();

  try {
    // 一次查所有订单（统一走 translator_id 拿派单译员）
    const { data: orders, error: orderErr } = await service
      .from('orders')
      .select(`
        id, project_name, word_count, rate, amount, deadline, status, language_pair,
        translators:translator_id ( id, name, email )
      `)
      .in('id', orderIds);

    if (orderErr) {
      console.error('send-batch-order-email fetch error:', orderErr);
      return corsResponse(500, { error: orderErr.message });
    }

    if (!orders || orders.length === 0) {
      return corsResponse(404, { error: '未找到任何订单' });
    }

    // 用第一个订单的译员当收件人（业务上批量派单必然是同一个译员）
    const translator = orders[0].translators;
    if (!translator?.email) {
      return corsResponse(400, { error: '订单指派的译员没有邮箱' });
    }

    // A9: 检查译员是否启用了 order_assigned 通知（批量派单共享一次检查）
    const enabled = await checkPreference(service, translator.email, 'translator', 'order_assigned');
    if (!enabled) {
      console.log('send-batch-order-email skipped: translator disabled order_assigned notification:', translator.email);
      return corsResponse(200, {
        success: true,
        skipped: true,
        reason: '译员已关闭"订单分配"通知',
        count: orders.length,
        to: translator.email,
      });
    }

    // 渲染模板
    const tpl = buildBatchOrderAssignedEmail({
      orders,
      translator,
      smtpUser,
    });

    // 发送
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });

    const info = await transporter.sendMail({
      from: `"${tpl.fromName}" <${smtpUser}>`,
      to: tpl.to,
      subject: tpl.subject,
      text: tpl.text,
      html: tpl.html,
    });

    console.log('send-batch-order-email sent:', info.messageId, 'count:', orders.length, 'to:', tpl.to);

    return corsResponse(200, {
      success: true,
      messageId: info.messageId,
      count: orders.length,
      to: tpl.to,
    });
  } catch (e) {
    console.error('send-batch-order-email error:', e);
    return corsResponse(500, { error: '邮件发送失败：' + e.message });
  }
};