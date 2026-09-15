// netlify/functions/login-admin.js
// admin 登录入口（仅 role= 'admin'）

const { preflight } = require('./_shared/auth');
const { handleLogin } = require('./_shared/login');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  return handleLogin(event, 'admin');
};