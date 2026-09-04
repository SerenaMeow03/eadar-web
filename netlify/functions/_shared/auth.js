// netlify/functions/_shared/auth.js
// 通用鉴权工具：解析 Authorization 头，校验 role，返回 user 信息

const { getServiceClient, getUserClient } = require('./supabase');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

function corsResponse(statusCode, body) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

function preflight(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  return null;
}

// 从 Authorization: Bearer <token> 解析 JWT
function extractToken(event) {
  const auth = event.headers.authorization || event.headers.Authorization;
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

// 鉴权主函数
// 返回 { user, role, translatorId, error }
// role: 'admin' | 'translator' | null
async function authenticate(event, requiredRole = null) {
  const token = extractToken(event);
  if (!token) {
    return { error: corsResponse(401, { error: 'Missing Authorization header' }) };
  }

  const service = getServiceClient();

  // 用 service_role 解码 JWT（Supabase 允许 service 查 auth.users）
  const { data: userData, error: userErr } = await service.auth.getUser(token);
  if (userErr || !userData?.user) {
    return { error: corsResponse(401, { error: 'Invalid or expired token' }) };
  }

  const user = userData.user;
  const role = user.app_metadata?.role || null;

  if (requiredRole && role !== requiredRole) {
    return { error: corsResponse(403, { error: `Requires role: ${requiredRole}` }) };
  }

  // 译员额外查一下业务 ID
  let translatorId = null;
  if (role === 'translator') {
    const { data: t } = await service
      .from('translators')
      .select('id, status')
      .eq('auth_user_id', user.id)
      .single();
    if (t) {
      translatorId = t.id;
    }
  }

  return { user, role, translatorId, error: null };
}

// 校验 method
function requireMethod(event, methods) {
  const list = Array.isArray(methods) ? methods : [methods];
  if (!list.includes(event.httpMethod)) {
    return corsResponse(405, { error: `Method not allowed: ${event.httpMethod}` });
  }
  return null;
}

// 安全解析 JSON body
function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch (e) {
    return null;
  }
}

module.exports = {
  corsResponse,
  preflight,
  authenticate,
  requireMethod,
  parseBody,
};
