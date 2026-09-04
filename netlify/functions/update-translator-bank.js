// netlify/functions/update-translator-bank.js
// 译员：更新自己的银行卡信息

const { getServiceClient } = require('./_shared/supabase');
const { corsResponse, preflight, authenticate, requireMethod, parseBody } = require('./_shared/auth');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const methodErr = requireMethod(event, 'POST');
  if (methodErr) return methodErr;

  const auth = await authenticate(event, 'translator');
  if (auth.error) return auth.error;

  if (!auth.translatorId) {
    return corsResponse(403, { error: '译员档案未找到' });
  }

  const body = parseBody(event);
  if (!body) {
    return corsResponse(400, { error: 'Invalid JSON body' });
  }

  const { bankName, bankCard, bankHolder, bankBranch } = body;

  // 必填校验
  if (!bankName || !bankCard || !bankHolder) {
    return corsResponse(400, { error: '开户银行、银行卡号、开户人姓名为必填项' });
  }

  // 银行卡号简单格式校验（13-19 位数字）
  if (!/^\d{13,19}$/.test(bankCard.replace(/\s/g, ''))) {
    return corsResponse(400, { error: '银行卡号格式不正确' });
  }

  const service = getServiceClient();

  try {
    const { data, error } = await service
      .from('translators')
      .update({
        bank_info: {
          bankName: String(bankName).trim(),
          bankCard: String(bankCard).replace(/\s/g, '').trim(),
          bankHolder: String(bankHolder).trim(),
          bankBranch: bankBranch ? String(bankBranch).trim() : '',
          updatedAt: new Date().toISOString(),
        },
      })
      .eq('id', auth.translatorId)
      .select('bank_info')
      .single();

    if (error) {
      console.error('update-translator-bank error:', error);
      return corsResponse(500, { error: error.message });
    }

    return corsResponse(200, { data, message: '银行信息已更新' });
  } catch (e) {
    console.error('update-translator-bank unhandled:', e);
    return corsResponse(500, { error: e.message });
  }
};
