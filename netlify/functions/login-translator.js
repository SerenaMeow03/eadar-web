// netlify/functions/login-translator.js
// 译员登录入口（仅 role= 'translator'）

const { preflight } = require('./_shared/auth');
const { handleLogin } = require('./_shared/login');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  return handleLogin(event, 'translator');
};