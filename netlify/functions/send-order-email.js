// netlify/functions/send-order-email.js
// 内部接口：发送订单通知邮件给指派译员
// 由 save-order.js 在订单创建成功后异步触发
//
// 环境变量（在 .env / Netlify 环境配置）：
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate } = require('./_shared/auth');
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
        created_at, remark,
        translators:translator_id ( id, name, email )
      `)
      .eq('id', orderId)
      .single();

    if (orderErr || !order) {
      return corsResponse(404, { error: '订单不存在：' + (orderErr?.message || '') });
    }

    const translatorEmail = order.translators?.email;
    const translatorName = order.translators?.name || '译员';
    if (!translatorEmail) {
      return corsResponse(400, { error: '该订单指派的译员没有邮箱' });
    }

    // 构建邮件内容
    const subject = `【新订单待接单】${order.project_name}（订单号 ${order.id}）`;

    const fmt = (d) => d ? new Date(d).toLocaleString('zh-CN', { hour12: false }) : '-';
    const deadlineStr = order.deadline ? String(order.deadline).slice(0, 10) : '未指定';

    const html = `
      <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
        <h2 style="color: #1a1a2e;">您好 ${translatorName}，</h2>
        <p>您有一条新的翻译订单等待接单，请尽快登录系统处理：</p>

        <table style="width: 100%; border-collapse: collapse; background: #fafafa; border-radius: 8px; margin: 20px 0;">
          <tr><td style="padding: 10px; color: #666; width: 30%;">订单号</td><td style="padding: 10px; font-weight: 600;">${order.id}</td></tr>
          <tr><td style="padding: 10px; color: #666;">项目名称</td><td style="padding: 10px; font-weight: 600;">${order.project_name}</td></tr>
          <tr><td style="padding: 10px; color: #666;">字数</td><td style="padding: 10px;">${order.word_count.toLocaleString()} 字</td></tr>
          <tr><td style="padding: 10px; color: #666;">单价</td><td style="padding: 10px;">¥${order.rate} / 千字</td></tr>
          <tr><td style="padding: 10px; color: #666;">订单总金额</td><td style="padding: 10px; font-weight: 600; color: #cf1322;">¥${order.amount}</td></tr>
          <tr><td style="padding: 10px; color: #666;">截止日期</td><td style="padding: 10px; font-weight: 600; color: #fa8c16;">${deadlineStr}</td></tr>
          ${order.description ? `<tr><td style="padding: 10px; color: #666;">内容描述</td><td style="padding: 10px;">${order.description}</td></tr>` : ''}
          ${order.remark ? `<tr><td style="padding: 10px; color: #666;">备注</td><td style="padding: 10px;">${order.remark}</td></tr>` : ''}
        </table>

        <p style="margin: 30px 0;">
          👉 <a href="https://admin.eadartrans.com/translator/login.html" style="background: #1a1a2e; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">立即登录接单</a>
        </p>

        <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;">
        <p style="color: #999; font-size: 12px;">
          此邮件由谊达翻译系统自动发送，请勿直接回复。<br>
          如有问题请联系管理员。<br>
          发送时间：${fmt(order.created_at || new Date())}
        </p>
      </div>
    `;

    const text = `您好 ${translatorName}，\n\n您有一条新的翻译订单待接单：\n\n订单号：${order.id}\n项目名称：${order.project_name}\n字数：${order.word_count}\n单价：¥${order.rate}/千字\n订单金额：¥${order.amount}\n截止日期：${deadlineStr}\n${order.description ? '\n内容描述：' + order.description : ''}\n${order.remark ? '\n备注：' + order.remark : ''}\n\n请尽快登录 https://admin.eadartrans.com/translator/login.html 处理。\n\n谊达翻译系统`;

    // 发送
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465, // 465 用 SSL，587 用 STARTTLS
      auth: { user: smtpUser, pass: smtpPass },
    });

    const info = await transporter.sendMail({
      from: `"谊达翻译" <${smtpUser}>`,
      to: translatorEmail,
      subject: subject,
      text: text,
      html: html,
    });

    console.log('send-order-email sent:', info.messageId, 'to:', translatorEmail);

    return corsResponse(200, {
      success: true,
      messageId: info.messageId,
      to: translatorEmail,
    });
  } catch (e) {
    console.error('send-order-email error:', e);
    return corsResponse(500, { error: '邮件发送失败：' + e.message });
  }
};
