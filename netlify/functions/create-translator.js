// netlify/functions/create-translator.js
// 管理员在后台创建译员账号
// 流程：
//   1. 用 service_role 调 admin.createUser 创建 Supabase Auth 用户
//   2. 在 translators 表插入业务记录，关联 auth_user_id

const { createClient } = require('@supabase/supabase-js');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  // 预检
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // 鉴权：必须是管理员
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Missing Authorization' }) };
  }
  const token = authHeader.replace(/^Bearer\s+/i, '');

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase env not configured' }) };
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    // 验证调用者是 admin
    const { data: callerData, error: callerErr } = await supabase.auth.getUser(token);
    if (callerErr || !callerData?.user) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) };
    }
    const callerRole = callerData.user.app_metadata?.role;
    if (callerRole !== 'admin') {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Requires admin role' }) };
    }

    // 解析 body
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const { email, password, fullName, languages, specialties, phone } = body;

    if (!email || !password) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '邮箱和密码不能为空' }) };
    }
    if (password.length < 6) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '密码至少 6 位' }) };
    }

    // 1. 创建 Supabase Auth 用户
    const { data: userData, error: createErr } = await supabase.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true,
      app_metadata: { role: 'translator' },
      user_metadata: {
        full_name: fullName || '',
        languages: languages || [],
      },
    });

    if (createErr) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: createErr.message }) };
    }

    const authUserId = userData.user.id;

    // 2. 生成业务 ID (T + 时间戳后 6 位)
    const businessId = 'T' + Date.now().toString().slice(-6);

    // 3. 插入 translators 表
    const { data: translator, error: insertErr } = await supabase
      .from('translators')
      .insert({
        id: businessId,
        auth_user_id: authUserId,
        name: fullName || email.split('@')[0],
        email: email,
        phone: phone || null,
        languages: languages || [],
        specialties: specialties || [],
        status: 'active',
      })
      .select('id, name, email, auth_user_id')
      .single();

    if (insertErr) {
      // 回滚 auth 用户
      await supabase.auth.admin.deleteUser(authUserId);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '业务表写入失败：' + insertErr.message }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: '译员账号创建成功',
        data: {
          id: translator.id,
          email: translator.email,
          name: translator.name,
          authUserId: translator.auth_user_id,
        },
      }),
    };
  } catch (err) {
    console.error('create-translator unhandled:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
