// netlify/functions/register-client.js
// admin 调用：创建客户账号
// 流程：1) Supabase Auth 创建用户  2) clients 表插入新行  3) 返回客户信息
//
// 入参：{ company_name, contact_name, email, phone, remark, password? }
// 返回：{ data: { id, email, contact_name, ... }, tempPassword }
//
// 注意：客户的密码默认自动生成 12 位临时密码（admin 转告客户），客户首次登录后可自行改

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate, parseBody } = require('./_shared/auth');

function generateTempPassword() {
  // 12 位临时密码：大写+小写+数字，避免特殊字符
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pwd = '';
  for (let i = 0; i < 12; i++) {
    pwd += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pwd;
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  // 仅 admin 可调用
  const auth = await authenticate(event, 'admin');
  if (auth.error) return auth.error;

  const body = parseBody(event);
  if (!body) return corsResponse(400, { error: 'Invalid JSON body' });

  const { company_name, contact_name, email, phone, remark, password } = body;

  // 校验必填
  if (!contact_name || !email) {
    return corsResponse(400, { error: '联系人姓名和邮箱为必填' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return corsResponse(400, { error: '邮箱格式不正确' });
  }

  const service = getServiceClient();

  try {
    // 1) 检查邮箱是否已存在
    const { data: existingList } = await service.auth.admin.listUsers();
    const existing = existingList?.users?.find(u => u.email === email);
    if (existing) {
      return corsResponse(409, { error: `邮箱 ${email} 已被注册` });
    }

    // 2) 创建 Auth 用户
    const tempPassword = password || generateTempPassword();
    const { data: authData, error: authErr } = await service.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true, // 跳过邮箱验证（admin 后台创建的，admin 负责告知）
      app_metadata: { role: 'client' }, // 关键：标记 client 角色
    });
    if (authErr || !authData?.user) {
      console.error('createUser error:', authErr);
      return corsResponse(500, { error: 'Auth 创建失败：' + (authErr?.message || '未知错误') });
    }

    const authUserId = authData.user.id;

    // 3) 在 clients 表插入
    const { data: clientData, error: clientErr } = await service
      .from('clients')
      .insert({
        user_id: authUserId,
        company_name: company_name || null,
        contact_name: String(contact_name).trim(),
        email: email,
        phone: phone || null,
        remark: remark || null,
        status: 'active',
      })
      .select()
      .single();

    if (clientErr || !clientData) {
      console.error('insert client error:', clientErr);
      // 回滚：删掉刚创建的 Auth 用户
      await service.auth.admin.deleteUser(authUserId);
      return corsResponse(500, { error: '客户表插入失败：' + (clientErr?.message || '') });
    }

    console.log('client created:', clientData.id, 'by admin:', auth.user.email);

    return corsResponse(200, {
      data: {
        ...clientData,
        tempPassword: tempPassword, // 返回临时密码，admin 转告客户
        message: '客户创建成功，请将临时密码告知客户',
      },
    });
  } catch (e) {
    console.error('register-client unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};