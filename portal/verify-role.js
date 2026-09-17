// 共享角色校验工具（admin/translator/client 页面通用）
// 用法：<script src="../verify-role.js"></script><script>verifyRole('client', 'login.html')</script>
// 注意：每个页面要在 <script> 中立即调用 verifyRole()，避免被 bypass
(function() {
    const SUPABASE_URL = 'https://zyawwjxjdloubvcnyvtp.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp5YXd3anhqZGxvdWJ2Y255dnRwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2OTQ1ODcsImV4cCI6MjEwMzI3MDU4N30.MumxYoClGwxbuJrAsWNvSlXsMgRsSIkT2nphfgXBT_c';

    function getAccessToken() {
        const keys = Object.keys(localStorage);
        for (const k of keys) {
            if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
                try {
                    const data = JSON.parse(localStorage.getItem(k));
                    return data?.access_token || null;
                } catch (e) { return null; }
            }
        }
        return null;
    }

    // 验证 token 中的角色，失败则清 token 跳 loginUrl
    // requiredRole: 'admin' | 'translator' | 'client'
    // loginUrl: 跳的登录页路径（默认 'login.html'）
    // userKey: localStorage 里的业务用户 key（'currentAdmin' / 'currentTranslator'），可选
    async function verifyRole(requiredRole, loginUrl = 'login.html', userKey = null) {
        const token = getAccessToken();
        if (!token) {
            window.location.href = loginUrl;
            return false;
        }
        try {
            const { createClient } = window.supabase;
            const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                global: { headers: { Authorization: 'Bearer ' + token } },
                auth: { persistSession: false, autoRefreshToken: false },
            });
            const { data, error } = await sb.auth.getUser(token);
            if (error || !data?.user) throw error || new Error('No user');
            const role = data.user.app_metadata?.role;
            if (role !== requiredRole) {
                // 残留 token，清掉
                Object.keys(localStorage).forEach(k => {
                    if (k.startsWith('sb-') && k.endsWith('-auth-token')) localStorage.removeItem(k);
                    if (userKey && k === userKey) localStorage.removeItem(k);
                });
                window.location.href = loginUrl;
                return false;
            }
            // 可选：检查业务 key 是否存在
            if (userKey && !localStorage.getItem(userKey)) {
                window.location.href = loginUrl;
                return false;
            }
            return true;
        } catch (e) {
            // token 无效，清掉
            Object.keys(localStorage).forEach(k => {
                if (k.startsWith('sb-') && k.endsWith('-auth-token')) localStorage.removeItem(k);
                if (userKey && k === userKey) localStorage.removeItem(k);
            });
            window.location.href = loginUrl;
            return false;
        }
    }

    // 注销：清 supabase token + 业务 user key
    function logout(loginUrl = 'login.html') {
        Object.keys(localStorage).forEach(k => {
            if (k.startsWith('sb-') && k.endsWith('-auth-token')) localStorage.removeItem(k);
        });
        window.location.href = loginUrl;
    }

    window.verifyRole = verifyRole;
    window.logoutClean = logout;
})();