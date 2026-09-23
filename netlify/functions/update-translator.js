// netlify/functions/update-translator.js
// 管理员：更新译员业务档案（语言/专长/电话/状态/姓名）
//
// 入参（POST body）：
//   id            必填，业务ID（如 T123456）
//   name          选填，姓名
//   phone         选填，电话
//   languages     选填，语种数组（如 ['英中', '日中']）
//   specialties   选填，专业领域数组（如 ['法律', '医学']）
//   status        选填，'active' | 'backup' | 'terminated'
//
// 不允许修改：id、auth_user_id、email（认证身份）、bank_info（用 update-translator-bank）
//
// 返回：更新后的 translators 记录

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate, requireMethod, parseBody } = require('./_shared/auth');
const { writeAudit } = require('./_shared/audit');

const VALID_STATUS = ['active', 'backup', 'terminated'];

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const methodErr = requireMethod(event, 'POST');
  if (methodErr) return methodErr;

  // 鉴权：仅管理员（译员自己改语言/专长属于其他 endpoint）
  const auth = await authenticate(event, 'admin');
  if (auth.error) return auth.error;

  const body = parseBody(event);
  if (!body) return corsResponse(400, { error: 'Invalid JSON body' });

  const { id } = body;
  if (!id) return corsResponse(400, { error: '译员 ID 必填' });

  // 字段白名单（只允许更新这些字段，防越权改 email/auth_user_id）
  const updatePayload = {};

  if (body.name !== undefined) {
    if (!body.name || !String(body.name).trim()) {
      return corsResponse(400, { error: '姓名不能为空' });
    }
    updatePayload.name = String(body.name).trim();
  }

  if (body.phone !== undefined) {
    updatePayload.phone = body.phone ? String(body.phone).trim() : null;
  }

  if (body.languages !== undefined) {
    if (!Array.isArray(body.languages)) {
      return corsResponse(400, { error: 'languages 必须是数组' });
    }
    updatePayload.languages = body.languages.map(s => String(s).trim()).filter(Boolean);
  }

  if (body.specialties !== undefined) {
    if (!Array.isArray(body.specialties)) {
      return corsResponse(400, { error: 'specialties 必须是数组' });
    }
    updatePayload.specialties = body.specialties.map(s => String(s).trim()).filter(Boolean);
  }

  if (body.status !== undefined) {
    if (!VALID_STATUS.includes(body.status)) {
      return corsResponse(400, { error: `status 必须是 ${VALID_STATUS.join('/')} 之一` });
    }
    updatePayload.status = body.status;
  }

  if (Object.keys(updatePayload).length === 0) {
    return corsResponse(400, { error: '没有可更新的字段' });
  }

  const service = getServiceClient();

  try {
    // 1. 先读旧记录（用于审计 + 校验存在性）
    const { data: old, error: readErr } = await service
      .from('translators')
      .select('id, name, phone, languages, specialties, status, email')
      .eq('id', id)
      .single();

    if (readErr || !old) {
      return corsResponse(404, { error: '译员不存在：' + id });
    }

    // 2. UPDATE
    const { data, error } = await service
      .from('translators')
      .update(updatePayload)
      .eq('id', id)
      .select('id, name, email, phone, languages, specialties, status')
      .single();

    if (error) {
      console.error('update-translator error:', error);
      return corsResponse(500, { error: error.message });
    }

    // 3. 审计日志
    // 状态变化标记 status_change（重点关注）
    // 其他字段变化打 update_translator
    const statusChanged = updatePayload.status && updatePayload.status !== old.status;
    const fieldsChanged = Object.keys(updatePayload).filter(k => k !== 'status');

    const details = {
      fields_changed: fieldsChanged,
      status_changed: statusChanged,
      old: {
        name: old.name,
        phone: old.phone,
        languages: old.languages,
        specialties: old.specialties,
        status: old.status,
      },
      new: {
        name: data.name,
        phone: data.phone,
        languages: data.languages,
        specialties: data.specialties,
        status: data.status,
      },
    };

    await writeAudit(service, {
      user_email: auth.user?.email || 'admin',
      user_role: 'admin',
      action: statusChanged ? 'update_translator_status' : 'update_translator',
      target_type: 'translator',
      target_id: id,
      details,
    });

    return corsResponse(200, { data, message: '译员信息已更新' });
  } catch (e) {
    console.error('update-translator unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};