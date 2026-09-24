// netlify/functions/send-batch-import-email.js
// V11 批量导入链路：admin 用 Excel 一次导入 N 个订单（可能多个译员）→ 按 translator_id 分组 → 每个译员发 1 封汇总邮件
// 由 admin/orders.html 的 confirmImport() 在循环调完 save-order 后触发一次
//
// 设计要点：
//   1) 按 translator_id 分组：N 条订单可能指派给 5 个译员 → 发 5 封邮件（每封含该译员的订单列表）
//   2) 复用 BATCH_ORDER_ASSIGNED 模板（批量派单已作废，模板继续用于批量导入汇总）
//   3) 每个译员单独检查 order_assigned 通知偏好，关闭的跳过（不阻塞其他译员）
//   4) 失败非阻塞：单个译员 SMTP 失败不影响其他译员，主流程返回 partial_success 状态
//   5) 输入支持 batchId（推荐）或 orderIds[]（兼容旧调用）
//
// 2026-09-24: 批量派单功能作废，send-batch-order-email.js 已删除。
//   本函数继续作为"批量导入汇总邮件"的唯一端点。

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate } = require('./_shared/auth');
const { buildBatchOrderAssignedEmail } = require('./_shared/email-templates');
const { checkPreference } = require('./_shared/notifications');
const { logEmailFailed } = require('./_shared/email-log');
const { createEmailTransport, validateSmtpEnv } = require('./_shared/email-transport');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  if (event.httpMethod !== 'POST') {
    return corsResponse(405, { error: 'Method not allowed' });
  }

  const auth = await authenticate(event, 'admin');
  if (auth.error) return auth.error;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return corsResponse(400, { error: 'Invalid JSON' }); }

  const { batchId, orderIds } = body;
  if (!batchId && (!Array.isArray(orderIds) || orderIds.length === 0)) {
    return corsResponse(400, { error: 'batchId 或 orderIds[] 至少传一个' });
  }

  // SMTP 配置检查
  const envCheck = validateSmtpEnv();
  if (!envCheck.ok) return corsResponse(500, { error: envCheck.error });
  const { smtpUser } = envCheck;

  const service = getServiceClient();

  // 2026-09-24 诊断日志：M9 邮件未触发排查 — 用户说"导入成功但没收到汇总邮件"
  console.log('[send-batch-import-email] entry, batchId=', batchId, 'orderIds=', orderIds?.length || 'n/a');

  try {
    // 查订单：优先用 batchId（推荐路径），否则用 orderIds
    let orders, queryErr;
    if (batchId) {
      const r = await service
        .from('orders')
        .select(`
            id, project_name, word_count, rate, amount, deadline, status, language_pair,
            translators:translator_id ( id, name, email )
          `)
          .eq('batch_id', batchId);
      orders = r.data;
      queryErr = r.error;
    } else {
      const r = await service
        .from('orders')
        .select(`
            id, project_name, word_count, rate, amount, deadline, status, language_pair,
            translators:translator_id ( id, name, email )
          `)
          .in('id', orderIds);
      orders = r.data;
      queryErr = r.error;
    }

    if (queryErr) {
      console.error('send-batch-import-email fetch error:', queryErr);
      return corsResponse(500, { error: queryErr.message });
    }

    if (!orders || orders.length === 0) {
      console.log('send-batch-import-email: no orders found, batchId=', batchId);
      return corsResponse(404, { error: '未找到任何订单' });
    }

    // 2026-09-24 诊断：查到的原始 orders（含 status / translator_id）
    console.log('[send-batch-import-email] fetched', orders.length, 'orders, status breakdown:', orders.reduce((acc, o) => {
      acc[o.status || 'null'] = (acc[o.status || 'null'] || 0) + 1;
      return acc;
    }, {}), 'translators:', [...new Set(orders.map(o => o.translator_id).filter(Boolean))]);

    // 过滤：只有 status=pending 的订单需要通知（已完成的补登订单不发）
    const pendingOrders = orders.filter(o => o.status === 'pending');
    if (pendingOrders.length === 0) {
      console.log('send-batch-import-email: all orders non-pending, skip notify. batchId=', batchId);
      return corsResponse(200, {
        success: true,
        skipped: true,
        reason: '所有订单状态非 pending，无须通知',
        totalOrders: orders.length,
        notifiedTranslators: 0,
      });
    }

    // 按 translator_id 分组（一个译员的所有订单合并成一封邮件）
    const byTranslator = new Map();
    for (const o of pendingOrders) {
      const tid = o.translator_id;
      if (!tid) continue;  // 防御：极端情况下 translator_id 为空（已校验必填但保底）
      if (!byTranslator.has(tid)) byTranslator.set(tid, []);
      byTranslator.get(tid).push(o);
    }

    if (byTranslator.size === 0) {
      return corsResponse(200, {
        success: true,
        skipped: true,
        reason: '所有 pending 订单均未指派译员',
        totalOrders: orders.length,
        notifiedTranslators: 0,
      });
    }

    // 2026-09-24 诊断：分组结果
    console.log('[send-batch-import-email] byTranslator groups:', byTranslator.size, 'translators:', [...byTranslator.entries()].map(([tid, arr]) => `${tid}=${arr.length}单`).join(', '));

    // 创建一次 transporter（所有邮件复用同一连接池）
    const transporter = createEmailTransport();

    // 并发发送（每译员 1 封，互不影响；失败 try-catch 后继续）
    // 改前：for...of 串行 await — 50 译员 = 5-10 分钟（Netlify async 26s 超时会丢邮件）
    // 改后：Promise.allSettled — 总耗时 ≈ 单封最慢那封（SMTP 拨号 + 发送，~1s/封）
    const sendTasks = [];
    for (const [tid, tOrders] of byTranslator) {
      sendTasks.push(
        (async () => {
          const translator = tOrders[0].translators;
          if (!translator?.email) {
            return { translatorId: tid, translatorEmail: null, status: 'skipped', reason: '译员无邮箱' };
          }

          // 通知偏好检查
          const enabled = await checkPreference(service, translator.email, 'translator', 'order_assigned');
          if (!enabled) {
            console.log('send-batch-import-email skipped: translator disabled order_assigned:', translator.email, 'count:', tOrders.length);
            return { translatorId: tid, translatorEmail: translator.email, status: 'skipped', reason: '已关闭"订单分配"通知', count: tOrders.length };
          }

          // 渲染模板
          const tpl = buildBatchOrderAssignedEmail({
            orders: tOrders,
            translator,
            smtpUser,
          });

          try {
            const info = await transporter.sendMail({
              from: `"${tpl.fromName}" <${smtpUser}>`,
              to: tpl.to,
              subject: tpl.subject,
              text: tpl.text,
              html: tpl.html,
            });
            // 2026-09-24 诊断：每封 sendMail 详细结果（含 messageId）
            console.log('[send-batch-import-email] SENT to=', translator.email, 'count=', tOrders.length, 'messageId=', info.messageId);
            return { translatorId: tid, translatorEmail: translator.email, status: 'sent', messageId: info.messageId, count: tOrders.length };
          } catch (mailErr) {
            console.error('[send-batch-import-email] FAILED to=', translator.email, 'count=', tOrders.length, 'error=', mailErr.message);
            // 失败留痕：admin 后台 audit_logs 查 action='email_send_failed' + translatorId 定位
            await logEmailFailed(service, {
              batchId,
              emailType: 'batch_import_assigned',
              to: translator.email,
              error: mailErr,
              translatorId: tid,
            }).catch(() => {});
            return { translatorId: tid, translatorEmail: translator.email, status: 'failed', reason: mailErr.message, count: tOrders.length };
          }
        })()
      );
    }

    const results = await Promise.allSettled(sendTasks);

    // 拍平：Promise.allSettled 包裹的是 fulfilled/rejected 状态，fulfilled.value 才是结果
    const flatResults = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      // 理论不会到这（内部已 try-catch），兜底用 byTranslator key 算出 tid
      const tid = Array.from(byTranslator.keys())[i];
      return { translatorId: tid, translatorEmail: null, status: 'failed', reason: r.reason?.message || '未知错误' };
    });

    console.log('send-batch-import-email complete:', {
      batchId,
      total: flatResults.length,
      sent: flatResults.filter(r => r.status === 'sent').length,
      failed: flatResults.filter(r => r.status === 'failed').length,
      skipped: flatResults.filter(r => r.status === 'skipped').length,
    });

    // 汇总返回
    // 关键修复（2026-09-24）：必须从 flatResults.filter 算，不能用 results.filter
    // 因为 Promise.allSettled 的 r.status 只有 'fulfilled' / 'rejected'，
    // 永远不会是 'sent' / 'skipped' / 'failed'（那些是 flatResults[i].status）
    // 之前这里写错，导致前端 modal 顶部 notifiedTranslators 等数字永远是 0
    const sentCount = flatResults.filter(r => r.status === 'sent').length;
    const skippedCount = flatResults.filter(r => r.status === 'skipped').length;
    const failedCount = flatResults.filter(r => r.status === 'failed').length;

    return corsResponse(200, {
      // 修复（2026-09-24）：success 必须是真正有 sent，不能只看 failedCount
      // 当所有译员都 skipped（不是 failed）时，failedCount=0、sentCount=0，
      // 之前 success=true 让前端以为一切正常，实际没人收到邮件
      success: sentCount > 0,
      partial: sentCount > 0 && failedCount > 0,
      totalOrders: pendingOrders.length,
      totalTranslators: byTranslator.size,
      notifiedTranslators: sentCount,
      skippedTranslators: skippedCount,
      failedTranslators: failedCount,
      results: flatResults,
    });
  } catch (e) {
    console.error('send-batch-import-email unhandled:', e);
    return corsResponse(500, { error: '批量邮件发送失败：' + e.message });
  }
};