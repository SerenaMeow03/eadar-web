// Netlify Function - 创建译员账号
// 使用 Supabase Admin API 创建用户，设置 role:translator

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  // 设置 CORS 头
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // 处理预检请求
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // 只接受 POST 请求
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // 从环境变量读取 Supabase 配置
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY_EADARTRANS;

    if (!supabaseUrl || !supabaseServiceKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Supabase configuration missing' })
      };
    }

    // 解析请求体
    const { email, password, fullName, languages } = JSON.parse(event.body);

    // 验证必填字段
    if (!email || !password) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: '邮箱和密码不能为空' })
      };
    }

    // 创建 Supabase 客户端（使用 Service Key 拥有管理员权限）
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 创建用户
    const { data: userData, error: createError } = await supabase.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true, // 自动确认邮箱
      app_metadata: {
        role: 'translator'
      },
      user_metadata: {
        full_name: fullName || '',
        languages: languages || []
      }
    });

    if (createError) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: createError.message })
      };
    }

    // 可选：在 profiles 表中创建记录（如果表存在）
    try {
      await supabase.from('profiles').insert({
        id: userData.user.id,
        full_name: fullName || '',
        languages: languages || [],
        created_at: new Date().toISOString()
      });
    } catch (profileError) {
      // profiles 表可能不存在，忽略错误
      console.log('Profiles table insert skipped:', profileError.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: '译员账号创建成功',
        data: {
          id: userData.user.id,
          email: userData.user.email,
          role: 'translator'
        }
      })
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
