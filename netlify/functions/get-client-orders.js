// netlify/functions/get-client-orders.js
// 客户调用：查自己的订单（应用 RLS：客户只能看 client_id = 自己的订单）
//
// 返回：{ _client: { id, contact_name, company_name }, data: [...] }
//
// 关键：client 信息放顶层 _client（避免 apiCall 解包 data 时丢失）

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate } = require('./_shared/auth');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  // 要求 client 角色
  const auth = await authenticate(event, 'client');
  if (auth.error) return auth.error;

  const service = getServiceClient();
  const clientAuthUserId = auth.user.id;

  try {
    // 1) 查客户自己的 client 行
    const { data: client, error: clientErr } = await service
      .from('clients')
      .select('id, contact_name, company_name')
      .eq('user_id', clientAuthUserId)
      .single();

    if (clientErr || !client) {
      return corsResponse(404, { error: '客户档案不存在' });
    }

    // 2) 查该客户的所有订单
    const { data: orders, error: ordersErr } = await service
      .from('orders')
      .select(`
        id, project_name, word_count, client_word_count, client_rate, client_amount,
        deadline, status, client_payment_status,
        invoice_status, invoice_number, invoice_date,
        created_at, updated_at,
        translators:translator_id ( id, name )
      `)
      .eq('client_id', client.id)
      .order('created_at', { ascending: false });

    if (ordersErr) {
      console.error('get-client-orders error:', ordersErr);
      return corsResponse(500, { error: ordersErr.message });
    }

    // 3) 格式化：摊平译员名字（不暴露邮箱/电话）
    const formatted = (orders || []).map(o => ({
      id: o.id,
      project_name: o.project_name,
      word_count: o.word_count,
      // v7：客户侧返回客户字数；fallback 到 word_count 兼容历史数据
      client_word_count: o.client_word_count ?? o.word_count,
      client_rate: o.client_rate,
      client_amount: o.client_amount,
      deadline: o.deadline,
      status: o.status,
      payment_status: o.client_payment_status,
      invoice_status: o.invoice_status,
      invoice_number: o.invoice_number,
      invoice_date: o.invoice_date,
      translator_name: o.translators?.name || '待指派',
      created_at: o.created_at,
      updated_at: o.updated_at,
    }));

    return corsResponse(200, {
      // client 信息放顶层，避免 apiCall 解包 data 时丢失
      _client: {
        id: client.id,
        contact_name: client.contact_name,
        company_name: client.company_name,
      },
      data: formatted,
    });
  } catch (e) {
    console.error('get-client-orders unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};