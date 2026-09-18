// netlify/functions/_shared/email-templates.js
// 共享邮件模板（S3）
// 每个模板接收数据，返回 { subject, html, text, to, fromName }
//
// 用法：
//   const t = buildOrderAssignedEmail({ order, translator });
//   await transporter.sendMail({ from: t.fromName + ' <' + smtpUser + '>', to: t.to, subject: t.subject, html: t.html, text: t.text });

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const fmtDateTime = (d) => d ? new Date(d).toLocaleString('zh-CN', { hour12: false }) : '-';
const fmtDate = (d) => d ? String(d).slice(0, 10) : '未指定';

// 共用样式（HTML 邮件用）
const WRAPPER_OPEN = `<div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">`;
const WRAPPER_CLOSE = `</div>`;
const TABLE_STYLE = `style="width: 100%; border-collapse: collapse; background: #fafafa; border-radius: 8px; margin: 20px 0;"`;
const TD_LABEL = `style="padding: 10px; color: #666; width: 30%;"`;
const TD_VALUE = `style="padding: 10px;"`;
const TD_VALUE_BOLD = `style="padding: 10px; font-weight: 600;"`;
const CTA_BUTTON = (url, label) => `<p style="margin: 30px 0;"><a href="${url}" style="background: #1a1a2e; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">${label}</a></p>`;
const FOOTER = (extra = '') => `<hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;"><p style="color: #999; font-size: 12px;">此邮件由谊达翻译系统自动发送，请勿直接回复。<br>如有问题请联系管理员。${extra}</p>`;

// ============================================================
// 模板 1：订单指派通知（管理员指派订单 → 通知译员）
// ============================================================
function buildOrderAssignedEmail({ order, translator, smtpUser }) {
  const translatorName = translator?.name || '译员';
  const translatorEmail = translator?.email;
  const deadlineStr = fmtDate(order.deadline);

  const subject = `【新订单待接单】${order.project_name}（订单号 ${order.id}）`;

  const html = `
    ${WRAPPER_OPEN}
    <h2 style="color: #1a1a2e;">您好 ${escapeHtml(translatorName)}，</h2>
    <p>您有一条新的翻译订单等待接单，请尽快登录系统处理：</p>
    <table ${TABLE_STYLE}>
      <tr><td ${TD_LABEL}>订单号</td><td ${TD_VALUE_BOLD}>${escapeHtml(order.id)}</td></tr>
      <tr><td ${TD_LABEL}>项目名称</td><td ${TD_VALUE_BOLD}>${escapeHtml(order.project_name)}</td></tr>
      <tr><td ${TD_LABEL}>字数</td><td ${TD_VALUE}>${(order.word_count || 0).toLocaleString()} 字</td></tr>
      <tr><td ${TD_LABEL}>单价</td><td ${TD_VALUE}>¥${escapeHtml(order.rate)} / 千字</td></tr>
      <tr><td ${TD_LABEL}>订单总金额</td><td style="padding: 10px; font-weight: 600; color: #cf1322;">¥${escapeHtml(order.amount)}</td></tr>
      <tr><td ${TD_LABEL}>截止日期</td><td style="padding: 10px; font-weight: 600; color: #fa8c16;">${deadlineStr}</td></tr>
      ${order.description ? `<tr><td ${TD_LABEL}>内容描述</td><td ${TD_VALUE}>${escapeHtml(order.description)}</td></tr>` : ''}
      ${order.remark ? `<tr><td ${TD_LABEL}>备注</td><td ${TD_VALUE}>${escapeHtml(order.remark)}</td></tr>` : ''}
    </table>
    ${CTA_BUTTON('https://admin.eadartrans.com/translator/login.html', '立即登录接单')}
    ${FOOTER()}
    ${WRAPPER_CLOSE}
  `;

  const text = `您好 ${translatorName}，

您有一条新的翻译订单待接单：

订单号：${order.id}
项目名称：${order.project_name}
字数：${order.word_count}
单价：¥${order.rate}/千字
订单金额：¥${order.amount}
截止日期：${deadlineStr}
${order.description ? '\n内容描述：' + order.description : ''}
${order.remark ? '\n备注：' + order.remark : ''}

请尽快登录 https://admin.eadartrans.com/translator/login.html 处理。

谊达翻译系统`;

  return {
    subject,
    html,
    text,
    to: translatorEmail,
    fromName: '谊达翻译',
  };
}

// ============================================================
// 模板 2：订单完成通知（译员完成订单 → 通知管理员）
// ============================================================
function buildOrderCompletedEmail({ order, translator, client, smtpUser }) {
  const translatorName = translator?.name || '未指派';
  const clientLabel = client
    ? (client.company_name || client.contact_name)
    : '未关联客户';
  const deadlineStr = fmtDate(order.deadline);
  const completedAt = fmtDateTime(order.updated_at);

  const subject = `【订单已完成】${order.project_name}（订单号 ${order.id}）`;

  const html = `
    ${WRAPPER_OPEN}
    <h2 style="color: #1a1a2e;">订单完成通知</h2>
    <p>译员 <strong>${escapeHtml(translatorName)}</strong> 刚刚完成了订单：</p>
    <table ${TABLE_STYLE}>
      <tr><td ${TD_LABEL}>订单号</td><td ${TD_VALUE_BOLD}>${escapeHtml(order.id)}</td></tr>
      <tr><td ${TD_LABEL}>项目名称</td><td ${TD_VALUE_BOLD}>${escapeHtml(order.project_name)}</td></tr>
      <tr><td ${TD_LABEL}>客户</td><td ${TD_VALUE}>${escapeHtml(clientLabel)}</td></tr>
      <tr><td ${TD_LABEL}>译员</td><td ${TD_VALUE}>${escapeHtml(translatorName)}</td></tr>
      <tr><td ${TD_LABEL}>字数</td><td ${TD_VALUE}>${(order.word_count || 0).toLocaleString()} 字</td></tr>
      <tr><td ${TD_LABEL}>单价</td><td ${TD_VALUE}>¥${escapeHtml(order.rate)} / 千字</td></tr>
      <tr><td ${TD_LABEL}>订单总金额</td><td style="padding: 10px; font-weight: 600; color: #cf1322;">¥${escapeHtml(order.amount)}</td></tr>
      <tr><td ${TD_LABEL}>截止日期</td><td ${TD_VALUE}>${deadlineStr}</td></tr>
      <tr><td ${TD_LABEL}>完成时间</td><td style="padding: 10px; font-weight: 600; color: #52c41a;">${completedAt}</td></tr>
      ${order.remark ? `<tr><td ${TD_LABEL}>译员备注</td><td ${TD_VALUE}>${escapeHtml(order.remark)}</td></tr>` : ''}
    </table>
    ${CTA_BUTTON('https://admin.eadartrans.com/translator/admin/orders.html', '查看订单')}
    ${FOOTER('请尽快登录系统核对译文、安排付款。')}
    ${WRAPPER_CLOSE}
  `;

  const text = `订单完成通知

译员 ${translatorName} 刚刚完成订单：

订单号：${order.id}
项目名称：${order.project_name}
客户：${clientLabel}
译员：${translatorName}
字数：${order.word_count}
单价：¥${order.rate}/千字
订单金额：¥${order.amount}
截止日期：${deadlineStr}
完成时间：${completedAt}
${order.remark ? '\n译员备注：' + order.remark : ''}

请尽快登录 https://admin.eadartrans.com/translator/admin/orders.html 处理。

谊达翻译系统`;

  return {
    subject,
    html,
    text,
    to: smtpUser, // 发给管理员本人
    fromName: '谊达翻译系统',
  };
}

// ============================================================
// 模板 3：订单响应通知（译员接单 → 通知管理员，C4）
// ============================================================
// action: 'accepted'（接单）/ 'rejected'（拒单）
function buildOrderResponseEmail({ order, translator, client, smtpUser, action }) {
  const translatorName = translator?.name || '未指派';
  const clientLabel = client
    ? (client.company_name || client.contact_name)
    : '未关联客户';
  const deadlineStr = fmtDate(order.deadline);
  const respondedAt = fmtDateTime(order.updated_at);

  const isAccepted = action === 'accepted';
  const actionLabel = isAccepted ? '接单' : '拒单';
  const actionColor = isAccepted ? '#52c41a' : '#cf1322';
  const actionVerb = isAccepted ? '接受了' : '拒绝了';

  const subject = `【订单已被${actionLabel}】${order.project_name}（订单号 ${order.id}）—— ${translatorName}`;

  const html = `
    ${WRAPPER_OPEN}
    <h2 style="color: #1a1a2e;">订单响应通知</h2>
    <p>译员 <strong>${escapeHtml(translatorName)}</strong> ${actionVerb}您刚指派的翻译订单：</p>
    <table ${TABLE_STYLE}>
      <tr><td ${TD_LABEL}>订单号</td><td ${TD_VALUE_BOLD}>${escapeHtml(order.id)}</td></tr>
      <tr><td ${TD_LABEL}>项目名称</td><td ${TD_VALUE_BOLD}>${escapeHtml(order.project_name)}</td></tr>
      <tr><td ${TD_LABEL}>客户</td><td ${TD_VALUE}>${escapeHtml(clientLabel)}</td></tr>
      <tr><td ${TD_LABEL}>译员</td><td ${TD_VALUE}>${escapeHtml(translatorName)}</td></tr>
      <tr><td ${TD_LABEL}>响应动作</td><td style="padding: 10px; font-weight: 600; color: ${actionColor};">${actionLabel}</td></tr>
      <tr><td ${TD_LABEL}>字数</td><td ${TD_VALUE}>${(order.word_count || 0).toLocaleString()} 字</td></tr>
      <tr><td ${TD_LABEL}>单价</td><td ${TD_VALUE}>¥${escapeHtml(order.rate)} / 千字</td></tr>
      <tr><td ${TD_LABEL}>订单总金额</td><td style="padding: 10px; font-weight: 600; color: #cf1322;">¥${escapeHtml(order.amount)}</td></tr>
      <tr><td ${TD_LABEL}>截止日期</td><td ${TD_VALUE}>${deadlineStr}</td></tr>
      <tr><td ${TD_LABEL}>响应时间</td><td style="padding: 10px; font-weight: 600;">${respondedAt}</td></tr>
      ${order.remark && !isAccepted ? `<tr><td ${TD_LABEL}>拒单理由</td><td ${TD_VALUE}>${escapeHtml(order.remark)}</td></tr>` : ''}
    </table>
    ${isAccepted
      ? FOOTER('译员已开始翻译，请关注交付进度。')
      : FOOTER('该订单被拒，请考虑指派其他译员或跟进客户。')}
    ${WRAPPER_CLOSE}
  `;

  const text = `订单响应通知

译员 ${translatorName} ${actionVerb}您刚指派的翻译订单：

订单号：${order.id}
项目名称：${order.project_name}
客户：${clientLabel}
译员：${translatorName}
响应动作：${actionLabel}
字数：${order.word_count}
单价：¥${order.rate}/千字
订单金额：¥${order.amount}
截止日期：${deadlineStr}
响应时间：${respondedAt}
${(order.remark && !isAccepted) ? '\n拒单理由：' + order.remark : ''}

${isAccepted ? '译员已开始翻译，请关注交付进度。' : '该订单被拒，请考虑指派其他译员或跟进客户。'}

谊达翻译系统`;

  return {
    subject,
    html,
    text,
    to: smtpUser, // 发给管理员本人
    fromName: '谊达翻译系统',
  };
}

// ============================================================
// 模板列表（便于未来扩展）
// ============================================================
const TEMPLATES = {
  ORDER_ASSIGNED: buildOrderAssignedEmail,
  ORDER_COMPLETED: buildOrderCompletedEmail,
  ORDER_RESPONSE: buildOrderResponseEmail,
};

module.exports = {
  TEMPLATES,
  buildOrderAssignedEmail,
  buildOrderCompletedEmail,
  buildOrderResponseEmail,
};