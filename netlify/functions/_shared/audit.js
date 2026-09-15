// netlify/functions/_shared/audit.js
// 审计日志写入助手（A7）
// 调用方式：await writeAudit(service, { user_email, user_role, action, target_type, target_id, details })
//
// 失败不抛错（try/catch 内部），避免阻塞主业务流

async function writeAudit(service, {
  user_email,
  user_role,
  action,
  target_type,
  target_id,
  details,
}) {
  if (!service) return { ok: false, error: 'no service client' };
  if (!user_email || !action || !target_type) {
    return { ok: false, error: 'missing required fields' };
  }

  try {
    const { error } = await service
      .from('audit_logs')
      .insert({
        user_email,
        user_role: user_role || 'system',
        action,
        target_type,
        target_id: target_id || null,
        details: details || null,
      });
    if (error) {
      console.error('audit_logs insert error:', error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e) {
    console.error('writeAudit unhandled:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { writeAudit };