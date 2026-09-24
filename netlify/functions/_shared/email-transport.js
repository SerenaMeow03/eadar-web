// netlify/functions/_shared/email-transport.js
// 统一封装 nodemailer transport 配置
// 关键点：
//   1) connectionTimeout / socketTimeout：Netlify Function 同步 10s / 异步 26s，
//      SMTP 卡住时不能等太久，否则函数被平台强杀（前端 fetch 拿到 502）
//      设置 8s 比 10s 留缓冲，比 5s 长（正常 SMTP 拨号 2-3s）
//   2) secure: 自动判断（465 = SSL，587 = STARTTLS）
//   3) 检查环境变量齐全后再创建（缺配置不创建实例，避免空 transporter 浪费拨号）
//
// 调用方式：
//   const { createEmailTransport, validateSmtpEnv } = require('./_shared/email-transport');
//   const envCheck = validateSmtpEnv();
//   if (!envCheck.ok) return corsResponse(500, { error: envCheck.error });
//   const transporter = createEmailTransport();
//   await transporter.sendMail(...);

function validateSmtpEnv() {
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpHost || !smtpUser || !smtpPass) {
    return { ok: false, error: 'SMTP 未配置（需在 Netlify 环境变量设置 SMTP_HOST/SMTP_USER/SMTP_PASS）' };
  }
  return { ok: true, smtpHost, smtpUser, smtpPass };
}

function createEmailTransport() {
  const env = validateSmtpEnv();
  if (!env.ok) {
    throw new Error(env.error);
  }
  const smtpPort = Number(process.env.SMTP_PORT || 465);
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    host: env.smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: env.smtpUser, pass: env.smtpPass },
    // 关键：8s 超时（Netlify 同步 10s，留 2s 余量给后续处理）
    connectionTimeout: 8000,
    socketTimeout: 8000,
  });
}

module.exports = { createEmailTransport, validateSmtpEnv };
