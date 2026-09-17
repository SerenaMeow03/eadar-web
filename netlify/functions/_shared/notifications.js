// netlify/functions/_shared/notifications.js
// 通知偏好检查（A9）
//
// 用法：await checkPreference(service, userEmail, userRole, preferenceKey) → boolean
//
// 2026-09-17 升级：按 role 判定 key 适用性，避免 admin 误收不应收的通知
// 默认行为：用户没设置偏好 = 启用（true）。即开箱即用，最小摩擦。
// 如果用户显式设了 enabled=false，才跳过该类通知。

// 该 key 适用于哪个角色（多对一）：admin / translator / client
// 修改这里时同时同步 portal/admin/notifications.html 的文案
const APPLICABLE_ROLES = {
  order_assigned: ['translator'],   // 派单通知发给译员
  order_response: ['admin'],        // 译员响应派单通知 PM
  order_completed: ['admin'],       // 译员标记完成通知 PM
  payment_received: ['translator'], // 译费到账通知译员
};

// 每个角色应看到的偏好项（含 label / desc / 默认启用）
const ROLE_PREFERENCES = {
  admin: [
    {
      key: 'order_completed',
      label: '译员标记订单完成',
      desc: '当译员主动将订单标记为已完成时，邮件通知我',
    },
    {
      key: 'order_response',
      label: '译员响应派单',
      desc: '当译员接受或拒绝我派的订单时，邮件通知我',
    },
  ],
  translator: [
    {
      key: 'order_assigned',
      label: '订单分配通知',
      desc: '当有新订单被指派给我时，邮件通知我',
    },
    {
      key: 'payment_received',
      label: '译费到账通知',
      desc: '当公司结算译费到我账上时，邮件通知我',
    },
  ],
  client: [], // 客户通知走 admin 手动邮件，不发系统通知
};

// 从 JWT 用户对象拿 role（auth.users.raw_app_meta_data->>'role'）
// 反面案例：不要建独立的 admin / admins 表，role 字段直接在 auth.users 里查
function getUserRole(authUser) {
  return authUser?.app_metadata?.role || null;
}

// key 是否适用于该角色
function isApplicable(userRole, preferenceKey) {
  if (!userRole) return false;
  const applicableRoles = APPLICABLE_ROLES[preferenceKey];
  if (!applicableRoles) return false; // 未知 key 防御性 false
  return applicableRoles.includes(userRole);
}

async function checkPreference(service, userEmail, userRole, preferenceKey) {
  // 该 key 是否适用于此角色？不适用 = 不发（核心防御：避免 admin 误收自派单通知）
  if (!isApplicable(userRole, preferenceKey)) {
    return false;
  }

  // 没邮箱视为系统通知，按 role 决策：本角色适用 + 默认开
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

module.exports = {
  checkPreference,
  ROLE_PREFERENCES,
  APPLICABLE_ROLES,
  isApplicable,
  getUserRole,
};
