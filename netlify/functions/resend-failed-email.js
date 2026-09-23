// netlify/functions/resend-failed-email.js
// 管理员：从 audit_logs 读取失败的邮件记录，重新触发发送
//
// 入参（POST body）：
//   auditLogId     单条重发
//   auditLogIds    批量重发（数组）
//
// 路由逻辑（按 audit_logs.details.emailType）：
//   order_assigned         → send-order-email          (orderId)
//   order_completed        → send-completion-email     (orderId)
//   order_response         → send-order-response-email (orderId)
//   batch_order_assigned   → send-batch-order-email    (batchId)
//   batch_import_assigned  → send-batch-import-email   (batchId)
//
// 成功：在 audit_logs 写 action='email_resent'
//       + UPDATE 原条目 details.status='resent'
// 仍失败：写 action='email_resend_failed'
//        + UPDATE 原条目 details.status='pending_resend'

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate, parseBody } = require('./_shared/auth');

const ROUTES = {
  order_assigned:        { endpoint: 'send-order-email',        idField: 'orderId', idSource: 'orderId' },
  order_completed:       { endpoint: 'send-completion-email',   idField: 'orderId', idSource: 'orderId' },
  order_response:        { endpoint: 'send-order-response-email', idField: 'orderId', idSource: 'orderId' },
  batch_order_assigned:  { endpoint: 'send-batch-order-email',  idField: 'batchId', idSource: 'batchId' },
  batch_import_assigned: { endpoint: 'send-batch-import-email', idField: 'batchId', idSource: 'batchId' },
};

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  if (event.httpMethod !== 'POST') {
    return corsResponse(405, { error: 'Method not allowed' });
  }

  const auth = await authenticate(event, 'admin');
  if (auth.error) return auth.error;

  const body = parseBody(event);
  if (!body) return corsResponse(400, { error: 'Invalid JSON' });

  const ids = body.auditLogId
    ? [body.auditLogId]
    : (Array.isArray(body.auditLogIds) ? body.auditLogIds : []);

  if (ids.length === 0) {
    return corsResponse(400, { error: 'auditLogId 或 auditLogIds 必填' });
  }

  const service = getServiceClient();

  // 1. 取失败记录
  const { data: logs, error: logsErr } = await service
    .from('audit_logs')
    .select('id, target_id, details')
    .in('id', ids)
    .eq('action', 'email_send_failed');

  if (logsErr) {
    console.error('resend-failed-email fetch logs error:', logsErr);
    return corsResponse(500, { error: logsErr.message });
  }
  if (!logs || logs.length === 0) {
    return corsResponse(404, { error: '未找到失败邮件记录' });
  }

  const results = [];

  for (const log of logs) {
    const details = log.details || {};
    const emailType = details.emailType;
    const route = ROUTES[emailType];

    if (!route) {
      results.push({ auditLogId: log.id, status: 'skipped', reason: `未支持的 emailType: ${emailType}` });
      continue;
    }

    const targetId = details[route.idSource] || log.target_id;
    if (!targetId) {
      results.push({ auditLogId: log.id, status: 'skipped', reason: '记录缺少目标 ID' });
      continue;
    }

    // 2. 触发对应 send-* endpoint
    const protocol = event.headers['x-forwarded-proto'] || 'https';
    const host = event.headers.host;
    const url = `${protocol}://${host}/.netlify/functions/${route.endpoint}`;

    let sendOk = false;
    let sendErr = null;
    let sendInfo = null;

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': event.headers.authorization || '' },
        body: JSON.stringify({ [route.idField]: targetId }),
      });
      sendInfo = await resp.json().catch(() => ({}));
      sendOk = resp.ok;
      if (!resp.ok) sendErr = sendInfo.error || `HTTP ${resp.status}`;
    } catch (e) {
      sendErr = e.message;
    }

    // 3. 写审计 + 更新原 details.status
    const newStatus = sendOk ? 'resent' : 'pending_resend';
    const newDetails = { ...details, status: newStatus, lastResendAt: new Date().toISOString() };

    await service
      .from('audit_logs')
      .update({ details: newDetails })
      .eq('id', log.id);

    await service.from('audit_logs').insert({
      user_email: 'system:resend',
      user_role: 'system',
      action: sendOk ? 'email_resent' : 'email_resend_failed',
      target_type: 'email',
      target_id: log.target_id,
      details: {
        emailType,
        to: details.to,
        error: sendErr || null,
        originalAuditLogId: log.id,
        messageId: sendInfo?.data?.messageId || sendInfo?.messageId || null,
        skipped: sendInfo?.data?.skipped || sendInfo?.skipped || false,
        timestamp: new Date().toISOString(),
      },
    });

    results.push({
      auditLogId: log.id,
      status: sendOk ? 'success' : 'failed',
      reason: sendErr,
      messageId: sendInfo?.data?.messageId || sendInfo?.messageId || null,
      skipped: sendInfo?.data?.skipped || sendInfo?.skipped || false,
    });
  }

  const successCount = results.filter(r => r.status === 'success').length;
  const failedCount = results.filter(r => r.status === 'failed').length;
  const skippedCount = results.filter(r => r.status === 'skipped').length;

  return corsResponse(200, {
    data: {
      results,
      summary: { total: results.length, success: successCount, failed: failedCount, skipped: skippedCount },
    },
    message: `重发完成：${successCount} 成功 / ${failedCount} 失败 / ${skippedCount} 跳过`,
  });
};