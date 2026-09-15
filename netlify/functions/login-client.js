// netlify/functions/login-client.js
// 客户登录入口（仅 role= 'client'）

const { preflight } = require('./_shared/auth');
const { handleLogin } = require('./_shared/login');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  return handleLogin(event, 'client');
};