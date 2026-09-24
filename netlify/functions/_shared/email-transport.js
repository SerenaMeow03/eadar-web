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
    // 限流（解决批量邮件触发 SMTP 反垃圾问题，2026-09-24 实战踩坑）：
    //   - pool: true 开启连接池复用，避免每次 sendMail 都新建 TCP 连接
    //   - maxConnections=2：最多 2 个并发 SMTP 连接
    //   - rateDelta=1000 / rateLimit=2：1 秒窗口内最多发 2 封
    // 实测 exmail.qq.com 5 并发时会被静默限流（sendMail 返回 250 但邮件被丢），
    // 改为 2 并发 + 限速后稳定投递。
    // 单封邮件场景（如 send-order-email）也走这个 transport，限流不影响（< 2 封）。
    pool: true,
    maxConnections: 2,
    rateDelta: 1000,
    rateLimit: 2,
  });
}

module.exports = { createEmailTransport, validateSmtpEnv };
