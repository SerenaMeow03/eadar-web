// portal/_shared/api-client.js
// 统一 API 调用封装：所有 admin/translator/client 页面共用
//
// 行为：
//   - 自动从 Supabase localStorage 拿 access_token
//   - token 缺失 → 跳 login.html
//   - 401/403 → 跳 login.html（清掉过期 token）
//   - 响应不解包（前端按后端结构访问 result.data）
//
// 用法：
//   <script src="../_shared/api-client.js"></script>
//
// 调用：
//   const result = await apiCall('get-orders');
//   const data = result.data;  // 后端返回 { data: [...] }
//   await apiCall('save-order', { method: 'POST', body: JSON.stringify(payload) });

(function () {
    'use strict';

    // 从 Supabase Auth localStorage key 拿 access_token
    // key 格式：`sb-<project-ref>-auth-token`
    function getAccessToken() {
        const keys = Object.keys(localStorage);
        for (const k of keys) {
            if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
                try {
                    const data = JSON.parse(localStorage.getItem(k));
                    return data?.access_token || null;
                } catch (e) {
                    return null;
                }
            }
        }
        return null;
    }

    // 统一 apiCall：所有页面调用同一个
    async function apiCall(path, options = {}) {
        const token = getAccessToken();
        if (!token) {
            window.location.href = 'login.html';
            throw new Error('No session');
        }
        const res = await fetch('/.netlify/functions/' + path, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {}),
                'Authorization': 'Bearer ' + token,
            },
        });
        // 401/403 → token 失效或权限不够，跳登录页
        if (res.status === 401 || res.status === 403) {
            window.location.href = 'login.html';
            throw new Error('Unauthorized');
        }
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        return json;  // 不解包，统一前端按后端结构访问 result.data
    }

    // 暴露到 window（页面 IIFE 内可直接调用）
    window.apiCall = apiCall;
    window.getAccessToken = getAccessToken;
})();