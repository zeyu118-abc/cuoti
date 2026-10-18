// 国网错题本 · 同域名私人 AI 接口（Cloudflare Pages 高级模式 _worker.js）
// 部署：本文件放在网站根目录（和 index.html 同级），随 cuoti-web 整个文件夹上传。
// Pages 项目环境变量（设置 → 变量和机密）：
//   DEEPSEEK_API_KEY（机密）DeepSeek API Key
//   AI_TOKEN（机密）只有你自己知道的解锁口令
//   DEEPSEEK_MODEL（文本，可选）默认 deepseek-flash

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function messageText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : (part && part.text) || ''))
      .join('');
  }
  return '';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/ai' || url.pathname === '/api/ai/') {
      return handleAI(request, env);
    }

    // 其它请求照常返回网页静态文件
    return env.ASSETS.fetch(request);
  },
};

async function handleAI(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        Allow: 'GET, POST, OPTIONS',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  const auth = request.headers.get('Authorization') || '';
  const authorized = !!env.AI_TOKEN && auth === 'Bearer ' + env.AI_TOKEN;

  // GET 只用于验证口令，不调用 DeepSeek，不产生费用。
  // 前端只有验证通过后才显示 AI 按钮，别的设备猜错口令也不会出现按钮。
  if (request.method === 'GET') {
    return authorized ? json({ ok: true }, 200) : json({ error: '未授权' }, 401);
  }
  if (request.method !== 'POST') return json({ error: '只支持 POST' }, 405);
  if (!authorized) return json({ error: '未授权' }, 401);

  if (!env.DEEPSEEK_API_KEY) {
    return json({ error: '服务端未配置 API Key' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON 格式错误' }, 400);
  }

  const question = String(body.question || '').trim();
  if (!question) return json({ error: '题目为空' }, 400);
  if (question.length > 3000) return json({ error: '题目过长' }, 413);

  const type = ['single', 'multiple', 'judge'].includes(body.type) ? body.type : 'single';
  const typeName = { single: '单选题', multiple: '多选题', judge: '判断题' }[type];
  const options = (Array.isArray(body.options) ? body.options : [])
    .slice(0, 4)
    .map((o) => ({
      label: String(o.label || '').slice(0, 1),
      text: String(o.text || '').trim().slice(0, 500),
    }));
  const answer = (Array.isArray(body.answer) ? body.answer : []).map(String).slice(0, 4);
  const answerText = options
    .filter((o) => answer.includes(o.label))
    .map((o) => o.text)
    .join('；');
  const optionText = options.map((o) => o.label + '. ' + o.text).join('\n');

  const messages = [
    {
      role: 'system',
      content:
        '你是国家电网招聘考试的辅导老师。用简体中文回答：' +
        '1) 第一行写「答案：」，后接正确选项字母，多个用「、」隔开，例如「答案：A、C」；' +
        '2) 选项字母一律以本条消息给出的选项顺序为准；每个选项单独一行，行首写「字母. 」，后面写「对：原因」或「错：原因」，先说结论再说原因；正文里提到其它选项时统一写「选项X」，不要只写单个字母；' +
        '3) 有公式或计算必须写公式，公式一律用普通字符直接打成一行，方便复制，不要用 LaTeX 或反斜杠写法（禁止出现 \\( \\)、\\[ \\]、\\propto、\\frac、\\times 等标记）。示例：Tm ∝ U1²、Tm ∝ 1/(X1+X2′)、sm ∝ R2；每个公式后面用一句话说明符号含义（如「Tm 是最大转矩，U1 是定子电压」）；' +
        '4) 计算题按「公式 → 代入数字 → 得出结果」一步步写清楚；' +
        '5) 答案以题目给定的正确答案为准，不要编造；' +
        '6) 全文控制在 200 字以内。',
    },
    {
      role: 'user',
      content:
        '题型：' + typeName +
        '\n题干：' + question +
        '\n选项：\n' + optionText +
        '\n给定正确答案：' + answer.join('、') +
        (answerText ? '（对应内容：' + answerText + '）' : '') +
        '\n\n请按上面的选项顺序解析这道题。',
    },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    let content = '';
    let finishReason = '';
    // 推理型模型可能把额度先花在思考上，导致正文为空：自动重试一次
    for (let attempt = 0; attempt < 2 && !content; attempt++) {
      const resp = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + env.DEEPSEEK_API_KEY,
        },
        body: JSON.stringify({
          model: env.DEEPSEEK_MODEL || 'deepseek-flash',
          messages,
          temperature: 0.3,
          max_tokens: 3000,
          stream: false,
        }),
        signal: controller.signal,
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        console.error('DeepSeek error', resp.status, data);
        return json({ error: 'AI 服务错误（' + resp.status + '）' }, 502);
      }
      const choice = (data.choices && data.choices[0]) || {};
      finishReason = choice.finish_reason || '';
      content = messageText(choice.message).trim();
      if (!content) {
        console.error('DeepSeek empty content', finishReason, JSON.stringify(data).slice(0, 500));
      }
    }
    if (!content) {
      return json(
        { error: finishReason === 'length' ? 'AI 回答被截断，请重试' : 'AI 没有返回内容，请重试' },
        502
      );
    }
    return json({ content }, 200);
  } catch (e) {
    return json(
      { error: e.name === 'AbortError' ? 'AI 响应超时' : 'AI 请求失败' },
      504
    );
  } finally {
    clearTimeout(timer);
  }
}
