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

// 语言对显示映射（与 admin/orders.html LANGS 对齐）
const LANG_LABELS = {
  'zh-en': '中→英', 'en-zh': '英→中',
  'zh-ja': '中→日', 'en-ja': '英→日',
  'zh-ko': '中→韩', 'en-ko': '英→韩',
  'zh-ar': '中→阿', 'zh-ru': '中→俄',
};
const fmtLang = (code) => LANG_LABELS[code] || code || '未指定';

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
  const langStr = fmtLang(order.language_pair);

  const subject = `【新订单待接单】${order.project_name}（订单号 ${order.id}）`;

  const html = `
    ${WRAPPER_OPEN}
    <h2 style="color: #1a1a2e;">您好 ${escapeHtml(translatorName)}，</h2>
    <p>您有一条新的翻译订单等待接单，请尽快登录系统处理：</p>
    <table ${TABLE_STYLE}>
      <tr><td ${TD_LABEL}>订单号</td><td ${TD_VALUE_BOLD}>${escapeHtml(order.id)}</td></tr>
      <tr><td ${TD_LABEL}>项目名称</td><td ${TD_VALUE_BOLD}>${escapeHtml(order.project_name)}</td></tr>
      <tr><td ${TD_LABEL}>语言对</td><td ${TD_VALUE_BOLD}>${escapeHtml(langStr)}</td></tr>
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
语言对：${langStr}
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
  const langStr = fmtLang(order.language_pair);
  // v7：客户字数与译员字数分开；客户未填时 fallback 到 word_count
  const clientWordCount = order.client_word_count ?? order.word_count ?? 0;
  const clientRate = order.client_rate;
  const clientAmount = order.client_amount;

  const subject = `【订单已完成】${order.project_name}（订单号 ${order.id}）`;

  const html = `
    ${WRAPPER_OPEN}
    <h2 style="color: #1a1a2e;">订单完成通知</h2>
    <p>译员 <strong>${escapeHtml(translatorName)}</strong> 刚刚完成了订单：</p>
    <table ${TABLE_STYLE}>
      <tr><td ${TD_LABEL}>订单号</td><td ${TD_VALUE_BOLD}>${escapeHtml(order.id)}</td></tr>
      <tr><td ${TD_LABEL}>项目名称</td><td ${TD_VALUE_BOLD}>${escapeHtml(order.project_name)}</td></tr>
      <tr><td ${TD_LABEL}>语言对</td><td ${TD_VALUE}>${escapeHtml(langStr)}</td></tr>
      <tr><td ${TD_LABEL}>客户</td><td ${TD_VALUE}>${escapeHtml(clientLabel)}</td></tr>
      <tr><td ${TD_LABEL}>译员</td><td ${TD_VALUE}>${escapeHtml(translatorName)}</td></tr>
      <tr><td ${TD_LABEL}>字数（译员）</td><td ${TD_VALUE}>${(order.word_count || 0).toLocaleString()} 字</td></tr>
      <tr><td ${TD_LABEL}>单价</td><td ${TD_VALUE}>¥${escapeHtml(order.rate)} / 千字</td></tr>
      <tr><td ${TD_LABEL}>译员金额</td><td style="padding: 10px; font-weight: 600; color: #cf1322;">¥${escapeHtml(order.amount)}</td></tr>
      ${client && clientRate ? `
        <tr><td ${TD_LABEL}>字数（客户）</td><td ${TD_VALUE}>${clientWordCount.toLocaleString()} 字</td></tr>
        <tr><td ${TD_LABEL}>客户单价</td><td ${TD_VALUE}>¥${escapeHtml(clientRate)} / 千字</td></tr>
        <tr><td ${TD_LABEL}>客户金额</td><td style="padding: 10px; font-weight: 600; color: #cf1322;">¥${escapeHtml(clientAmount)}</td></tr>
      ` : ''}
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
字数（译员）：${order.word_count}
单价：¥${order.rate}/千字
译员金额：¥${order.amount}
${client && clientRate ? `\n字数（客户）：${clientWordCount}\n客户单价：¥${clientRate}/千字\n客户金额：¥${clientAmount}` : ''}
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
  // v7：客户字数与译员字数分开
  const clientWordCount = order.client_word_count ?? order.word_count ?? 0;
  const clientRate = order.client_rate;
  const clientAmount = order.client_amount;

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
      <tr><td ${TD_LABEL}>字数（译员）</td><td ${TD_VALUE}>${(order.word_count || 0).toLocaleString()} 字</td></tr>
      <tr><td ${TD_LABEL}>单价</td><td ${TD_VALUE}>¥${escapeHtml(order.rate)} / 千字</td></tr>
      <tr><td ${TD_LABEL}>译员金额</td><td style="padding: 10px; font-weight: 600; color: #cf1322;">¥${escapeHtml(order.amount)}</td></tr>
      ${client && clientRate ? `
        <tr><td ${TD_LABEL}>字数（客户）</td><td ${TD_VALUE}>${clientWordCount.toLocaleString()} 字</td></tr>
        <tr><td ${TD_LABEL}>客户单价</td><td ${TD_VALUE}>¥${escapeHtml(clientRate)} / 千字</td></tr>
        <tr><td ${TD_LABEL}>客户金额</td><td style="padding: 10px; font-weight: 600; color: #cf1322;">¥${escapeHtml(clientAmount)}</td></tr>
      ` : ''}
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
字数（译员）：${order.word_count}
单价：¥${order.rate}/千字
译员金额：¥${order.amount}
${client && clientRate ? `\n字数（客户）：${clientWordCount}\n客户单价：¥${clientRate}/千字\n客户金额：¥${clientAmount}` : ''}
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
// 模板 4：批量派单通知（admin 一次派多个订单 → 一封汇总邮件给译员）
// ============================================================
function buildBatchOrderAssignedEmail({ orders, translator, smtpUser }) {
  const translatorName = translator?.name || '译员';
  const translatorEmail = translator?.email;
  const count = orders.length;

  const subject = `【${count} 个新订单待接单】谊达翻译批量派单通知`;

  // 订单表格行（每条一行）
  const orderRowsHtml = orders.map(o => `
    <tr>
      <td style="padding: 10px; font-weight: 600; font-family: monospace;">${escapeHtml(o.id)}</td>
      <td style="padding: 10px;">${escapeHtml(o.project_name)}</td>
      <td style="padding: 10px;">${escapeHtml(fmtLang(o.language_pair))}</td>
      <td style="padding: 10px; text-align: right;">${(o.word_count || 0).toLocaleString()} 字</td>
      <td style="padding: 10px; text-align: right; color: #cf1322; font-weight: 600;">¥${escapeHtml(o.amount)}</td>
      <td style="padding: 10px; color: #fa8c16; font-weight: 600;">${fmtDate(o.deadline)}</td>
    </tr>
  `).join('');

  const orderRowsText = orders.map(o =>
    `  ${o.id} | ${o.project_name} | ${fmtLang(o.language_pair)} | ${o.word_count}字 | ¥${o.amount} | 截止 ${fmtDate(o.deadline)}`
  ).join('\n');

  const html = `
    ${WRAPPER_OPEN}
    <h2 style="color: #1a1a2e;">您好 ${escapeHtml(translatorName)}，</h2>
    <p>管理员刚刚给您一次性指派了 <strong style="color: #cf1322;">${count}</strong> 个翻译订单，请尽快登录系统处理：</p>
    <table style="width: 100%; border-collapse: collapse; background: #fafafa; border-radius: 8px; margin: 20px 0; font-size: 13px;">
      <thead>
        <tr style="background: #f0f0f0;">
          <th style="padding: 10px; text-align: left;">订单号</th>
          <th style="padding: 10px; text-align: left;">项目名称</th>
          <th style="padding: 10px; text-align: left;">语言对</th>
          <th style="padding: 10px; text-align: right;">字数</th>
          <th style="padding: 10px; text-align: right;">金额</th>
          <th style="padding: 10px; text-align: left;">截止日期</th>
        </tr>
      </thead>
      <tbody>${orderRowsHtml}</tbody>
    </table>
    <p style="color: #666; font-size: 13px;">💡 提示：登录后逐个点击「接单」按钮即可开始翻译。</p>
    ${CTA_BUTTON('https://admin.eadartrans.com/translator/login.html', '立即登录接单')}
    ${FOOTER()}
    ${WRAPPER_CLOSE}
  `;

  const text = `您好 ${translatorName}，

管理员一次性给您派了 ${count} 个新订单：

${orderRowsText}

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
// 模板 5：客户欢迎邮件（admin 创建客户 → 通知客户）
// ============================================================
function buildClientWelcomeEmail({ client, tempPassword, smtpUser }) {
  const name = client?.contact_name || '客户';
  const company = client?.company_name || '';
  const loginUrl = 'https://admin.eadartrans.com/portal/client/login.html';

  const subject = `【欢迎加入谊达翻译】您的账号已开通`;

  const html = `
    ${WRAPPER_OPEN}
    <h2 style="color: #1a1a2e;">您好 ${escapeHtml(name)}，</h2>
    <p>欢迎使用谊达翻译订单管理系统！您的账号已由管理员开通：</p>
    <table ${TABLE_STYLE}>
      ${company ? `<tr><td ${TD_LABEL}>公司名称</td><td ${TD_VALUE_BOLD}>${escapeHtml(company)}</td></tr>` : ''}
      <tr><td ${TD_LABEL}>联系人</td><td ${TD_VALUE_BOLD}>${escapeHtml(name)}</td></tr>
      <tr><td ${TD_LABEL}>登录邮箱</td><td ${TD_VALUE}>${escapeHtml(client.email)}</td></tr>
      <tr><td ${TD_LABEL}>初始密码</td><td style="padding: 10px; font-family: monospace; font-weight: 600; color: #cf1322; background: #fff7e6;">${escapeHtml(tempPassword)}</td></tr>
    </table>
    <p style="background: #fffbe6; border: 1px solid #ffe58f; padding: 12px; border-radius: 6px; color: #ad6800;">
      ⚠️ <strong>首次登录后请尽快修改密码</strong>（进入「仪表盘」→「修改密码」）。
    </p>
    <p>登录后可查看分配给您的所有翻译订单、跟踪进度、确认付款状态。</p>
    ${CTA_BUTTON(loginUrl, '立即登录')}
    ${FOOTER('如有任何问题，请联系您的项目对接人。')}
    ${WRAPPER_CLOSE}
  `;

  const text = `您好 ${name}，

欢迎使用谊达翻译订单管理系统！您的账号已开通：

${company ? '公司名称：' + company + '\n' : ''}联系人：${name}
登录邮箱：${client.email}
初始密码：${tempPassword}

⚠️ 首次登录后请尽快修改密码（仪表盘 → 修改密码）。

登录地址：${loginUrl}

如有问题请联系您的项目对接人。

谊达翻译`;

  return {
    subject,
    html,
    text,
    to: client.email,
    fromName: '谊达翻译',
  };
}

// ============================================================
// 模板 6：译员欢迎邮件（admin 创建译员 → 通知译员）
// ============================================================
function buildTranslatorWelcomeEmail({ translator, password, smtpUser }) {
  const name = translator?.name || translator?.email?.split('@')[0] || '译员';
  const langs = (translator?.languages || []).map(fmtLang).filter(Boolean).join('、') || '待补充';
  const loginUrl = 'https://admin.eadartrans.com/portal/translator/login.html';

  const subject = `【欢迎加入谊达翻译译员团队】您的账号已开通`;

  const html = `
    ${WRAPPER_OPEN}
    <h2 style="color: #1a1a2e;">您好 ${escapeHtml(name)}，</h2>
    <p>欢迎加入谊达翻译译员团队！您的账号已由管理员开通：</p>
    <table ${TABLE_STYLE}>
      <tr><td ${TD_LABEL}>姓名</td><td ${TD_VALUE_BOLD}>${escapeHtml(name)}</td></tr>
      <tr><td ${TD_LABEL}>登录邮箱</td><td ${TD_VALUE}>${escapeHtml(translator.email)}</td></tr>
      <tr><td ${TD_LABEL}>语种</td><td ${TD_VALUE}>${escapeHtml(langs)}</td></tr>
      <tr><td ${TD_LABEL}>初始密码</td><td style="padding: 10px; font-family: monospace; font-weight: 600; color: #cf1322; background: #fff7e6;">${escapeHtml(password)}</td></tr>
    </table>
    <p style="background: #fffbe6; border: 1px solid #ffe58f; padding: 12px; border-radius: 6px; color: #ad6800;">
      ⚠️ <strong>首次登录后请尽快修改密码</strong>（进入「我的资料」→「修改密码」）。
    </p>
    <p>登录后可查看分配给您的所有翻译订单、接单、提交完成。</p>
    <p style="color: #666; font-size: 13px;">💡 建议在「通知偏好」中开启「新订单通知」开关，确保第一时间收到派单通知。</p>
    ${CTA_BUTTON(loginUrl, '立即登录')}
    ${FOOTER('如有任何问题，请联系管理员。')}
    ${WRAPPER_CLOSE}
  `;

  const text = `您好 ${name}，

欢迎加入谊达翻译译员团队！您的账号已开通：

姓名：${name}
登录邮箱：${translator.email}
语种：${langs}
初始密码：${password}

⚠️ 首次登录后请尽快修改密码（我的资料 → 修改密码）。

登录地址：${loginUrl}

💡 建议在「通知偏好」中开启「新订单通知」开关。

如有问题请联系管理员。

谊达翻译`;

  return {
    subject,
    html,
    text,
    to: translator.email,
    fromName: '谊达翻译',
  };
}

// ============================================================
// 模板 7：结算通知（admin 改已结算 → 通知译员 C5）
// ============================================================
function buildTranslatorPaymentEmail({ order, translator, smtpUser }) {
  const translatorName = translator?.name || '译员';
  const translatorEmail = translator?.email;
  const deadlineStr = fmtDate(order.deadline);
  const paidAt = fmtDateTime(new Date().toISOString());

  const subject = `【结算通知】${order.project_name}（订单号 ${order.id}）已结算 ¥${order.amount}`;

  const html = `
    ${WRAPPER_OPEN}
    <h2 style="color: #1a1a2e;">您好 ${escapeHtml(translatorName)}，</h2>
    <p>您负责的翻译订单已完成结算，结算金额已记录到系统：</p>
    <table ${TABLE_STYLE}>
      <tr><td ${TD_LABEL}>订单号</td><td ${TD_VALUE_BOLD}>${escapeHtml(order.id)}</td></tr>
      <tr><td ${TD_LABEL}>项目名称</td><td ${TD_VALUE_BOLD}>${escapeHtml(order.project_name)}</td></tr>
      <tr><td ${TD_LABEL}>字数</td><td ${TD_VALUE}>${(order.word_count || 0).toLocaleString()} 字</td></tr>
      <tr><td ${TD_LABEL}>单价</td><td ${TD_VALUE}>¥${escapeHtml(order.rate)} / 千字</td></tr>
      <tr><td ${TD_LABEL}>结算金额</td><td style="padding: 10px; font-weight: 600; color: #52c41a;">¥${escapeHtml(order.amount)}</td></tr>
      <tr><td ${TD_LABEL}>截止日期</td><td ${TD_VALUE}>${deadlineStr}</td></tr>
      <tr><td ${TD_LABEL}>结算时间</td><td style="padding: 10px; font-weight: 600; color: #52c41a;">${paidAt}</td></tr>
      ${order.remark ? `<tr><td ${TD_LABEL}>备注</td><td ${TD_VALUE}>${escapeHtml(order.remark)}</td></tr>` : ''}
    </table>
    <p style="background: #f6ffed; border: 1px solid #b7eb8f; padding: 12px; border-radius: 6px; color: #389e0d;">
      ✅ <strong>结算已确认</strong>，请关注银行到账信息。如对结算金额有疑问，请尽快联系对接人核对。
    </p>
    ${FOOTER('本邮件由谊达翻译系统自动发送，仅作为结算通知。')}
    ${WRAPPER_CLOSE}
  `;

  const text = `您好 ${translatorName}，

您负责的翻译订单已完成结算：

订单号：${order.id}
项目名称：${order.project_name}
字数：${order.word_count}
单价：¥${order.rate}/千字
结算金额：¥${order.amount}
截止日期：${deadlineStr}
结算时间：${paidAt}
${order.remark ? '\n备注：' + order.remark : ''}

✅ 结算已确认，请关注银行到账信息。如对结算金额有疑问，请尽快联系对接人核对。

谊达翻译系统`;

  return {
    subject,
    html,
    text,
    to: translatorEmail,
    fromName: '谊达翻译系统',
  };
}

// ============================================================
// 模板：订单收回通知（admin 收回已接订单 → 通知原译员 C7）
// ============================================================
// 触发条件：save-order.js（admin 把 progress 改回 pending，或连续改派 progress→progress + translator 变）
// 不触发：pending → pending（无效）；completed → pending（已完成被收回是 admin 误操作）
// 注：C6（订单取消）已砍——业务上订单必须推进直到完成，没有 cancelled 状态流转
// 注：2026-09-24 批量派单功能作废（send-batch-order-email.js 已删除）
function buildOrderRecalledEmail({ order, translator, smtpUser }) {
  const translatorName = translator?.name || '译员';
  const translatorEmail = translator?.email;
  const deadlineStr = fmtDate(order.deadline);
  const recalledAt = fmtDateTime(new Date().toISOString());

  const subject = `【订单已收回】${order.project_name}（订单号 ${order.id}）`;

  const html = `
    ${WRAPPER_OPEN}
    <h2 style="color: #1a1a2e;">您好 ${escapeHtml(translatorName)}，</h2>
    <p>您原本已接单的翻译订单被管理员收回，回到「待派单」状态。如已开工请暂停翻译，避免做无效工作。</p>
    <table ${TABLE_STYLE}>
      <tr><td ${TD_LABEL}>订单号</td><td ${TD_VALUE_BOLD}>${escapeHtml(order.id)}</td></tr>
      <tr><td ${TD_LABEL}>项目名称</td><td ${TD_VALUE_BOLD}>${escapeHtml(order.project_name)}</td></tr>
      <tr><td ${TD_LABEL}>字数</td><td ${TD_VALUE}>${(order.word_count || 0).toLocaleString()} 字</td></tr>
      <tr><td ${TD_LABEL}>原计划金额</td><td ${TD_VALUE}>¥${escapeHtml(order.amount)}</td></tr>
      <tr><td ${TD_LABEL}>原截止日期</td><td ${TD_VALUE}>${deadlineStr}</td></tr>
      <tr><td ${TD_LABEL}>收回时间</td><td style="padding: 10px; font-weight: 600; color: #d46b08;">${recalledAt}</td></tr>
      ${order.remark ? `<tr><td ${TD_LABEL}>备注</td><td ${TD_VALUE}>${escapeHtml(order.remark)}</td></tr>` : ''}
    </table>
    <p style="background: #fff7e6; border: 1px solid #ffd591; padding: 12px; border-radius: 6px; color: #ad6800;">
      ⚠️ <strong>该订单已被收回</strong>，请暂停翻译工作，等待进一步通知。
    </p>
    <p style="color: #666; font-size: 13px;">💡 如对收回有疑问，请及时联系对接人。</p>
    ${FOOTER()}
    ${WRAPPER_CLOSE}
  `;

  const text = `您好 ${translatorName}，

您原本已接单的翻译订单被管理员收回，回到「待派单」状态：

订单号：${order.id}
项目名称：${order.project_name}
字数：${order.word_count}
原计划金额：¥${order.amount}
原截止日期：${deadlineStr}
收回时间：${recalledAt}
${order.remark ? '\n备注：' + order.remark : ''}

⚠️ 该订单已被收回，请暂停翻译工作，等待进一步通知。

如对收回有疑问，请及时联系对接人。

谊达翻译系统`;

  return {
    subject,
    html,
    text,
    to: translatorEmail,
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
  BATCH_ORDER_ASSIGNED: buildBatchOrderAssignedEmail,
  TRANSLATOR_PAYMENT: buildTranslatorPaymentEmail,
  ORDER_RECALLED: buildOrderRecalledEmail,
};

module.exports = {
  TEMPLATES,
  buildOrderAssignedEmail,
  buildOrderCompletedEmail,
  buildOrderResponseEmail,
  buildBatchOrderAssignedEmail,
  buildClientWelcomeEmail,
  buildTranslatorWelcomeEmail,
  buildTranslatorPaymentEmail,
  buildOrderRecalledEmail,
};