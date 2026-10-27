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

const MAX_IMAGE_CHARS = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_CHARS = 16 * 1024 * 1024;
const MAX_BODY_CHARS = 24 * 1024 * 1024;

// 只接受压缩后的本地位图 data URL 或公网 http(s) 图片，其它一律丢弃
function normalizeImage(value) {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  if (!s) return '';
  if (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(s)) {
    return s.length <= MAX_IMAGE_CHARS ? s : '';
  }
  if (/^https?:\/\/\S+$/i.test(s) && s.length <= 8192) return s;
  return '';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/ai' || url.pathname === '/api/ai/') {
      return handleAI(request, env);
    }
    // 未知 /api 路径不要被 Pages 的 SPA 回退成首页 HTML
    if (url.pathname.startsWith('/api/')) {
      return json({ error: '接口不存在' }, 404);
    }

    // 其它请求照常返回网页静态文件
    const asset = await env.ASSETS.fetch(request);
    // 带扩展名的资源缺失时，Pages 可能回退 index.html；不能让浏览器把 HTML 当 JS/CSS
    if (asset.status === 200 && /\.[a-z0-9]+$/i.test(url.pathname) &&
        (asset.headers.get('content-type') || '').includes('text/html')) {
      return new Response('Not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    return asset;
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
    // 先看 Content-Length；再对实际文本做一次上限检查，避免超大 JSON 占满 Worker 内存
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_BODY_CHARS) return json({ error: '请求体过大' }, 413);
    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_CHARS) return json({ error: '请求体过大' }, 413);
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: 'JSON 格式错误' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'JSON 格式错误' }, 400);
  }

  const question = String(body.question || '').trim();
  const questionImageRaw = normalizeImage(body.questionImage);
  if (!question && !questionImageRaw) return json({ error: '题目为空' }, 400);
  if (question.length > 3000) return json({ error: '题目过长' }, 413);

  const type = ['single', 'multiple', 'judge'].includes(body.type) ? body.type : 'single';
  const typeName = { single: '单选题', multiple: '多选题', judge: '判断题' }[type];
  const options = (Array.isArray(body.options) ? body.options : [])
    .slice(0, 4)
    .map((raw) => {
      const o = (raw && typeof raw === 'object') ? raw : {};
      return {
        label: String(o.label || '').slice(0, 1),
        text: String(o.text || '').trim().slice(0, 500),
        image: normalizeImage(o.image),
      };
    });

  // 图片总大小限制在 16MB 内（控制 Worker 内存与上传耗时，远低于 DeepSeek 48MB 上限）
  let imageBudget = MAX_TOTAL_IMAGE_CHARS;
  const takeImage = (img) => {
    if (!img || img.length > imageBudget) return '';
    imageBudget -= img.length;
    return img;
  };
  const questionImage = takeImage(questionImageRaw);
  options.forEach((o) => { o.image = takeImage(o.image); });

  const answer = (Array.isArray(body.answer) ? body.answer : []).map(String).slice(0, 4);
  const answerText = options
    .filter((o) => answer.includes(o.label))
    .map((o) => o.text)
    .join('；');
  const optionText = options.map((o) => o.label + '. ' + o.text).join('\n');
  const hasImages = !!questionImage || options.some((o) => o.image);

  const userText =
    '题型：' + typeName +
    '\n题干：' + question +
    '\n选项：\n' + optionText +
    '\n给定正确答案：' + answer.join('、') +
    (answerText ? '（对应内容：' + answerText + '）' : '') +
    '\n\n请按上面的选项顺序解析这道题。' +
    (hasImages ? '\n（题干和选项的配图已附在下方，请结合图片内容作答；看不清就说看不清，不要编造图片内容。）' : '');

  let userContent = userText;
  if (hasImages) {
    userContent = [{ type: 'text', text: userText }];
    if (questionImage) {
      userContent.push({ type: 'text', text: '题干配图：' });
      userContent.push({ type: 'image_url', image_url: { url: questionImage, detail: 'high' } });
    }
    options.forEach((o) => {
      if (!o.image) return;
      userContent.push({ type: 'text', text: '选项' + o.label + '配图：' });
      userContent.push({ type: 'image_url', image_url: { url: o.image, detail: 'high' } });
    });
  }

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
        '6) 题目或选项附有图片时，必须结合图片内容解析；图片看不清就直说，不要编造图片里的内容；' +
        '7) 全文控制在 200 字以内。',
    },
    {
      role: 'user',
      content: userContent,
    },
  ];

  const controller = new AbortController();
  // 比客户端总超时（140 秒）略长，保证超时由前端先提示，服务端不会先掐断流
  const timer = setTimeout(() => controller.abort(), 150000);

  let upstream;
  try {
    upstream = await fetch(DEEPSEEK_URL, {
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
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return json(
      { error: e.name === 'AbortError' ? 'AI 响应超时' : '无法连接 AI 服务' },
      504
    );
  }

  if (!upstream.ok) {
    clearTimeout(timer);
    const data = await upstream.json().catch(() => ({}));
    console.error('DeepSeek error', upstream.status, data);
    return json({ error: 'AI 服务错误（' + upstream.status + '）' }, 502);
  }

  const contentType = upstream.headers.get('content-type') || '';
  // 万一上游没按流式返回，退化成一次性 JSON
  if (!contentType.includes('text/event-stream') || !upstream.body) {
    clearTimeout(timer);
    const data = await upstream.json().catch(() => ({}));
    const choice = (data.choices && data.choices[0]) || {};
    const content = messageText(choice.message).trim();
    if (!content) {
      return json(
        { error: choice.finish_reason === 'length' ? 'AI 回答被截断，请重试' : 'AI 没有返回内容，请重试' },
        502
      );
    }
    return json({ content }, 200);
  }

  // 边生成边转发：浏览器先看到字，长请求也不容易被网络中断
  const stream = upstream.body.pipeThrough(
    new TransformStream({
      flush() { clearTimeout(timer); },
      cancel() { clearTimeout(timer); controller.abort(); },
    })
  );

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
