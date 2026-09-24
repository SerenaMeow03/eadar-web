// netlify/functions/create-translator.js
// 管理员在后台创建译员账号
// 流程：
//   1. 用 service_role 调 admin.createUser 创建 Supabase Auth 用户
//   2. 在 translators 表插入业务记录，关联 auth_user_id

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate, requireMethod, parseBody } = require('./_shared/auth');
const { buildTranslatorWelcomeEmail } = require('./_shared/email-templates');
const { logEmailFailed } = require('./_shared/email-log');
const { createEmailTransport, validateSmtpEnv } = require('./_shared/email-transport');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const methodErr = requireMethod(event, 'POST');
  if (methodErr) return methodErr;

  const auth = await authenticate(event, 'admin');
  if (auth.error) return auth.error;

  const body = parseBody(event);
  if (!body) {
    return corsResponse(400, { error: 'Invalid JSON body' });
  }

  const { email, password, fullName, languages, specialties, phone } = body;

  if (!email || !password) {
    return corsResponse(400, { error: '邮箱和密码不能为空' });
  }
  if (password.length < 6) {
    return corsResponse(400, { error: '密码至少 6 位' });
  }

  const service = getServiceClient();

  try {
    // 1. 创建 Supabase Auth 用户
    const { data: userData, error: createErr } = await service.auth.admin.createUser({
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
      return corsResponse(400, { error: createErr.message });
    }

    const authUserId = userData.user.id;

    // 2. 生成业务 ID (T + 时间戳后 6 位)
    const businessId = 'T' + Date.now().toString().slice(-6);

    // 3. 插入 translators 表
    const { data: translator, error: insertErr } = await service
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
      .select('id, name, email, auth_user_id, languages, phone, specialties, status')
      .single();

    if (insertErr) {
      // 回滚 auth 用户
      await service.auth.admin.deleteUser(authUserId);
      return corsResponse(500, { error: '业务表写入失败：' + insertErr.message });
    }

    // 4) 发送欢迎邮件给译员（非阻塞，失败仅记日志 + audit）
    try {
      const envCheck = validateSmtpEnv();
      if (!envCheck.ok) {
        console.warn('create-translator: SMTP not configured, skip welcome email');
      } else {
        const { smtpUser } = envCheck;
        const tpl = buildTranslatorWelcomeEmail({ translator, password, smtpUser });
        const transporter = createEmailTransport();
        const info = await transporter.sendMail({
          from: `"${tpl.fromName}" <${smtpUser}>`,
          to: tpl.to,
          subject: tpl.subject,
          text: tpl.text,
          html: tpl.html,
        });
        console.log('create-translator welcome email sent:', info.messageId);
      }
    } catch (emailErr) {
      console.error('create-translator welcome email failed:', emailErr);
      await logEmailFailed(service, {
        orderId: null,
        emailType: 'translator_welcome',
        to: translator.email,
        error: emailErr,
      }).catch(() => {});
    }

    return corsResponse(200, {
      data: {
        id: translator.id,
        email: translator.email,
        name: translator.name,
        authUserId: translator.auth_user_id,
        message: '译员账号创建成功',
      },
    });
  } catch (err) {
    console.error('create-translator unhandled:', err);
    return corsResponse(500, { error: err.message });
  }
};
