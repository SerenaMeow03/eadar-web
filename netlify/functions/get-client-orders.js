// netlify/functions/get-client-orders.js
// 客户调用：查自己的订单（应用 RLS：客户只能看 client_id = 自己的订单）
//
// 返回：{ data: [{ id, project_name, word_count, client_rate, client_amount, deadline, status, payment_status, translator_name, created_at, ... }] }
//
// 关键：返回的字段是**客户视角**（不暴露译员单价/译员应收金额）

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
    console.log('[get-client-orders] auth.user.id:', clientAuthUserId);
    const { data: client, error: clientErr } = await service
      .from('clients')
      .select('id, contact_name, company_name')
      .eq('user_id', clientAuthUserId)
      .single();

    console.log('[get-client-orders] client result:', { client, clientErr });
    if (clientErr || !client) {
      return corsResponse(404, { error: '客户档案不存在' });
    }

    // 2) 查该客户的所有订单（用 service 但加 client_id 过滤，等价 RLS）
    const { data: orders, error: ordersErr } = await service
      .from('orders')
      .select(`
        id, project_name, word_count, client_rate, client_amount,
        deadline, status, client_payment_status,
        invoice_status, invoice_number, invoice_date,
        created_at, updated_at,
        translators:translator_id ( id, name )
      `)
      .eq('client_id', client.id)
      .order('created_at', { ascending: false });

    console.log('[get-client-orders] orders result: count=', orders?.length, 'err=', ordersErr?.message);

    if (ordersErr) {
      console.error('get-client-orders error:', ordersErr);
      return corsResponse(500, { error: ordersErr.message });
    }

    // 3) 格式化：把译员名字摊平（不暴露译员邮箱/电话）
    //    关键：client_payment_status 映射到前端用的 payment_status 字段名（前端代码不需改）
    const formatted = (orders || []).map(o => ({
      id: o.id,
      project_name: o.project_name,
      word_count: o.word_count,
      client_rate: o.client_rate,
      client_amount: o.client_amount,
      deadline: o.deadline,
      status: o.status,
      payment_status: o.client_payment_status, // 兼容字段名
      invoice_status: o.invoice_status,
      invoice_number: o.invoice_number,
      invoice_date: o.invoice_date,
      translator_name: o.translators?.name || '待指派',
      created_at: o.created_at,
      updated_at: o.updated_at,
    }));

    return corsResponse(200, {
      data: formatted,
      client: {
        id: client.id,
        contact_name: client.contact_name,
        company_name: client.company_name,
      },
    });
  } catch (e) {
    console.error('get-client-orders unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};