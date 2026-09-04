// netlify/functions/_shared/supabase.js
// 服务端 Supabase client，使用 service_role key
// 永远不要把这个文件 import 到前端代码里！

const { createClient } = require('@supabase/supabase-js');

let cachedClient = null;

function getServiceClient() {
  if (cachedClient) return cachedClient;

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      'Supabase env not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Netlify dashboard.'
    );
  }

  cachedClient = createClient(supabaseUrl, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return cachedClient;
}

// 从前端传来的 access_token 创建一个 user-scoped client
// 这个 client 受 RLS 约束（用于校验权限）
function getUserClient(accessToken) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    throw new Error('Supabase URL or anon key missing');
  }

  return createClient(supabaseUrl, anonKey, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

module.exports = { getServiceClient, getUserClient };
