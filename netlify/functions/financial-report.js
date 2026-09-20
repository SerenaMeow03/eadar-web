// netlify/functions/financial-report.js
// 管理员：财务月报（按月统计客户金额/译员金额/利润率）
//
// 入参（GET query）：
//   month 可选 YYYY-MM，不传默认本月（按 created_at 月份）
//
// 返回：
//   {
//     month, range,
//     summary: { total, byStatus, client_revenue, client_receivable, translator_payable, gross_profit, profit_rate },
//     byLanguage: [{ lang, total, client_revenue, translator_payable, profit_rate }],
//     byTranslator: [{ name, total, translator_payable }],
//     byClient: [{ name, total, client_revenue }],
//   }
//
// 设计：纯按需计算（不持久化），不点击不触发

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate } = require('./_shared/auth');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  if (event.httpMethod !== 'GET') {
    return corsResponse(405, { error: 'Method not allowed' });
  }

  const auth = await authenticate(event, 'admin');
  if (auth.error) return auth.error;

  // 解析月份（默认本月）
  const monthParam = event.queryStringParameters?.month;
  let year, month;
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    [year, month] = monthParam.split('-').map(Number);
  } else {
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth() + 1;
  }
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;
  const fromDate = `${monthStr}-01`;
  // 下月第一天
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const toDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

  const service = getServiceClient();

  try {
    // 一次查当月所有订单（含译员/客户 join）
    const { data: orders, error } = await service
      .from('orders')
      .select(`
          id, project_name, status,
          word_count, rate, amount,
          client_id, client_amount, client_payment_status,
          language_pair,
          translators:translator_id ( id, name ),
          clients:client_id ( id, contact_name, company_name )
        `)
      .gte('created_at', fromDate)
      .lt('created_at', toDate);

    if (error) {
      console.error('financial-report fetch error:', error);
      return corsResponse(500, { error: error.message });
    }

    const list = orders || [];

    // === 汇总 ===
    const byStatus = { pending: 0, progress: 0, completed: 0, cancelled: 0 };
    let clientRevenue = 0;      // 已收款 + 应收款（不管 paid 状态）
    let clientReceivable = 0;   // 未收
    let translatorPayable = 0;  // 译员应付

    for (const o of list) {
      byStatus[o.status] = (byStatus[o.status] || 0) + 1;
      const ca = Number(o.client_amount) || 0;
      const ta = Number(o.amount) || 0;
      clientRevenue += ca;
      if (o.client_payment_status !== 'paid') clientReceivable += ca;
      translatorPayable += ta;
    }

    const grossProfit = clientRevenue - translatorPayable;
    const profitRate = clientRevenue > 0 ? (grossProfit / clientRevenue) * 100 : 0;

    // === 按语言对分项 ===
    const langMap = {};
    for (const o of list) {
      const lang = o.language_pair || '未指定';
      if (!langMap[lang]) langMap[lang] = { lang, total: 0, client_revenue: 0, translator_payable: 0 };
      langMap[lang].total++;
      langMap[lang].client_revenue += Number(o.client_amount) || 0;
      langMap[lang].translator_payable += Number(o.amount) || 0;
    }
    const byLanguage = Object.values(langMap).map(r => ({
      ...r,
      gross_profit: r.client_revenue - r.translator_payable,
      profit_rate: r.client_revenue > 0 ? ((r.client_revenue - r.translator_payable) / r.client_revenue * 100) : 0,
    })).sort((a, b) => b.client_revenue - a.client_revenue);

    // === 按译员分项 ===
    const tMap = {};
    for (const o of list) {
      const t = o.translators;
      const key = t?.id || 'unassigned';
      if (!tMap[key]) tMap[key] = { name: t?.name || '未指派', total: 0, translator_payable: 0 };
      tMap[key].total++;
      tMap[key].translator_payable += Number(o.amount) || 0;
    }
    const byTranslator = Object.values(tMap).sort((a, b) => b.translator_payable - a.translator_payable);

    // === 按客户分项 ===
    const cMap = {};
    for (const o of list) {
      const c = o.clients;
      const key = c?.id || 'no_client';
      if (!cMap[key]) cMap[key] = { name: c?.company_name || c?.contact_name || '未关联客户', total: 0, client_revenue: 0, client_receivable: 0 };
      cMap[key].total++;
      cMap[key].client_revenue += Number(o.client_amount) || 0;
      if (o.client_payment_status !== 'paid') cMap[key].client_receivable += Number(o.client_amount) || 0;
    }
    const byClient = Object.values(cMap).sort((a, b) => b.client_revenue - a.client_revenue);

    return corsResponse(200, {
      month: monthStr,
      range: { from: fromDate, to: toDate },
      summary: {
        total: list.length,
        byStatus,
        client_revenue: round2(clientRevenue),
        client_receivable: round2(clientReceivable),
        translator_payable: round2(translatorPayable),
        gross_profit: round2(grossProfit),
        profit_rate: Number(profitRate.toFixed(1)),
      },
      byLanguage: byLanguage.map(r => ({
        ...r,
        client_revenue: round2(r.client_revenue),
        translator_payable: round2(r.translator_payable),
        gross_profit: round2(r.gross_profit),
        profit_rate: Number(r.profit_rate.toFixed(1)),
      })),
      byTranslator: byTranslator.map(r => ({
        ...r,
        translator_payable: round2(r.translator_payable),
      })),
      byClient: byClient.map(r => ({
        ...r,
        client_revenue: round2(r.client_revenue),
        client_receivable: round2(r.client_receivable),
      })),
    });
  } catch (e) {
    console.error('financial-report unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};

function round2(n) {
  return Math.round(n * 100) / 100;
}