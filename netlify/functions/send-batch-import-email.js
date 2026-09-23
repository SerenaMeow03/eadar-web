// netlify/functions/send-batch-import-email.js
// V11 批量导入链路：admin 用 Excel 一次导入 N 个订单（可能多个译员）→ 按 translator_id 分组 → 每个译员发 1 封汇总邮件
// 由 admin/orders.html 的 confirmImport() 在循环调完 save-order 后触发一次
//
// 设计要点：
//   1) 按 translator_id 分组：N 条订单可能指派给 5 个译员 → 发 5 封邮件（每封含该译员的订单列表）
//   2) 复用 BATCH_ORDER_ASSIGNED 模板（与批量派单同一模板，译员体验一致）
//   3) 每个译员单独检查 order_assigned 通知偏好，关闭的跳过（不阻塞其他译员）
//   4) 失败非阻塞：单个译员 SMTP 失败不影响其他译员，主流程返回 partial_success 状态
//   5) 输入支持 batchId（推荐）或 orderIds[]（兼容旧调用）
//
// 与 send-batch-order-email.js 的区别：
//   - send-batch-order-email：业务上批量派单必然是同一个译员，发 1 封
//   - send-batch-import-email：批量导入可能多个译员，发 N 封

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate } = require('./_shared/auth');
const { buildBatchOrderAssignedEmail } = require('./_shared/email-templates');
const { checkPreference } = require('./_shared/notifications');
const { logEmailFailed } = require('./_shared/email-log');
const nodemailer = require('nodemailer');

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
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = Number(process.env.SMTP_PORT || 465);
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpHost || !smtpUser || !smtpPass) {
    return corsResponse(500, { error: 'SMTP 未配置' });
  }

  const service = getServiceClient();

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

    // 创建 transporter（一次连接，所有邮件复用）
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });

    // 逐译员发邮件（互不影响：失败 catch 后继续下一个）
    const results = [];
    for (const [tid, tOrders] of byTranslator) {
      const translator = tOrders[0].translators;
      if (!translator?.email) {
        results.push({ translatorId: tid, translatorEmail: null, status: 'skipped', reason: '译员无邮箱' });
        continue;
      }

      // 通知偏好检查（每个译员单独判断，关闭的不发）
      const enabled = await checkPreference(service, translator.email, 'translator', 'order_assigned');
      if (!enabled) {
        console.log('send-batch-import-email skipped: translator disabled order_assigned:', translator.email, 'count:', tOrders.length);
        results.push({ translatorId: tid, translatorEmail: translator.email, status: 'skipped', reason: '已关闭"订单分配"通知', count: tOrders.length });
        continue;
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
        results.push({ translatorId: tid, translatorEmail: translator.email, status: 'sent', messageId: info.messageId, count: tOrders.length });
        console.log('send-batch-import-email sent:', info.messageId, 'translator:', translator.email, 'count:', tOrders.length, 'batchId:', batchId);
      } catch (mailErr) {
        results.push({ translatorId: tid, translatorEmail: translator.email, status: 'failed', reason: mailErr.message, count: tOrders.length });
        console.error('send-batch-import-email mail failed for translator', translator.email, ':', mailErr.message);
        // 邮件失败留痕：admin 后台 audit_logs 查 action='email_send_failed' + translatorId 定位
        // batchId 作为 target_id 聚合整个批次的所有失败（partial failure 也好排查）
        await logEmailFailed(service, {
          batchId,
          emailType: 'batch_import_assigned',
          to: translator.email,
          error: mailErr,
          translatorId: tid,
        });
      }
    }

    // 汇总返回
    const sentCount = results.filter(r => r.status === 'sent').length;
    const skippedCount = results.filter(r => r.status === 'skipped').length;
    const failedCount = results.filter(r => r.status === 'failed').length;

    return corsResponse(200, {
      success: failedCount === 0,
      partial: failedCount > 0 && sentCount > 0,
      totalOrders: pendingOrders.length,
      totalTranslators: byTranslator.size,
      notifiedTranslators: sentCount,
      skippedTranslators: skippedCount,
      failedTranslators: failedCount,
      results,
    });
  } catch (e) {
    console.error('send-batch-import-email unhandled:', e);
    return corsResponse(500, { error: '批量邮件发送失败：' + e.message });
  }
};