// netlify/functions/_shared/login.js
// 共享登录逻辑：signInWithPassword + 校验 role + 写审计日志
// 调用方：login-translator / login-admin / login-client

const { getServiceClient, getUserClient } = require('./supabase');
const { corsResponse } = require('./auth');
const { writeAudit } = require('./audit');

/**
 * 通用登录处理
 * @param {object} event - Netlify event
 * @param {string} requiredRole - 'admin' | 'translator' | 'client'
 * @returns {object} Netlify response
 */
async function handleLogin(event, requiredRole) {
  // 解析 body
  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (e) {
    return corsResponse(400, { error: 'Invalid JSON' });
  }

  const { email, password } = body;
  if (!email || !password) {
    return corsResponse(400, { error: '邮箱和密码为必填' });
  }

  const service = getServiceClient();

  // 1) 用 service_role 模拟登录（避免泄露 anon key 时序）
  const { data, error } = await service.auth.signInWithPassword({
    email: String(email).trim(),
    password: String(password),
  });

  if (error || !data?.session) {
    return corsResponse(401, { error: '邮箱或密码错误' });
  }

  const user = data.user;
  const session = data.session;
  const role = user.app_metadata?.role;

  // 2) 校验角色
  if (role !== requiredRole) {
    return corsResponse(403, {
      error: `此账号不是 ${requiredRole}，无法登录该入口（实际角色：${role || '未设置'}）`,
    });
  }

  // 3) 译员/客户额外检查业务状态
  //    关键：用 service_role 客户端查业务表，service_role 默认 bypass RLS，
  //    .eq('user_id', user.id) 强制按 auth user id 过滤，比依赖 RLS 更稳
  let extra = {};
  if (role === 'translator') {
    // v7 修复：translators 表实际字段是 name（schema v2.sql），没有 full_name
    // 之前误查 full_name 返回 undefined，前端 fallback 到 email 显示
    const { data: t, error: tErr } = await service
      .from('translators')
      .select('id, status, name')
      .eq('auth_user_id', user.id)
      .maybeSingle();
    if (tErr) {
      console.error('[login-translator] query error:', tErr);
      return corsResponse(500, { error: '译员业务记录查询失败：' + tErr.message });
    }
    if (!t) {
      return corsResponse(403, { error: '译员业务记录不存在' });
    }
    if (t.status === 'terminated') {
      return corsResponse(403, { error: '账号已终止，请联系管理员' });
    }
    extra.translatorId = t.id;
    extra.fullName = t.name;
  } else if (role === 'client') {
    const { data: c, error: cErr } = await service
      .from('clients')
      .select('id, status, contact_name, company_name')
      .eq('user_id', user.id)
      .maybeSingle();
    if (cErr) {
      console.error('[login-client] clients query error:', cErr);
      return corsResponse(500, { error: '客户业务记录查询失败：' + cErr.message });
    }
    if (!c) {
      return corsResponse(403, { error: '客户业务记录不存在' });
    }
    if (c.status === 'archived') {
      return corsResponse(403, { error: '账号已归档，请联系管理员' });
    }
    extra.clientId = c.id;
    extra.contactName = c.contact_name;
    extra.companyName = c.company_name;
  }

  // 4) 写审计日志（失败不阻塞）
  await writeAudit(service, {
    user_email: user.email,
    user_role: role,
    action: 'login',
    target_type: 'auth',
    target_id: user.id,
    details: { source: 'netlify-function', ip: event.headers?.['client-ip'] || null },
  });

  return corsResponse(200, {
    data: {
      user: {
        id: user.id,
        email: user.email,
        role,
        ...extra,
      },
      session: {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
      },
    },
  });
}

module.exports = { handleLogin };