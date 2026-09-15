// netlify/functions/_shared/notifications.js
// 通知偏好检查（A9）
// 用法：await checkPreference(service, userEmail, preferenceKey) → boolean
//
// 默认行为：用户没设置偏好 = 启用（true）。即开箱即用，最小摩擦。
// 如果用户显式设了 enabled=false，才跳过该类通知。

async function checkPreference(service, userEmail, preferenceKey) {
  // 没邮箱视为系统通知（比如管理员自己的），始终发
  if (!userEmail) return true;

  try {
    const { data, error } = await service
      .from('notification_preferences')
      .select('enabled')
      .eq('user_email', userEmail)
      .eq('preference_key', preferenceKey)
      .maybeSingle();

    if (error) {
      console.warn('checkPreference error:', error.message, '— 默认启用');
      return true;
    }

    // 没记录 = 默认启用
    if (!data) return true;

    return data.enabled === true;
  } catch (e) {
    console.warn('checkPreference unhandled:', e.message, '— 默认启用');
    return true;
  }
}

module.exports = { checkPreference };