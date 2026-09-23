// netlify/functions/_shared/email-log.js
// 邮件发送失败日志助手（写入 audit_logs 表）
// 调用方式：await logEmailFailed(service, { orderId | batchId, emailType, to, error, translatorId })
//
// 失败不抛错（依赖 writeAudit 内部 try-catch）

const { writeAudit } = require('./audit');

async function logEmailFailed(service, { orderId, batchId, emailType, to, error, translatorId }) {
  return writeAudit(service, {
    user_email: 'system:email',
    user_role: 'system',
    action: 'email_send_failed',
    target_type: 'email',
    // 单条订单：target_id = orderId；批量场景：target_id = batchId
    target_id: orderId || batchId || null,
    details: {
      emailType: emailType || 'unknown',
      to: to || null,
      error: error ? String(error.message || error) : 'unknown',
      timestamp: new Date().toISOString(),
      batchId: batchId || null,
      translatorId: translatorId || null,
    },
  });
}

module.exports = { logEmailFailed };