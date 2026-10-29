// ============ 常量与状态 ============
const LABELS_ALL = ['A', 'B', 'C', 'D'];
const LABELS_JUDGE = ['A', 'B'];

// 导入题不一定都是四选项：2/3 选项的单选/多选也要能进错题本。
// 有显式 A/B/C 标签时按标签；没有标签的数组按顺序取 A..；判断固定 A/B。
function resolveOptionLabels(raw, type, rawOpts) {
  if (type === 'judge') return LABELS_JUDGE;
  let explicit = [];
  if (Array.isArray(rawOpts)) {
    explicit = rawOpts
      .filter((o) => o && typeof o === 'object' && o.label != null)
      .map((o) => normalizeLabel(String(o.label)))
      .filter((l) => LABELS_ALL.includes(l));
  } else if (rawOpts && typeof rawOpts === 'object') {
    explicit = Object.keys(rawOpts)
      .map((k) => normalizeLabel(k))
      .filter((l) => LABELS_ALL.includes(l));
  }
  explicit = [...new Set(explicit)].sort();
  if (explicit.length >= 2 && explicit.length <= 3) return explicit;
  if (Array.isArray(rawOpts) && rawOpts.length >= 2 && rawOpts.length <= 3) {
    return LABELS_ALL.slice(0, rawOpts.length);
  }
  return LABELS_ALL;
}
// 错题来源科目（手动录入题可选标签，共 8 科）
const SUBJECTS = ['电路', '电机', '电分', '继保', '高压', '设备', '电力电子', '行测'];
const INTERVALS = [1, 3, 7, 15, 30, 60]; // 艾宾浩斯复习间隔（天）
const MASTER_STAGE = INTERVALS.length; // 6 = 已掌握

const state = {
  type: 'single',
  options: [{ text: '', image: '' }, { text: '', image: '' }, { text: '', image: '' }, { text: '', image: '' }],
  answer: [],
  questionImage: '',
  editingId: null, // 正在编辑的题目 id，null 表示新增
  byType: {}, // 每种题型独立保存选项内容（单选/多选共享「choice」，判断用「judge」）
  subject: null, // 错题来源科目（null = 未分类）
};

// 复习会话队列，每项 { q, status, kind, retry, order, labels, contents, currentAnswer, selectedAnswer }
//   status: 'pending'未做 | 'correct'对 | 'wrong'错
//   kind:   'main'首次复习 | 'redo'错题重做
//   retry:  答题卡点进的手动重做（提交写对错统计，不改复习轮次/下次日期）
const reviewQueue = [];
let reviewIndex = 0;
let reviewTotal = 0;  // 本次会话的首次到期题数（答题卡序号上限）
let isBrowsing = false; // 回看模式：做完所有题后从完成页「回看今日题目」进入，最后一道不再显示「完成」
let isTrophyRedo = false; // 从完成页「回看今日错题」进入的重做模式：底部始终显示返回，直接回完成页
let trophyRedoIds = []; // 完成页「今日错题」按钮对应的题目 id，重做答对后本次完成页仍保留入口
let sessionAtTrophy = false; // 当前会话停在完成页：刷新后仍显示奖杯，而不是误入错题重做
let reviewSessionDate = ''; // 当前复习会话的日期。跨天时不能跟着系统日期变，否则会漏掉今天到期的题
let reviewAutoTimer = null; // 复习答对后自动跳下一题的定时器
const REVIEW_AUTO_NEXT_DELAY = 400; // 让「回答正确」先露一下，再自动跳题
const AUTO_NEXT_KEY = 'cuoti.autoNext'; // 答对自动下一题：全局开关（复习 + 题库共用）

const $ = (sel) => document.querySelector(sel);

function autoNextEnabled() {
  try {
    const v = localStorage.getItem(AUTO_NEXT_KEY);
    return v === null ? true : v === '1';
  } catch (e) {
    return true;
  }
}

function updateAutoNextUI() {
  const btn = $('#auto-next-toggle');
  const stateEl = $('#auto-next-state');
  if (!btn || !stateEl) return;
  const on = autoNextEnabled();
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  stateEl.textContent = on ? '开' : '关';
  stateEl.className = 'shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ' +
    (on ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500');
}

function setAutoNextEnabled(on) {
  try { localStorage.setItem(AUTO_NEXT_KEY, on ? '1' : '0'); } catch (e) {}
  if (!on) {
    clearReviewAutoTimer();
    clearBankAutoTimer();
  }
  updateAutoNextUI();
}

function clearReviewAutoTimer() {
  if (reviewAutoTimer) {
    clearTimeout(reviewAutoTimer);
    reviewAutoTimer = null;
  }
}

function typeLabel(type) {
  return type === 'multiple' ? '多选' : type === 'judge' ? '判断' : '单选';
}

// 题干左侧的题型徽标：颜色区分，字号比题目略小但加粗，保证一眼能看到
function applyTypeBadge(el, type) {
  if (!el) return;
  el.textContent = typeLabel(type);
  el.className = 'type-pill ' + (type === 'multiple' ? 'multiple' : type === 'judge' ? 'judge' : 'single');
}

// 图片压缩是异步的：用代次号丢弃「已切走/已换题」的旧结果，处理中禁止保存
let imageFormToken = 0;
let imageTasks = 0;
// 长截图保护：同时限制宽度、高度和总像素，避免 canvas 超过浏览器上限或内存爆掉
const IMAGE_MAX_PIXELS = 8 * 1024 * 1024;
const IMAGE_MAX_HEIGHT = 8192;
let longImageWarned = false;

// ============ IndexedDB 数据层 ============
const DB_NAME = 'cuoti';
const DB_VERSION = 1;
const SESSION_KEY = 'cuoti.review.session'; // 每日复习会话（localStorage）
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('questions')) {
        const store = db.createObjectStore('questions', { keyPath: 'id', autoIncrement: true });
        store.createIndex('next_review', 'next_review');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      // 打开失败时清掉缓存的 Promise，下一次调用可以重试
      dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      // 另一个标签页占着旧版本数据库时可能被阻塞，提示用户而不是一直卡住
      dbPromise = null;
      reject(new Error('数据库被其他错题本页面占用，请关闭其它标签页后重试'));
    };
  });
  return dbPromise;
}

function isQuestionContentComplete(q) {
  if (!q || typeof q !== 'object') return false;
  if (!['single', 'multiple', 'judge'].includes(q.type)) return false;
  const hasStem = String(q.question_text || '').trim().length > 0 || !!q.question_image;
  if (!hasStem) return false;
  const options = Array.isArray(q.options) ? q.options : [];
  if (options.length < 2 || options.length > 4) return false;
  if (options.some((o) => !o || (!String(o.text || '').trim() && !o.image))) return false;
  const labels = new Set(options.map((o) => String(o.label || '')));
  if (!Array.isArray(q.answer) || q.answer.length === 0) return false;
  return q.answer.every((a) => labels.has(String(a)));
}

async function dbAdd(q) {
  if (!isQuestionContentComplete(q)) throw new Error('题目内容不完整，不能保存');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('questions', 'readwrite');
    const req = tx.objectStore('questions').add(q);
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
async function dbPut(q) {
  if (!isQuestionContentComplete(q)) throw new Error('题目内容不完整，不能保存');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('questions', 'readwrite');
    const store = tx.objectStore('questions');
    let missing = false;
    // put 是 upsert：如果别的标签页已经删了这道题，旧页面再提交会把题“复活”。
    // 先确认记录还在，再更新；不存在就报错，让调用方提示，而不是重建。
    const getReq = store.get(q.id);
    getReq.onsuccess = () => {
      if (getReq.result === undefined) {
        missing = true;
        tx.abort();
        return;
      }
      store.put(q);
    };
    tx.oncomplete = () => resolve(q.id);
    tx.onerror = () => {
      if (missing) reject(new Error('题目已不存在（可能已在其它标签页删除）'));
      else reject(tx.error);
    };
    tx.onabort = () => {
      if (missing) reject(new Error('题目已不存在（可能已在其它标签页删除）'));
      else reject(tx.error);
    };
  });
}
async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('questions', 'readonly');
    const req = tx.objectStore('questions').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('questions', 'readwrite');
    tx.objectStore('questions').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ============ 复习会话持久化（localStorage） ============
function getSavedSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function saveSession() {
  // 队列为空说明今天没有进行中的复习，清掉会话
  if (reviewQueue.length === 0) {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    return;
  }
  const session = {
    // 用会话自己的日期，不要每次保存都改成“今天”：否则跨天后旧队列会被当成今天，今天的到期题就漏了
    date: reviewSessionDate || fmtDate(new Date()),
    atTrophy: sessionAtTrophy,
    trophyRedo: isTrophyRedo,
    browsing: isBrowsing,
    index: reviewIndex,
    items: reviewQueue.map((it) => ({
      id: it.q.id,
      kind: it.kind,
      status: it.status,
      firstStatus: it.firstStatus || null,
      seq: it.seq != null ? it.seq : null,
      order: it.order || null,
      selectedAnswer: it.selectedAnswer || [],
      prevSelected: it.prevSelected || null,
      prevState: it.prevState || null,
      labels: it.labels || null,
    })),
  };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {}
}

// 从保存的会话重建队列；返回 true 表示恢复成功
function restoreSession(saved, all) {
  const byId = new Map(all.map((q) => [q.id, q]));
  const items = [];
  const savedItems = Array.isArray(saved.items) ? saved.items : [];
  for (const s of savedItems) {
    if (!s || typeof s !== 'object') continue;
    const q = byId.get(s.id);
    if (!q) continue; // 题目已被删除，跳过
    items.push({
      q,
      kind: s.kind === 'redo' ? 'redo' : 'main',
      status: ['pending', 'correct', 'wrong'].includes(s.status) ? s.status : 'pending',
      firstStatus: ['correct', 'wrong'].includes(s.firstStatus) ? s.firstStatus : null,
      retry: false,
      seq: typeof s.seq === 'number' ? s.seq : null,
      order: Array.isArray(s.order) ? s.order : null,
      selectedAnswer: Array.isArray(s.selectedAnswer) ? s.selectedAnswer : [],
      prevSelected: Array.isArray(s.prevSelected) ? s.prevSelected : null,
      prevState: s.prevState && typeof s.prevState === 'object' ? s.prevState : null,
      labels: Array.isArray(s.labels) ? s.labels : null,
    });
  }
  if (items.length === 0) return false;
  reviewSessionDate = typeof saved.date === 'string' ? saved.date : fmtDate(new Date());
  reviewQueue.length = 0;
  reviewQueue.push(...items);
  // 恢复后重排主题目序号：无论从复习内还是从列表/详情删除题目，下次进入复习序号都保持连续
  reviewQueue
    .filter((x) => x.kind === 'main')
    .sort((a, b) => (a.seq || 0) - (b.seq || 0))
    .forEach((it, i) => { it.seq = i; });
  reviewTotal = items.filter((x) => x.kind === 'main').length;
  const savedIndex = typeof saved.index === 'number' ? saved.index : 0;
  reviewIndex = Math.max(0, Math.min(savedIndex, reviewQueue.length - 1));
  isBrowsing = saved.browsing === true && saved.atTrophy !== true;
  return true;
}

// 全新会话：按每日确定顺序构建队列
function buildFreshSession(all, today) {
  const due = orderByStage(all.filter((q) => q.next_review && q.next_review <= today));
  reviewSessionDate = today;
  reviewQueue.length = 0;
  due.forEach((q, i) => reviewQueue.push({
    q, status: 'pending', kind: 'main', retry: false, seq: i,
    order: null, selectedAnswer: [],
  }));
  reviewIndex = 0;
  reviewTotal = due.length;
}

// 补齐「今天已复习但不在队列里」的题（如更新版本前用旧版本做的），作为已作答纳入答题卡
function ensureDoneToday(all, today) {
  const inQueue = new Set(reviewQueue.map((x) => x.q.id));
  const done = all.filter((q) => q.last_reviewed === today && !inQueue.has(q.id));
  if (done.length === 0) return;
  let maxSeq = -1;
  reviewQueue.forEach((x) => { if (x.seq != null && x.seq > maxSeq) maxSeq = x.seq; });
  done.forEach((q) => {
    maxSeq += 1;
    reviewQueue.push({
      q,
      status: q.last_result === 'correct' ? 'correct' : 'wrong',
      kind: 'main', retry: false, seq: maxSeq,
      order: null, selectedAnswer: [],
    });
  });
  reviewTotal = reviewQueue.filter((x) => x.kind === 'main').length;
}

// ============ 工具 ============
function toast(msg, ok = true) {
  const el = $('#toast');
  el.textContent = msg;
  el.style.background = ok ? '#1e293b' : '#dc2626';
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.style.opacity = '0'), 2400);
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
// 真正的日历日期校验：2026-99-99、2026-02-30 这类格式对但日期不存在的值会被拒绝
function isRealDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function sameSet(a, b) {
  if (a.length !== b.length) return false;
  return a.slice().sort().join() === b.slice().sort().join();
}

// ============ Tab 切换 ============
function switchTab(name, reload = true) {
  // 点「录入」页签始终回到文字录入顶层，避免停留在 JSON 子界面
  if (name === 'input') {
    $('#input-json').classList.add('hidden');
    $('#input-paste').classList.remove('hidden');
    $('#json-text').value = '';
  }
  // 离开录入页时自动清空未保存内容（文字与 JSON），并复位到「文字录入」子界面
  if (name !== 'input') {
    resetInput();
    $('#json-text').value = '';
    $('#input-json').classList.add('hidden');
    $('#input-paste').classList.remove('hidden');
  }
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
  $('#tab-' + name).classList.remove('hidden');
  // 切页签时关掉普通弹层；相似题确认弹层不关（它还在等用户选“跳过/仍要保存”）
  ['#answer-sheet-modal', '#subject-modal', '#ai-modal'].forEach((sel) => {
    const el = $(sel);
    if (el) el.classList.add('hidden');
  });
  // 切页签时先收起左右翻题按钮，避免 fixed 按钮在移动端残留闪烁
  $('#prev-question').classList.add('hidden');
  $('#next-question').classList.add('hidden');
  $('#bank-prev').classList.add('hidden');
  $('#bank-next').classList.add('hidden');
  clearReviewAutoTimer();
  clearBankAutoTimer();
  if (reload) {
    if (name === 'review') loadReview().catch((e) => toast('加载失败：' + e.message, false));
    if (name === 'list') loadList().catch((e) => toast('加载失败：' + e.message, false));
    if (name === 'bank') renderBankCategories();
  }
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => {
  // 有没保存的录入内容时先确认，避免手滑切页签把整道题清空
  if (isInputDirty() && !confirm('当前录入/JSON 内容还没保存，确定离开吗？')) return;
  // 用户主动点顶部页签离开子视图（详情/JSON 录入）时，丢弃遗留的返回栈，避免手机返回键乱跳
  if (backHandlers.length > 0) {
    history.go(-backHandlers.length);
    backHandlers.length = 0;
  }
  listPageBackCount = 0;
  // 点顶部页签 = 回到该页签顶层视图：列表页在主列表保持状态；若停在「行测/某科目」子视图，则回主列表
  if (b.dataset.tab !== 'list' || listView.mode !== 'all') {
    listView.mode = 'all';
    listView.subject = null;
    listView.typeFilter = 'all';
    listView.page = 1;
    listSelectMode = false;
    selectedIds.clear();
  }
  // 离开错题页时退出删除模式，避免下次回来还残留勾选
  if (b.dataset.tab !== 'list') {
    listSelectMode = false;
    selectedIds.clear();
  }
  switchTab(b.dataset.tab);
}));

// ============ 浏览器返回支持 ============
// 进入子视图（详情、JSON 录入等）时压入一个「返回处理函数」，
// 点返回按钮或浏览器返回（电脑 Alt+←、手机返回键/手势）都执行它，而不是退出网页
const backHandlers = [];

function pushBack(backFn) {
  backHandlers.push(backFn);
  history.pushState({ back: backHandlers.length }, '');
}

// 列表分页返回支持：每次翻到下一页都压入一个「回退一页」的处理，
// 让手机返回键/手势逐页回退（第 3 页→第 2 页→第 1 页），而不是退出网页或直接跳回第 1 页
let listPageBackCount = 0;
function pushListPageBack() {
  listPageBackCount++;
  pushBack(() => {
    listPageBackCount--;
    if (listView.page > 1) {
      listView.page--;
      loadList();
      window.scrollTo(0, 0);
    }
  });
}

window.addEventListener('popstate', () => {
  const backFn = backHandlers.pop();
  if (!backFn) return;
  // 手机返回键/浏览器后退也要走“未保存确认”，不能只保护页签点击
  if (isInputDirty() && !confirm('当前录入的内容还没保存，确定离开吗？')) {
    backHandlers.push(backFn);
    history.pushState({ back: backHandlers.length }, '');
    return;
  }
  backFn();
});
// 刷新/关闭页面时也提示（浏览器只显示通用文案，不能自定义）
window.addEventListener('beforeunload', (e) => {
  if (!isInputDirty()) return;
  e.preventDefault();
  e.returnValue = '';
});

// ============ 题型与选项 ============
function getLabels() {
  return state.type === 'judge' ? LABELS_JUDGE : LABELS_ALL;
}
function optionTypeKey(type) {
  return type === 'judge' ? 'judge' : 'choice';
}

function setType(type) {
  imageFormToken++; // 选项行会重建，丢弃尚未完成的旧压缩结果
  // 先保存当前题型的选项内容，切换后再切回时能完整恢复（含 C、D）
  state.byType[optionTypeKey(state.type)] = state.options.map((o) => ({ text: o.text || '', image: o.image || '' }));

  state.type = type;
  state.answer = [];
  const labels = getLabels();
  const saved = state.byType[optionTypeKey(type)];
  state.options = labels.map((_, i) => {
    const s = saved && saved[i];
    if (type === 'judge') {
      return { text: (s && s.text) || (i === 0 ? '正确' : '错误'), image: (s && s.image) || '' };
    }
    return { text: (s && s.text) || '', image: (s && s.image) || '' };
  });
  document.querySelectorAll('.type-btn').forEach((b) => b.classList.toggle('active', b.dataset.type === type));
  renderOptions();
}
document.querySelectorAll('.type-btn').forEach((b) => b.addEventListener('click', () => setType(b.dataset.type)));

// 错题来源科目选择器：未分类 + 7 个科目 + 行测
function renderSubjectSelector() {
  const wrap = $('#subject-selector');
  if (!wrap) return;
  wrap.innerHTML = '';
  const items = [{ key: null, label: '未分类' }, ...SUBJECTS.map((s) => ({ key: s, label: s }))];
  items.forEach((s) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'px-3 py-1.5 rounded-full text-xs font-medium transition ' +
      (state.subject === s.key ? 'bg-primary-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200');
    btn.textContent = s.label;
    btn.addEventListener('click', () => {
      state.subject = s.key;
      renderSubjectSelector();
    });
    wrap.appendChild(btn);
  });
}

function renderOptions() {
  const wrap = $('#options-wrap');
  wrap.innerHTML = '';
  const labels = getLabels();
  const isJudge = state.type === 'judge';
  labels.forEach((label, i) => {
    if (!state.options[i] || typeof state.options[i] !== 'object') {
      state.options[i] = { text: '', image: '' };
    }
    const opt = state.options[i];
    if (isJudge) {
      opt.text = i === 0 ? '正确' : '错误';
      opt.image = '';
    }

    const row = document.createElement('div');
    row.className = 'opt-row items-start';

    const letter = document.createElement('div');
    letter.className = 'opt-letter' + (state.answer.includes(label) ? ' selected' : '');
    letter.textContent = label;
    letter.addEventListener('click', () => toggleAnswer(label));

    const right = document.createElement('div');
    right.className = 'flex-1 min-w-0 space-y-1.5';

    if (isJudge) {
      // 判断题答案固定为「正确 / 错误」，不可修改、不可上传图片
      const fixed = document.createElement('div');
      fixed.className = 'w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700';
      fixed.textContent = opt.text;
      right.appendChild(fixed);
    } else {
      const inputWrap = document.createElement('div');
      inputWrap.className = 'relative';

      const input = document.createElement('input');
      input.id = 'opt-text-' + i;
      input.className = 'w-full rounded-lg border border-slate-300 px-3 pr-8 py-2 text-sm focus:ring-2 focus:ring-primary-300 focus:outline-none';
      input.value = opt.text || '';
      input.placeholder = '选项 ' + label;
      input.addEventListener('input', (e) => (opt.text = e.target.value));

      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'input-clear hidden absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600';
      clearBtn.dataset.target = '#opt-text-' + i;
      clearBtn.innerHTML = '<i class="fa fa-times-circle"></i>';
      if (input.value) clearBtn.classList.remove('hidden');
      inputWrap.appendChild(input);
      inputWrap.appendChild(clearBtn);

      const imgRow = document.createElement('div');
      imgRow.className = 'flex items-center gap-2';

      const preview = document.createElement('img');
      preview.className = 'rounded-lg border border-slate-200 max-h-20 max-w-full';
      if (opt.image) preview.src = opt.image;
      else preview.style.display = 'none';

      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'px-2.5 py-1.5 rounded-lg bg-slate-100 text-slate-600 text-xs font-medium hover:bg-slate-200 transition shrink-0';
      upBtn.innerHTML = '<i class="fa fa-image mr-1"></i>上传图片';

      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'px-2 py-1.5 rounded-lg text-red-500 text-xs font-medium hover:bg-red-50 transition shrink-0';
      rmBtn.innerHTML = '<i class="fa fa-trash-o"></i>';
      if (!opt.image) rmBtn.style.display = 'none';

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.className = 'hidden';

      upBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        const token = imageFormToken;
        imageTasks++;
        try {
          const data = await compressImage(file, 800);
          if (token !== imageFormToken) return; // 表单已切换，丢弃旧结果
          opt.image = data;
          preview.src = data;
          preview.style.display = '';
          rmBtn.style.display = '';
        } catch (e) {
          if (token === imageFormToken) toast('图片处理失败：' + e.message, false);
        } finally {
          imageTasks--;
        }
      });
      rmBtn.addEventListener('click', () => {
        opt.image = '';
        preview.src = '';
        preview.style.display = 'none';
        rmBtn.style.display = 'none';
      });

      imgRow.appendChild(preview);
      imgRow.appendChild(upBtn);
      imgRow.appendChild(rmBtn);

      right.appendChild(inputWrap);
      right.appendChild(imgRow);
    }

    row.appendChild(letter);
    row.appendChild(right);
    wrap.appendChild(row);
  });
  updateHint();
}

function toggleAnswer(label) {
  if (state.type === 'judge') {
    // 判断：单选模式，点一下确认，再点一下取消
    state.answer = state.answer.includes(label) ? [] : [label];
  } else {
    // 单选/多选统一：点一下确认，再点一下取消
    state.answer = state.answer.includes(label)
      ? state.answer.filter((x) => x !== label)
      : [...state.answer, label].sort();
    // 按已选答案数量自动判断题型：选 2 个及以上为多选，否则单选
    const newType = state.answer.length >= 2 ? 'multiple' : 'single';
    if (newType !== state.type) {
      state.type = newType;
      document.querySelectorAll('.type-btn').forEach((b) => b.classList.toggle('active', b.dataset.type === newType));
    }
  }
  document.querySelectorAll('.opt-letter').forEach((el) => {
    el.classList.toggle('selected', state.answer.includes(el.textContent));
  });
  updateHint();
}

function updateHint() {
  const hint = $('#answer-hint');
  if (state.type === 'multiple') hint.textContent = '点击左侧字母可多选正确答案，再点一次可取消';
  else if (state.type === 'judge') hint.textContent = 'A = 正确，B = 错误，再点一次可取消';
  else hint.textContent = '点击左侧字母选择唯一正确答案，再点一次可取消';
}

// ============ 拆分题干和选项 ============
const NUM_TO_LABEL = { '1': 'A', '2': 'B', '3': 'C', '4': 'D' };
const FULLWIDTH_LABEL = { 'Ａ': 'A', 'Ｂ': 'B', 'Ｃ': 'C', 'Ｄ': 'D' };
function normalizeLabel(raw) {
  let up = String(raw).toUpperCase();
  up = FULLWIDTH_LABEL[up] || up;
  return NUM_TO_LABEL[up] || up;
}

// 备份导入与 JSON 录入共用：把答案统一成标签数组，支持数组、单个字母、合并串 "AC"/"A,C"/"A、C"
function parseAnswerTokens(rawAnswer) {
  // 数组里也可能有 "AC" / "A,C" 这种合并串，逐个再拆，避免整条答案被当成非法标签
  if (Array.isArray(rawAnswer)) return rawAnswer.flatMap((x) => parseAnswerTokens(x));
  if (rawAnswer == null) return [];
  const s = String(rawAnswer).trim().toUpperCase();
  if (/^[A-D]{2,4}$/.test(s)) return s.split('');
  if (/^[A-D](?:[,，、\s]+[A-D])+$/.test(s)) return s.split(/[^A-D]+/).filter(Boolean);
  return [s];
}

function parseOptionLine(line) {
  let m;
  // 1) 数字序号 + 选项字母（如 "4B."、"1 A."）
  m = line.match(new RegExp('^([1-4])\\s*([A-Da-dＡ-Ｄａ-ｄ])\\s*[.、．:：)）]?\\s*(.+)$'));
  if (m && m[3] && m[3].trim()) return { label: normalizeLabel(m[2]), text: m[3].trim() };
  // 2) 选项字母在行首（如 "A."、"B、"、"B电网建设投资"）
  // 字母后跟中文/数字/符号：任何大小写都识别
  m = line.match(new RegExp('^([A-Da-dＡ-Ｄａ-ｄ])\\s*[.、．:：)）]?\\s*([^A-Za-zＡ-Ｚａ-ｚ].*)$'));
  if (m && m[2] && m[2].trim()) return { label: normalizeLabel(m[1]), text: m[2].trim() };
  // 大写字母后跟英文（如 "Carctan"）识别；小写字母后跟英文（如 "arctan"）不识别，避免误判成选项
  m = line.match(new RegExp('^([A-DＡ-Ｄ])\\s*[.、．:：)）]?\\s*([A-Za-zＡ-Ｚａ-ｚ].*)$'));
  if (m && m[2] && m[2].trim()) return { label: normalizeLabel(m[1]), text: m[2].trim() };
  // 小写选项字母后跟大写英文（如 "bPQ分解"、"cPQ分解"）识别；全小写英文（arctan）仍不识别
  m = line.match(new RegExp('^([a-dａ-ｄ])\\s*[.、．:：)）]?\\s*([A-ZＡ-Ｚ].*)$'));
  if (m && m[2] && m[2].trim()) return { label: normalizeLabel(m[1]), text: m[2].trim() };
  // 2b) 选项字母单独成行（如 "B"、"B."、"B、"），文字在下一行，text 先留空由后续补全
  m = line.match(new RegExp('^([A-Da-dＡ-Ｄａ-ｄ])\\s*[.、．:：)）]?\\s*$'));
  if (m) return { label: normalizeLabel(m[1]), text: '' };
  // 3) 数字选项在行首（如 "1."、"2、"）
  m = line.match(/^([1-4])\s*[.、．:：)）]?\s*(.+)$/);
  if (m && m[2] && m[2].trim()) return { label: normalizeLabel(m[1]), text: m[2].trim() };
  // 4) 行首杂符号前缀 + 选项字母（如 "‘ A."、"pC."、")D."、"O A."）
  m = line.match(new RegExp('^[^\\u4e00-\\u9fa5A-Da-d1-4Ａ-Ｄａ-ｄ]{1,6}?([A-Da-dＡ-Ｄａ-ｄ])\\s*[.、．:：)）]?\\s*(.+)$'));
  if (m && m[2] && m[2].trim()) return { label: normalizeLabel(m[1]), text: m[2].trim() };
  return null;
}

// 题干末尾粘连选项（如「题干信息。（）A采用…」）：提取行末粘连的选项，返回 { label, text, stem }
function extractTrailingOption(line) {
  const src = String(line || '');
  const re = /[A-Da-dＡ-Ｄａ-ｄ]/g;
  let m, last = null;
  while ((m = re.exec(src)) !== null) {
    const label = normalizeLabel(m[0]);
    const rest = src.slice(m.index + 1);
    const prev = src[m.index - 1];
    // 选项标记前必须是标点/空白/括号等边界，避免把题干里的「A相」「arctan」误判成选项
    const boundary = m.index === 0 || /[^\u4e00-\u9fa5A-Za-z0-9Ａ-Ｚａ-ｚ０-９]/.test(prev);
    if (!boundary) continue;
    const punct = rest.match(/^\s*[.、．:：)）]\s*/);
    if (punct) {
      last = { index: m.index, end: m.index + 1 + punct[0].length, label };
    } else if (/^[^\sA-Za-zＡ-Ｚａ-ｚ]/.test(rest) || (/^[A-ZＡ-Ｚ]/.test(rest) && /^[a-dａ-ｄ]$/.test(m[0]))) {
      // 没有标点时，如果后面是「相/线/侧/段…」或问句，更像是题干（A相短路…），不当作选项
      if (/^[相线侧段]/.test(rest) || /[？?]/.test(rest)) continue;
      last = { index: m.index, end: m.index + 1, label };
    }
  }
  if (!last) return null;
  const stem = src.slice(0, last.index).trim();
  const text = src.slice(last.end).trim();
  if (!stem || !text) return null;
  return { label: last.label, text, stem };
}

function splitQuestionOptions(text) {
  const src = String(text || '');
  const lines = src.split(/\r?\n/);

  // 1) 逐行解析候选选项（每行一个选项，手机识别最常见）
  const candidates = []; // {lineIdx, label, text}
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const parsed = parseOptionLine(line);
    if (parsed) candidates.push({ lineIdx: i, label: parsed.label, text: parsed.text });
  });

  if (candidates.length >= 2) {
    // 选项块起点：优先取最后一个标签为 A 的候选，
    // 避免「1. 题干」「A. 题干」这类以序号/字母开头的题干行被误判成选项，导致题干被吞。
    // 若没有 A（题干只剩 B/C/D 等后半段选项），则退回第一个候选，仍能继续拆分。
    let startIdx = -1;
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (candidates[i].label === 'A') { startIdx = i; break; }
    }
    // 若没有 A 候选，检查首个选项上一行是否粘连了选项 A（如「题干信息。（）a采用…」），
    // 是则把粘连的 A 从题干行末尾拆出来。
    let gluedA = null;
    if (startIdx === -1) {
      const firstLine = candidates[0].lineIdx;
      if (firstLine > 0) {
        const g = extractTrailingOption(lines[firstLine - 1]);
        if (g && g.label === 'A') { gluedA = g; startIdx = 0; }
      }
    }
    if (startIdx === -1) startIdx = 0;

    // 从起点收集严格递增的 A→B→C→D（也可能是 B→C→D、C→D 等后半段）
    const opts = [];
    let expect;
    if (gluedA) {
      opts.push({ label: 'A', text: gluedA.text, lineIdx: candidates[0].lineIdx - 1 });
      expect = 1; // 下一个应为 B
    } else {
      expect = LABELS_ALL.indexOf(candidates[startIdx].label);
    }
    for (let i = startIdx; i < candidates.length; i++) {
      const v = LABELS_ALL.indexOf(candidates[i].label);
      if (v === expect) {
        opts.push({ label: candidates[i].label, text: candidates[i].text, lineIdx: candidates[i].lineIdx });
        expect++;
        if (expect > 3) break;
      } else {
        break;
      }
    }

    if (opts.length >= 2) {
      // 选项文本换行时，把选项块内夹着的非选项行补到上一个选项末尾
      for (let i = 0; i < opts.length; i++) {
        const nextLine = i + 1 < opts.length ? opts[i + 1].lineIdx : lines.length;
        for (let li = opts[i].lineIdx + 1; li < nextLine; li++) {
          const t = lines[li].trim();
          if (t) opts[i].text = opts[i].text ? opts[i].text + '\n' + t : t;
        }
      }
      const firstLine = opts[0].lineIdx;
      const stemLines = lines.slice(0, firstLine).filter((l) => l.trim());
      if (gluedA && gluedA.stem) stemLines.push(gluedA.stem);
      return { stem: stemLines.join('\n'), options: opts.map((o) => ({ label: o.label, text: o.text })) };
    }
  }

  // 拆分进行到一半时，题干里可能只剩最后一个选项（如只剩 C 或 D）。
  // 单个选项也要能识别；标签为 A 时需前面有题干文本，避免把「1. 题干」这类序号误判成选项。
  if (candidates.length === 1) {
    const c = candidates[0];
    // 该行内可能挤着多个无标点选项（如「A10Ω B5×… C… D…」），优先按行内多选项拆分
    const inline = splitInlineLine(lines[c.lineIdx]);
    if (inline) {
      const stemLines = lines.slice(0, c.lineIdx).filter((l) => l.trim());
      let stem = stemLines.join('\n');
      if (inline.stem) stem = stem ? stem + '\n' + inline.stem : inline.stem;
      return { stem, options: inline.options };
    }
    const stemLines = lines.slice(0, c.lineIdx).filter((l) => l.trim());
    const rawLine = (lines[c.lineIdx] || '').trim();
    const explicitPunct = /^[A-Da-dＡ-Ｄａ-ｄ]\s*[.、．:：)）]/.test(rawLine);
    // 没写「A.」这种明确标点、后面又是「相/线/侧/段…」或问句时，按题干处理，避免把「A相短路…」拆成选项
    const looksLikeStem = c.label === 'A' && !explicitPunct &&
      (/^[相线侧段]/.test(c.text) || /[？?]/.test(c.text));
    if (!looksLikeStem && (c.label !== 'A' || stemLines.length > 0)) {
      return { stem: stemLines.join('\n'), options: [{ label: c.label, text: c.text }] };
    }
  }

  // 2) 一行内多选项（题干与选项同在一行）
  // 2a) 字母选项，支持有标点「A. xx B. xx」与无标点「A10Ω B5×… C… D…」
  const inline = splitInlineLine(src);
  if (inline) return inline;
  // 2b) 数字选项「1. xx 2. xx 3. xx」
  const markerRe = /([1-4])\s*[.、．:：)）]\s*/g;
  const marks = [];
  let m;
  while ((m = markerRe.exec(src)) !== null) {
    marks.push({ index: m.index, end: markerRe.lastIndex, label: normalizeLabel(m[1]) });
  }
  if (marks.length >= 2) {
    const stem = src.slice(0, marks[0].index).trim();
    const opts = [];
    for (let i = 0; i < marks.length; i++) {
      const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
      const content = src.slice(marks[i].end, end).trim();
      if (content) opts.push({ label: marks[i].label, text: content });
    }
    if (opts.length >= 2) return { stem, options: opts };
  }
  return null;
}

// 一行内多个选项（选项字母后可无标点，如「A10Ω B5×… C… D…」）
// 返回 { stem, options }；从最后一个 A 起收集严格递增的 A→B→C→D，避免题干里的零散字母干扰
function splitInlineLine(src) {
  const marks = [];
  const re = /[A-Da-dＡ-Ｄａ-ｄ]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const label = normalizeLabel(m[0]);
    const rest = src.slice(m.index + 1);
    const punct = rest.match(/^\s*[.、．:：)）]/);
    if (punct) {
      // 有标点：确定是选项标记，吞掉标点及其后空白
      const full = rest.match(/^\s*[.、．:：)）]\s*/);
      marks.push({ index: m.index, end: m.index + 1 + full[0].length, label });
    } else if (/^[^\sA-Za-zＡ-Ｚａ-ｚ]/.test(rest) || (/^[A-ZＡ-Ｚ]/.test(rest) && /^[a-dａ-ｄ]$/.test(m[0]))) {
      // 无标点：字母后紧跟非字母（数字/符号/中文），或小写选项字母后紧跟大写字母（如「bPQ」），
      // 才视为选项标记，避免把全小写英文单词（arctan 等）拆开
      marks.push({ index: m.index, end: m.index + 1, label });
    }
    // 否则（字母后仍是字母）视为单词的一部分，跳过
  }
  // 取最后一个 A 作为选项块起点
  let startIdx = -1;
  for (let i = marks.length - 1; i >= 0; i--) {
    if (marks[i].label === 'A') { startIdx = i; break; }
  }
  if (startIdx === -1) return null;
  const opts = [];
  let expect = LABELS_ALL.indexOf(marks[startIdx].label); // 0 = A
  for (let i = startIdx; i < marks.length; i++) {
    const v = LABELS_ALL.indexOf(marks[i].label);
    if (v === expect) {
      const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
      const content = src.slice(marks[i].end, end).trim();
      if (content) opts.push({ label: marks[i].label, text: content });
      expect++;
      if (expect > 3) break;
    } else if (v > expect) {
      break; // 中间跳号（如 A 后直接 C），停止
    }
    // v < expect：重复/回退标签，跳过继续找
  }
  if (opts.length < 2) return null;
  const stem = src.slice(0, marks[startIdx].index).trim();
  return { stem, options: opts };
}

// 英文标点统一转成中文标点（小数点、括号除外，括号保留半角用于计算式）
function toChinesePunctuation(text) {
  return String(text || '')
    .replace(/(\d)\.(\d)/g, '$1\u0000$2') // 先保护小数点
    .replace(/,/g, '，')
    .replace(/\./g, '。')
    .replace(/\uFF08/g, '(') // 全角左括号 → 半角
    .replace(/\uFF09/g, ')') // 全角右括号 → 半角
    .replace(/;/g, '；')
    .replace(/:/g, '：')
    .replace(/\?/g, '？')
    .replace(/!/g, '！')
    .replace(/\u0000/g, '.'); // 恢复小数点
}

function doSplit() {
  const rawText = $('#q-text').value;
  const parsed = splitQuestionOptions(rawText);
  if (!parsed) {
    // 未识别到选项：只做标点转换（解决单句话拆分后不换中文的问题），不自动切题型
    const cleaned = toChinesePunctuation(rawText.replace(/\s*\n\s*/g, ''));
    if (cleaned !== rawText) $('#q-text').value = cleaned;
    return toast('未识别到选项（形如 A. xxx / 1. xxx）', false);
  }
  // 清理识别文字：删除多余换行 + 英文标点转中文
  const clean = (s) => toChinesePunctuation(s.replace(/\s*\n\s*/g, ''));
  parsed.stem = clean(parsed.stem).replace(/[(（]\s*$/, '');
  for (const opt of parsed.options) opt.text = clean(opt.text);

  // 自动识别判断题：A 是「正确/对/√」，B 是「错误/错/×」，自动切到判断题型
  const optA = parsed.options.find((o) => o.label === 'A');
  const optB = parsed.options.find((o) => o.label === 'B');
  const isJudge = optA && optB &&
    /^(正确|对|√|✓)\s*[.、。]?$/.test((optA.text || '').trim()) &&
    /^(错误|错|×|✗)\s*[.、。]?$/.test((optB.text || '').trim());
  // 只有“正好两个选项”才自动切判断题；四选项题里 A=正确/B=错误 不能丢 C/D
  if (isJudge && parsed.options.length === 2 && state.type !== 'judge') {
    setType('judge');
    $('#q-text').value = parsed.stem;
    return;
  }

  $('#q-text').value = parsed.stem;
  const labels = getLabels();
  // 只把识别到的选项填到对应位置，其余已填写文字的选项保持不动，避免被清空覆盖
  for (const opt of parsed.options) {
    const idx = labels.indexOf(opt.label);
    if (idx >= 0) {
      if (!state.options[idx] || typeof state.options[idx] !== 'object') state.options[idx] = { text: '', image: '' };
      state.options[idx].text = opt.text;
    }
  }
  renderOptions();
  toast('已拆分题干和选项');
}

$('#split-btn').addEventListener('click', doSplit);

// ============ 图片压缩 ============
// 把已加载的 Image 画到白底 canvas，去黑边并收缩，输出 JPEG dataURL
function processImageBitmap(img, maxW) {
  // 同时限制宽度、高度和总像素：只按宽度缩，长截图会变成几万像素高，手机 canvas 直接崩
  const scale = Math.min(
    1,
    maxW / img.width,
    IMAGE_MAX_HEIGHT / img.height,
    Math.sqrt(IMAGE_MAX_PIXELS / (img.width * img.height))
  );
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const whitened = whitenBackground(canvas);
  const crop = trimDarkBorders(canvas);
  let sx = 0, sy = 0, sw = w, sh = h;
  if (crop) { sx = crop.x; sy = crop.y; sw = crop.w; sh = crop.h; }
  // 额外向内收缩 2px，去掉裁剪边界残留的灰线/过渡，让图片四周彻底融入白底
  const PAD = 2;
  if (sw > PAD * 2 + 4 && sh > PAD * 2 + 4) {
    sx += PAD; sy += PAD; sw -= PAD * 2; sh -= PAD * 2;
  }
  const out = document.createElement('canvas');
  out.width = sw;
  out.height = sh;
  out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  // 白化后背景纯白，用 PNG 无损保存，避免 JPEG 二次压缩让文字边缘发虚（且 PNG 更小）
  if (whitened) return out.toDataURL('image/png');
  return out.toDataURL('image/jpeg', 0.92);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('无法读取图片'));
    img.src = src;
  });
}

function compressImage(file, maxW = 1200) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('未选择图片'));
    if (file.size > 25 * 1024 * 1024) return reject(new Error('图片过大，请选择 25MB 以内的图片'));
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const img = await loadImage(reader.result);
        if (!longImageWarned && img.height > IMAGE_MAX_HEIGHT) {
          longImageWarned = true;
          toast('长截图已自动缩小，若看不清请裁成几张再上传', false);
        }
        resolve(processImageBitmap(img, maxW));
      } catch (e) { reject(e); }
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 处理 JSON 导入里的图片：base64 做白底+去黑边；外部网址无法本地处理则原样保留
async function processImageForImport(src, maxW = 1200) {
  if (!src) return '';
  if (!/^data:image\//i.test(src)) return src;
  try {
    const img = await loadImage(src);
    return processImageBitmap(img, maxW);
  } catch (e) {
    return src; // 处理失败保留原图
  }
}

// 处理题目里的题干图片与各选项图片（JSON 导入用）
async function processQuestionImages(q) {
  if (q.question_image) q.question_image = await processImageForImport(q.question_image, 1200);
  for (const o of q.options || []) {
    if (o.image) o.image = await processImageForImport(o.image, 800);
  }
  return q;
}

// 把拍照图片的灰/米色背景提亮成纯白，保留深色文字（去灰底，让图片融入白色背景）
function whitenBackground(canvas) {
  const w = canvas.width, h = canvas.height;
  if (w < 4 || h < 4) return false;
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, w, h);
  const d = data.data;
  // 采样亮度直方图（每 2px 采样加速）
  const hist = new Array(256).fill(0);
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      const L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      hist[Math.min(255, Math.round(L))]++;
    }
  }
  // 背景分界阈值 T 取「亮像素（>=128）的 5% 分位」：落在背景最暗处，
  // 既能把背景暗部一并压白，又不碰文字（文字只延伸到 ~160）
  const total = Math.ceil(w / 2) * Math.ceil(h / 2);
  let brightTotal = 0;
  for (let v = 128; v < 256; v++) brightTotal += hist[v];
  if (brightTotal < total * 0.3) return false; // 亮背景占比太小，非灰底图，不处理
  let acc = 0, T = 200;
  for (let v = 128; v < 256; v++) {
    acc += hist[v];
    if (acc >= brightTotal * 0.05) { T = v; break; }
  }
  if (T >= 235) return false; // 背景已接近纯白，无需处理
  // 硬切：低于 T 的像素（文字及其边缘）完全保持原样，绝不提亮，避免文字发虚变淡
  for (let i = 0; i < d.length; i += 4) {
    const L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (L < T) continue;
    d[i] = d[i + 1] = d[i + 2] = 255;
  }
  // 去除背景颗粒：孤立暗点（周围 8 邻域全白）是拍摄噪声，压白；文字笔画是连续的，不会被误删
  const lumAt = (x, y) => {
    const j = (y * w + x) * 4;
    return 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  };
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (lumAt(x, y) >= T) continue;
      let isolated = true;
      for (let dy = -1; dy <= 1 && isolated; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (lumAt(x + dx, y + dy) < T) { isolated = false; break; }
        }
      }
      if (isolated) {
        const j = (y * w + x) * 4;
        d[j] = d[j + 1] = d[j + 2] = 255;
      }
    }
  }
  ctx.putImageData(data, 0, 0);
  return true; // 已做白化，背景为纯白，适合用 PNG 无损保存
}

// 裁掉图片四周的暗色边框（拍照/截图常见的黑边、灰边），让图片融入白色背景
function trimDarkBorders(canvas) {
  const w = canvas.width, h = canvas.height;
  if (w < 4 || h < 4) return null;
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, w, h).data;
  const THRESHOLD = 96;
  const luminance = (x, y) => {
    const i = (y * w + x) * 4;
    return (data[i] + data[i + 1] + data[i + 2]) / 3;
  };
  const rowDarkRatio = (y) => {
    let dark = 0;
    for (let x = 0; x < w; x++) if (luminance(x, y) < THRESHOLD) dark++;
    return dark / w;
  };
  const colDarkRatio = (x) => {
    let dark = 0;
    for (let y = 0; y < h; y++) if (luminance(x, y) < THRESHOLD) dark++;
    return dark / h;
  };
  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  while (top < bottom && rowDarkRatio(top) > 0.6) top++;
  while (bottom > top && rowDarkRatio(bottom) > 0.6) bottom--;
  while (left < right && colDarkRatio(left) > 0.6) left++;
  while (right > left && colDarkRatio(right) > 0.6) right--;
  if (right - left < 4 || bottom - top < 4) return null;
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

// ============ 题干图片上传 ============
const qImageBtn = $('#q-image-btn');
const qImageFile = $('#q-image-file');
const qImagePreview = $('#q-image-preview');
const qImageRemove = $('#q-image-remove');

qImageBtn.addEventListener('click', () => qImageFile.click());
qImageFile.addEventListener('change', async () => {
  const file = qImageFile.files[0];
  qImageFile.value = '';
  if (!file) return;
  const token = imageFormToken;
  imageTasks++;
  try {
    const data = await compressImage(file, 1200);
    if (token !== imageFormToken) return; // 表单已切换，丢弃旧结果
    state.questionImage = data;
    qImagePreview.src = data;
    qImagePreview.classList.remove('hidden');
    qImageRemove.classList.remove('hidden');
  } catch (e) {
    if (token === imageFormToken) toast('图片处理失败：' + e.message, false);
  } finally {
    imageTasks--;
  }
});
qImageRemove.addEventListener('click', () => {
  state.questionImage = '';
  qImagePreview.src = '';
  qImagePreview.classList.add('hidden');
  qImageRemove.classList.add('hidden');
});

// ============ 保存 ============
let editReturnTo = 'review';
let editFromRedo = false;
let savingQuestion = false; // 防止连点「保存」重复录入
function loadQuestionToInput(q, returnTo) {
  imageFormToken++;
  editReturnTo = returnTo || 'review';
  const cur = currentItem();
  editFromRedo = !!(cur && cur.kind === 'redo');
  state.editingId = q.id;
  state.type = ['single', 'multiple', 'judge'].includes(q.type) ? q.type : 'single';
  const optArr = Array.isArray(q.options) ? q.options : [];
  // 编辑时统一映射到表单的 A/B/C/D 顺序：显式 C/D 标签的历史题也能正常改，
  // 保存后标签会规范成 A..，但文字、图片和正确答案不会丢。
  const sourceLabels = resolveOptionLabels(q, state.type, optArr);
  const formLabels = state.type === 'judge' ? LABELS_JUDGE : LABELS_ALL;
  state.answer = (Array.isArray(q.answer) ? q.answer : [])
    .map((a) => sourceLabels.indexOf(normalizeLabel(String(a))))
    .filter((i) => i >= 0 && i < formLabels.length)
    .map((i) => formLabels[i]);
  state.questionImage = typeof q.question_image === 'string' ? q.question_image : '';
  state.byType = {};
  state.subject = SUBJECTS.includes(q.subject) ? q.subject : null;

  const labels = getLabels();
  state.options = labels.map((l, i) => {
    const o = optArr.find((x) => x && x.label === sourceLabels[i]) || {};
    return { text: String(o.text || ''), image: typeof o.image === 'string' ? o.image : '' };
  });

  $('#q-text').value = String(q.question_text || '');
  $('#q-note').value = typeof q.note === 'string' ? q.note : '';

  if (q.question_image) {
    qImagePreview.src = q.question_image;
    qImagePreview.classList.remove('hidden');
    qImageRemove.classList.remove('hidden');
  } else {
    qImagePreview.src = '';
    qImagePreview.classList.add('hidden');
    qImageRemove.classList.add('hidden');
  }
  qImageFile.value = '';

  document.querySelectorAll('.type-btn').forEach((b) => b.classList.toggle('active', b.dataset.type === state.type));
  $('#input-title').textContent = '修改题目';
  $('#save-btn-text').textContent = '保存修改';
  // 修改题目始终进入文字编辑界面，若上次停留在 JSON 录入界面则先切回
  $('#input-json').classList.add('hidden');
  $('#input-paste').classList.remove('hidden');
  renderSubjectSelector();
  renderOptions();
  switchTab('input');
  markInputClean(); // 刚载入的题目算“干净”，没改过就切页签不弹确认
}

$('#save-btn').addEventListener('click', async () => {
  const qText = $('#q-text').value.trim();
  const note = $('#q-note').value.trim();
  const labels = getLabels();
  const options = labels.map((l, i) => {
    const o = state.options[i] || {};
    return { label: l, text: (o.text || '').trim(), image: o.image || '' };
  });
  // 编辑 2/3 选项题时表单仍显示 A-D，末尾空选项不算“没填”；
  // 但中间缺选项、或答案指向已删选项，仍然要拦住。
  while (options.length > LABELS_JUDGE.length) {
    const last = options[options.length - 1];
    if (last.text || last.image) break;
    options.pop();
  }
  // 快照表单状态：后面的 await 期间用户可能切页或改表单，保存应以点击「保存」那一刻为准
  const form = {
    editingId: state.editingId,
    type: state.type,
    questionImage: state.questionImage,
    answer: Array.isArray(state.answer) ? state.answer.slice() : [],
    subject: state.subject,
  };

  if (!qText && !form.questionImage) return toast('请填写题干或上传图片', false);
  if (form.answer.length === 0) return toast('请选择正确答案', false);
  if (options.some((o) => !o.text && !o.image)) return toast('请填写所有选项内容或上传图片', false);
  if (form.answer.some((l) => !options.some((o) => o.label === l))) {
    return toast('正确答案对应的选项不存在，请重新选择', false);
  }
  if (imageTasks > 0) return toast('图片还在处理，请稍候再保存', false);
  if (savingQuestion) return;

  savingQuestion = true;
  try {
    if (form.editingId != null) {
      const editingId = form.editingId;
      const all = await dbGetAll();
      const original = all.find((q) => q.id === editingId);
      if (!original) {
        toast('题目不存在，可能已被删除', false);
        return;
      }
      let mainIdx = -1;
      let regraded = null; // 'correct' | 'wrong' | null：改答案后纠正此前「录入答案错误」导致的误判
      if (original) {
        const updated = {
          ...original,
          type: form.type,
          question_text: qText,
          question_image: form.questionImage,
          options,
          answer: form.answer,
          subject: form.subject,
          note,
        };

        const answerChanged = !sameSet(original.answer || [], form.answer);
        const typeChanged = updated.type !== original.type;
        // 这次修改前是否还有“未重做的错题重做项”；有的话，改完若仍是错题要补回来，
        // 否则“修改题目”会把待重做悄悄删掉，可能直接跳到完成页。
        const hadPendingRedo = reviewQueue.some(
          (x) => x.q.id === editingId && x.kind === 'redo' && x.status === 'pending'
        );

        // 找到该题在复习队列中的首次项，仅在「录入的正确答案被改动」时重新判分纠正统计
        for (let i = 0; i < reviewQueue.length; i++) {
          if (reviewQueue[i].q.id === editingId && reviewQueue[i].kind === 'main') {
            mainIdx = i;
            const it = reviewQueue[i];
            const wasGraded = it.status === 'correct' || it.status === 'wrong';
            if (typeChanged) {
              // 改题型会让这道题按新题型重新作答：先撤销上一次作答的统计，避免重复累计
              if (wasGraded && it.prevState) {
                const prev = it.prevState;
                const prevStage = Math.max(0, Math.min(Number(prev.review_stage) || 0, MASTER_STAGE));
                updated.review_stage = prevStage;
                updated.correct_count = Number(prev.correct_count) || 0;
                updated.wrong_count = Number(prev.wrong_count) || 0;
                updated.next_review = fmtDate(new Date());
                updated.last_result = '';
                updated.last_reviewed = '';
              }
            } else if (wasGraded && it.prevState && answerChanged) {
              // 把用户此前选的「显示标签」还原成真实选项标签，再和修正后的正确答案比较。
              // 优先用 prevSelected（刷新转重做时单独保存的原选择），避免 selectedAnswer 被清空后误判。
              const labelsForReal = (it.labels && it.labels.length)
                ? it.labels
                : (it.q.type === 'judge' ? LABELS_JUDGE : LABELS_ALL);
              const selectedForRegrade = (Array.isArray(it.prevSelected) && it.prevSelected.length)
                ? it.prevSelected
                : (it.selectedAnswer || []);
              const selectedReal = selectedForRegrade.map((s) => {
                const pos = labelsForReal.indexOf(s);
                return (pos >= 0 && it.order && it.order[pos] != null) ? labelsForReal[it.order[pos]] : s;
              });
              const nowCorrect = sameSet(selectedReal, form.answer);
              const wasCorrect = it.status === 'correct';
              if (nowCorrect !== wasCorrect) {
                regraded = nowCorrect ? 'correct' : 'wrong';
                const prev = it.prevState;
                const prevStage = Math.max(0, Math.min(Number(prev.review_stage) || 0, MASTER_STAGE));
                if (nowCorrect) {
                  updated.review_stage = Math.min(prevStage + 1, MASTER_STAGE);
                  updated.next_review = updated.review_stage >= MASTER_STAGE ? '' : fmtDate(addDays(new Date(), INTERVALS[updated.review_stage]));
                  updated.correct_count = (Number(prev.correct_count) || 0) + 1;
                  updated.wrong_count = Number(prev.wrong_count) || 0;
                } else {
                  updated.review_stage = 0;
                  updated.next_review = fmtDate(addDays(new Date(), INTERVALS[0]));
                  updated.correct_count = Number(prev.correct_count) || 0;
                  updated.wrong_count = (Number(prev.wrong_count) || 0) + 1;
                }
                updated.last_result = regraded;
              }
            }
            break;
          }
        }

        await dbPut(updated);

        // 更新队列：首次项用新题；移除该题错题重做项。
        // 题型变了才重排顺序并回到未作答；否则保持原选项顺序与选择/判定，和上次一致。
        for (let i = reviewQueue.length - 1; i >= 0; i--) {
          if (reviewQueue[i].q.id === editingId) {
            if (reviewQueue[i].kind === 'main') {
              const it = reviewQueue[i];
              it.q = updated;
              it.labels = null;
              it.contents = null;
              it.currentAnswer = null;
              it.retry = false;
              if (typeChanged) {
                it.order = null;
                it.selectedAnswer = [];
                it.status = 'pending';
                it.prevState = null; // 旧的作答统计已撤销，重新作答时按首次计数
                it.prevSelected = null;
                it.firstStatus = null;
              } else if (regraded) {
                it.status = regraded; // 保留用户此前选择，用于显示纠正后的判定结果
                it.firstStatus = regraded; // 今天第一次作答的结果随答案修正一起改，统计/答题卡同步
              }
            } else {
              reviewQueue.splice(i, 1);
            }
          }
        }

        // 原来有待重做、或这次改答案把「对」改成「错」：补一条新的重做项，
        // 避免“改个题干/改个答案就不用重做”
        if (hadPendingRedo || regraded === 'wrong') {
          const mainItem = reviewQueue.find((x) => x.q.id === editingId && x.kind === 'main');
          const stillHasPending = reviewQueue.some(
            (x) => x.q.id === editingId && x.kind === 'redo' && x.status === 'pending'
          );
          if (mainItem && mainItem.status === 'wrong' && !stillHasPending) {
            reviewQueue.push({
              q: updated,
              status: 'pending',
              kind: 'redo',
              retry: false,
              seq: null,
              order: null,
              selectedAnswer: [],
              prevSelected: null,
            });
          }
        }
      }
      toast('已保存修改');
      resetInput();
      // 队列已在上面更新（重判分/移除错题重做），统一持久化，避免从详情页改完后复习页仍显示旧判定
      saveSession();
      // 用户点保存后已经切到别的页签：只保存，不再把页面强行拉回录入/复习
      const stillOnInput = !$('#tab-input').classList.contains('hidden');
      if (!stillOnInput) {
        // 不跳转
      } else if (editReturnTo === 'detail') {
        const fresh = (await dbGetAll()).find((x) => x.id === editingId);
        if (fresh) renderDetail(fresh);
        switchTab('detail');
      } else {
        if (editFromRedo) {
          // 从错题重做进入修改：改完回到下一条待重做的题，没有则回到该题主项
          const redoIdx = reviewQueue.findIndex((x) => x.status === 'pending' && x.kind === 'redo');
          if (redoIdx >= 0) reviewIndex = redoIdx;
          else if (mainIdx >= 0) reviewIndex = mainIdx;
        } else if (mainIdx >= 0) {
          reviewIndex = mainIdx;
        }
        switchTab('review', false);
        renderQuestion();
        updateReviewStats();
      }
    } else {
      const newQuestion = {
        type: form.type,
        question_text: qText,
        question_image: form.questionImage,
        options,
        answer: form.answer,
        subject: form.subject,
        note,
        notes: [],
        review_stage: 0,
        next_review: fmtDate(addDays(new Date(), INTERVALS[0])),
        correct_count: 0,
        // 与 normalizeQuestion 一致：新录入题第一次复习答错才记 1 次
        wrong_count: 0,
        last_reviewed: '',
        last_result: '',
        created_at: new Date().toISOString(),
      };
      const similar = findSimilar(newQuestion, await dbGetAll());
      if (similar) {
        const exact = isSameQuestionContent(newQuestion, similar);
        const choice = await askDuplicate(newQuestion, similar, 'create', exact);
        if (choice === 'skip') return toast('已取消保存', false);
        if (choice === 'replace') {
          replaceQuestionContentKeepingProgress(similar, newQuestion);
          await dbPut(similar);
          syncReviewItemAfterImport(similar);
          toast('已保留新录入版本，复习进度沿用原题');
          resetInput();
          loadList();
          refreshBadge();
          return;
        }
        if (choice === 'retry') {
          await dbPut(resetDuplicateForTomorrow(similar));
          removeQuestionFromQueue(similar.id);
          saveSession();
          toast('已把重复题安排到明天重新复习，并记一次错');
          resetInput();
          loadList();
          refreshBadge();
          return;
        }
      }
      await dbAdd(newQuestion);
      toast('保存成功，明日复习');
      resetInput();
      loadList();
    }
    refreshBadge();
  } catch (e) {
    toast('保存失败：' + e.message, false);
  } finally {
    savingQuestion = false;
  }
});

// 录入表单“干净”快照：切页签前判断有没有未保存内容，避免手滑把整道题清空
let inputSnapshot = '';
let reviewNoteOriginal = '';
function confirmReviewNoteLeave() {
  if (!hasUnsavedReviewNote()) return true;
  return confirm('这道题的笔记还没保存，确定要切换到别的题吗？');
}

function hasUnsavedReviewNote() {
  try {
    const ed = $('#review-note-editor');
    return !!ed && !ed.classList.contains('hidden') &&
      $('#review-note-text').value !== reviewNoteOriginal;
  } catch (e) { return false; }
}
function inputStateSignature() {
  return JSON.stringify({
    id: state.editingId,
    type: state.type,
    answer: state.answer,
    subject: state.subject,
    questionImage: state.questionImage,
    options: state.options,
    text: $('#q-text').value,
    note: $('#q-note').value,
  });
}
function markInputClean() {
  try { inputSnapshot = inputStateSignature(); } catch (e) { inputSnapshot = ''; }
}
function isInputDirty() {
  try {
    const jsonText = ($('#json-text') && $('#json-text').value || '').trim();
    return inputStateSignature() !== inputSnapshot || hasUnsavedReviewNote() || !!jsonText;
  } catch (e) { return false; }
}

function resetInput() {
  imageFormToken++;
  state.editingId = null;
  state.type = 'single';
  state.options = [{ text: '', image: '' }, { text: '', image: '' }, { text: '', image: '' }, { text: '', image: '' }];
  state.answer = [];
  state.questionImage = '';
  state.byType = {};
  state.subject = null;
  $('#q-text').value = '';
  $('#q-note').value = '';
  qImagePreview.classList.add('hidden');
  qImagePreview.src = '';
  qImageRemove.classList.add('hidden');
  qImageFile.value = '';
  $('#input-title').textContent = '录入题目';
  $('#save-btn-text').textContent = '保存错题';
  document.querySelectorAll('.type-btn').forEach((b) => b.classList.toggle('active', b.dataset.type === 'single'));
  renderSubjectSelector();
  renderOptions();
  markInputClean();
}

// ============ 相似题目检测 ============
const DUP_THRESHOLD = 0.85;

function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
}

function textSimilarity(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const longer = na.length >= nb.length ? na : nb;
  const shorter = na.length >= nb.length ? nb : na;
  if (shorter.length >= 6 && longer.includes(shorter) && shorter.length / longer.length >= 0.6) return 0.95;
  if (na.length < 6 || nb.length < 6) return 0;
  const bigrams = (s) => {
    const r = new Set();
    for (let i = 0; i < s.length - 1; i++) r.add(s.slice(i, i + 2));
    return r;
  };
  const ba = bigrams(na), bb = bigrams(nb);
  let inter = 0;
  ba.forEach((g) => { if (bb.has(g)) inter++; });
  const union = ba.size + bb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// 选项相似度：忽略选项顺序和 A/B/C/D 标签，只比较选项文字。
// 同一题干可能被不同题目复用（例如“关于……下面描述错误的是”），
// 只看题干会把它们误判成重复题；选项才是区分“同一道题”的关键。
function optionSetSimilarity(a, b) {
  const optionTexts = (q) => (Array.isArray(q.options) ? q.options : [])
    .map((o) => normalizeText(typeof o === 'string' ? o : (o && o.text)))
    .filter(Boolean);
  const aa = optionTexts(a), bb = optionTexts(b);
  // 两边都至少有两个文字选项才比较；图片选项没有文字，交给题干兜底
  if (aa.length < 2 || bb.length < 2) return null;
  let total = 0;
  for (const x of aa) {
    let best = 0;
    for (const y of bb) {
      const s = textSimilarity(x, y);
      if (s > best) best = s;
    }
    total += best;
  }
  // 除以较长的一边：多出/少掉选项也要扣分
  return total / Math.max(aa.length, bb.length);
}

function findSimilar(q, all) {
  let best = null, bestScore = 0;
  for (const existing of all) {
    // 判断与单选/多选题型不同，不可能是同一道题，直接跳过
    if ((q.type === 'judge') !== (existing.type === 'judge')) continue;
    // 两边都有图但图不同，题干再像也不是同一题（例如同一题干配了不同电路图）
    const qi = [q.question_image || ''].concat((Array.isArray(q.options) ? q.options : []).map((o) => (o && o.image) || ''));
    const ei = [existing.question_image || ''].concat((Array.isArray(existing.options) ? existing.options : []).map((o) => (o && o.image) || ''));
    let imageConflict = false;
    for (let i = 0; i < Math.max(qi.length, ei.length); i++) {
      if (qi[i] && ei[i] && qi[i] !== ei[i]) { imageConflict = true; break; }
    }
    if (imageConflict) continue;
    const qStem = normalizeText(q.question_text), eStem = normalizeText(existing.question_text);
    // 纯图片/无文字题：只有题干图完全相同才算同一题，不能因为两个空字符串相似度 1 就全部误报
    if (!qStem || !eStem) {
      if (!qStem && !eStem && q.question_image && existing.question_image && q.question_image === existing.question_image) {
        if (1 > bestScore) { bestScore = 1; best = existing; }
      }
      continue;
    }
    const stemScore = textSimilarity(q.question_text, existing.question_text);
    // 题干完全不像的，不必再比选项
    if (stemScore < 0.5) continue;
    const optScore = optionSetSimilarity(q, existing);
    // 题干占 40%，选项占 60%：题干相同但选项截然不同 → 0.4，不再误报；
    // 题干略有 OCR 差异但选项高度一致 → 仍能识别为重复。
    const score = optScore == null ? stemScore : (stemScore * 0.4 + optScore * 0.6);
    if (score > bestScore) { bestScore = score; best = existing; }
  }
  return best && bestScore >= DUP_THRESHOLD ? best : null;
}

// 备份同步用：题干和选项都相同，视为同一道题（选项顺序、A/B/C/D 标签可不同），
// 直接合并复习状态；只有“像但不是同一题”才走相似题确认。
function isSameQuestionContent(a, b) {
  if (!a || !b) return false;
  // 题型、答案必须一致；答案被修订/单选改多选不能算“一模一样”。
  if ((a.type || 'single') !== (b.type || 'single')) return false;
  if (!sameSet(Array.isArray(a.answer) ? a.answer : [], Array.isArray(b.answer) ? b.answer : [])) return false;
  const opts = (q) => (Array.isArray(q.options) ? q.options : []).map((o) => {
    const text = normalizeText(typeof o === 'string' ? o : (o && o.text));
    return text || ('img:' + String(o && o.image || ''));
  }).filter(Boolean).sort();
  const aa = opts(a), bb = opts(b);
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
  const na = normalizeText(a.question_text), nb = normalizeText(b.question_text);
  if (!na || !nb) {
    // 纯图片题：只有题干图相同且选项/答案都相同，才算同一题。
    return !!(a.question_image && b.question_image && a.question_image === b.question_image);
  }
  if (na !== nb) return false;
  // 题干/选项文字相同，但配图不同（例如同一题干配了不同电路图）不能合并；
  // 一边有图、一边没图则视为同一题，合并时把缺的图补上。
  const images = (q) => [q.question_image || '']
    .concat((Array.isArray(q.options) ? q.options : []).map((o) => (o && o.image) || ''));
  const ia = images(a), ib = images(b);
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    if (ia[i] && ib[i] && ia[i] !== ib[i]) return false;
  }
  return true;
}

function mergeImportedQuestion(local, incoming) {
  const localLast = local.last_reviewed || '';
  const incomingLast = incoming.last_reviewed || '';
  const localStage = Number(local.review_stage) || 0;
  const incomingStage = Number(incoming.review_stage) || 0;
  // 以“最后一次复习时间”判断哪边更新；日期相同再看轮次，避免把平板上的旧状态覆盖手机上的新状态。
  // 本机这道题还没开始复习（没有 last_reviewed/上次结果）时，备份里的进度就是唯一进度，
  // 即使两边 last_reviewed 都为空，也要把备份的下次复习日期带过来。
  const localUntouched = !localLast && localStage === 0 && !local.last_result;
  const incomingNewer = incomingLast > localLast
    || (incomingLast === localLast && incomingStage > localStage)
    || (localUntouched && (incomingLast || incomingStage > 0 || incoming.next_review));
  if (incomingNewer) {
    local.review_stage = incomingStage;
    local.next_review = incoming.next_review || '';
    local.last_reviewed = incomingLast;
    local.last_result = incoming.last_result || '';
    // “每个题采用最新一次做题记录”：整组进度字段跟最新一方走，
    // 不能只取 max(对错次数)，否则会把本机旧的高次数拼到备份的新记录上。
    local.correct_count = Number(incoming.correct_count) || 0;
    local.wrong_count = Number(incoming.wrong_count) || 0;
  }
  // 同一道题在平板上可能是手动录入、在手机上是题库题；合并时保留题库来源，
  // 否则行测入口会少算一道，列表“全部”也会对不上。
  if (local.bank_id == null && incoming.bank_id != null) local.bank_id = incoming.bank_id;
  // 手机端给题干/选项补的图，平板端没有时同步过来；文字已相同，不覆盖已有图。
  if (!local.question_image && incoming.question_image) local.question_image = incoming.question_image;
  if (Array.isArray(local.options) && Array.isArray(incoming.options)) {
    local.options = local.options.map((o) => {
      const src = incoming.options.find((x) => x && x.label === o.label);
      if (src && !o.image && src.image) return { ...o, image: src.image };
      return o;
    });
  }
  if (!local.subject && incoming.subject) local.subject = incoming.subject;
  if (!local.note && incoming.note) local.note = incoming.note;
  const notes = Array.isArray(local.notes) ? local.notes.slice() : [];
  const seen = new Set(notes.map((n) => JSON.stringify(n)));
  (Array.isArray(incoming.notes) ? incoming.notes : []).forEach((n) => {
    const key = JSON.stringify(n);
    if (!seen.has(key)) { seen.add(key); notes.push(n); }
  });
  local.notes = notes;
}

// 导入时用户选“覆盖”：备份里的内容和复习状态整体覆盖本机这道题，
// 但保留本机 id/created_at 和题库来源（题库进度不能因覆盖丢掉）。
// 导入覆盖后同步内存里的今日队列，避免“数据库已换、答题卡还是旧题/旧状态”
function syncReviewItemAfterImport(q) {
  if (!Array.isArray(reviewQueue) || reviewQueue.length === 0) return;
  const today = fmtDate(new Date());
  let changed = false;
  reviewQueue.forEach((it) => {
    if (!it || !it.q || it.q.id !== q.id) return;
    it.q = q;
    it.order = null;
    it.selectedAnswer = [];
    it.prevSelected = null;
    it.prevState = null;
    it.labels = null;
    it.contents = null;
    it.currentAnswer = null;
    it.retry = false;
    it.status = q.last_reviewed === today ? (q.last_result === 'correct' ? 'correct' : 'wrong') : 'pending';
    it.firstStatus = it.status === 'pending' ? null : it.status;
    changed = true;
  });
  if (changed) saveSession();
}

// 录入“相似题”里选“保留新录入版本”：只替换题目内容，复习进度继续沿用旧题。
// 适用于“原来那道题录错了/选项旧了，用新版本修正”，不重来一轮。
function replaceQuestionContentKeepingProgress(existing, newQ) {
  existing.type = newQ.type;
  existing.question_text = newQ.question_text;
  existing.question_image = newQ.question_image || '';
  existing.options = Array.isArray(newQ.options) ? newQ.options.map((o) => ({ ...o })) : [];
  existing.answer = Array.isArray(newQ.answer) ? newQ.answer.slice() : [];
  if (newQ.subject) existing.subject = newQ.subject;
  if (newQ.note) existing.note = newQ.note;
  const notes = Array.isArray(existing.notes) ? existing.notes.slice() : [];
  const seen = new Set(notes.map((n) => JSON.stringify(n)));
  (Array.isArray(newQ.notes) ? newQ.notes : []).forEach((n) => {
    const key = JSON.stringify(n);
    if (!seen.has(key)) { seen.add(key); notes.push(n); }
  });
  existing.notes = notes;
  // id / created_at / bank_id / review_stage / next_review / counts / last_* 全部保留
}

function overwriteImportedQuestion(local, incoming) {
  const localId = local.id;
  const localCreatedAt = local.created_at;
  const localBankId = local.bank_id;
  Object.assign(local, {
    type: incoming.type,
    question_text: incoming.question_text,
    question_image: incoming.question_image,
    options: Array.isArray(incoming.options) ? incoming.options : [],
    answer: Array.isArray(incoming.answer) ? incoming.answer : [],
    subject: incoming.subject || local.subject,
    note: incoming.note || local.note || '',
    notes: (() => {
      const out = Array.isArray(local.notes) ? local.notes.slice() : [];
      const seen = new Set(out.map((n) => JSON.stringify(n)));
      (Array.isArray(incoming.notes) ? incoming.notes : []).forEach((n) => {
        const key = JSON.stringify(n);
        if (!seen.has(key)) { seen.add(key); out.push(n); }
      });
      return out;
    })(),
    review_stage: Number(incoming.review_stage) || 0,
    next_review: incoming.next_review || '',
    correct_count: Number(incoming.correct_count) || 0,
    wrong_count: Number(incoming.wrong_count) || 0,
    last_reviewed: incoming.last_reviewed || '',
    last_result: incoming.last_result || '',
    created_at: localCreatedAt,
    id: localId,
  });
  if (localBankId != null) local.bank_id = localBankId;
  else if (incoming.bank_id != null) local.bank_id = incoming.bank_id;
  return local;
}

function renderCompareBox(el, q, title) {
  const typeText = q.type === 'single' ? '单选' : q.type === 'multiple' ? '多选' : '判断';
  const opts = (q.options || []).map((o) => `${escapeHtml(o.label || '?')}. ${escapeHtml(o.text || '（图片）')}`).join('<br>');
  el.innerHTML = `
    <div class="text-xs font-semibold text-slate-400 mb-1">${escapeHtml(title)}</div>
    <div class="p-3 bg-slate-50 rounded-lg text-sm text-slate-700">
      <div class="mb-1.5 leading-relaxed"><span class="text-xs font-semibold text-primary-600 mr-1">[${typeText}]</span>${escapeHtml(q.question_text) || '（图片题）'}</div>
      <div class="text-xs text-slate-600 leading-relaxed whitespace-pre-wrap">${opts}</div>
      <div class="mt-1.5 text-xs font-medium text-green-600">答案：${escapeHtml((q.answer || []).join('、'))}</div>
    </div>`;
}

let dupResolve = null;
let dupForceChoice = 'keep';

// 重复题第三选择：把已录入的那道题当成“又做错一次”，
// 轮次归零、明天重新开始。今天已经做过的记录保留，不能因为重新排期
// 把“今日做题/正确率/错题”抹掉；没做过的题本来就没有记录。
function resetDuplicateForTomorrow(q) {
  q.review_stage = 0;
  q.next_review = fmtDate(addDays(new Date(), 1));
  q.wrong_count = (Number(q.wrong_count) || 0) + 1;
  return q;
}

// 只有今天还没做过的题，才需要从今日队列移除；今天已做过的保留结果视图。
function removeDuplicateFromTodayQueue(q) {
  if (!q || q.last_reviewed === fmtDate(new Date())) return;
  removeQuestionFromQueue(q.id);
}

// mode='create'：录入（表单 / JSON 批量录入）→ 新题；完全相同不允许“仍要保存”
// mode='sync'：导入备份 → 同一题同步；完全相同已在调用方自动合并，不会到这里
function askDuplicate(newQ, oldQ, mode = 'create', exact = false) {
  return new Promise((resolve) => {
    const isSync = mode === 'sync';
    renderCompareBox($('#dup-new'), newQ, isSync ? '你正在导入的题目' : '你正在录入的题目');
    renderCompareBox($('#dup-old'), oldQ, '已录入的题目');
    $('#dup-title').innerHTML = exact
      ? '<i class="fa fa-exclamation-triangle text-amber-500 mr-1"></i>发现一模一样的题目'
      : '<i class="fa fa-exclamation-triangle text-amber-500 mr-1"></i>发现相似题目，请确认';
    // 录入遇到一模一样：只允许跳过或“从明天重新复习”，不给“仍要保存”制造重复题。
    // 备份同步遇到一模一样不会走到这里（调用方已自动合并）。
    $('#dup-keep').classList.toggle('hidden', exact && !isSync);
    $('#dup-keep').textContent = exact
      ? '覆盖：用备份里的题目和复习状态覆盖本机'
      : (isSync ? '不是同一题，仍要导入' : '不是同一题，另存为新题');
    // 相似题才显示“保留新录入版本”：替换旧题内容，但保留旧复习进度。
    $('#dup-replace').classList.toggle('hidden', isSync || exact);
    // “从明天重新复习”只属于录入；导入备份不能借这个按钮改统计。
    $('#dup-retry').classList.toggle('hidden', isSync);
    $('#dup-skip').textContent = exact
      ? '跳过：保留本机这道题不变'
      : (isSync ? '是同一题，跳过不导入' : '保留旧版本（跳过）');
    dupForceChoice = exact ? 'overwrite' : 'keep';
    dupResolve = resolve;
    $('#dup-modal').classList.remove('hidden');
  });
}
$('#dup-keep').addEventListener('click', () => {
  $('#dup-modal').classList.add('hidden');
  if (dupResolve) { const choice = dupForceChoice; dupResolve(choice); dupResolve = null; dupForceChoice = 'keep'; }
});
$('#dup-replace').addEventListener('click', () => {
  $('#dup-modal').classList.add('hidden');
  if (dupResolve) { dupResolve('replace'); dupResolve = null; }
});
$('#dup-retry').addEventListener('click', () => {
  $('#dup-modal').classList.add('hidden');
  if (dupResolve) { dupResolve('retry'); dupResolve = null; }
});
$('#dup-skip').addEventListener('click', () => {
  $('#dup-modal').classList.add('hidden');
  if (dupResolve) { dupResolve('skip'); dupResolve = null; }
});

// ============ 复习 ============
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 按复习轮数分档（stage 越小越优先），同档内随机打乱
function orderByStage(due) {
  const groups = {};
  due.forEach((q) => {
    const stage = Math.min(q.review_stage || 0, MASTER_STAGE);
    (groups[stage] = groups[stage] || []).push(q);
  });
  const ordered = [];
  Object.keys(groups).map(Number).sort((a, b) => a - b).forEach((stage) => {
    shuffleArray(groups[stage]);
    ordered.push(...groups[stage]);
  });
  return ordered;
}

// 复习页没有可复习内容时的默认空状态（完成页会临时改写该区域）
function showReviewIdle() {
  const empty = $('#review-empty');
  empty.innerHTML = '<i class="fa fa-check-circle text-5xl"></i><p class="mt-3">今天没有需要复习的题目</p>';
  empty.classList.remove('hidden');
  $('#review-box').classList.add('hidden');
  $('#review-count').textContent = '0';
}

async function loadReview() {
  // 先隐藏题目区与空状态，避免从录入/列表切回时闪现上一次的内容或翻题按钮
  $('#review-box').classList.add('hidden');
  $('#review-empty').classList.add('hidden');
  isBrowsing = false;
  isTrophyRedo = false;
  trophyRedoIds = [];
  const all = await dbGetAll();
  const today = fmtDate(new Date());

  // 优先恢复今天已保存的会话；没有或跨天则全新开始（每日顺序确定）
  const saved = getSavedSession();
  const resumedTrophyRedo = !!(saved && saved.date === today && saved.trophyRedo === true);
  const resumedBrowsing = !!(saved && saved.date === today && saved.browsing === true && saved.atTrophy !== true);
  let resumedAtTrophy = false;
  if (!(saved && saved.date === today && restoreSession(saved, all))) {
    buildFreshSession(all, today);
    sessionAtTrophy = false;
    isTrophyRedo = false;
  } else if (saved.atTrophy === true) {
    // 上次停在完成页；刷新/切回来仍显示奖杯，不能因为队列里还有重做项就自动进重做
    resumedAtTrophy = true;
    sessionAtTrophy = true;
    isTrophyRedo = false;
  } else {
    sessionAtTrophy = false;
    isTrophyRedo = resumedTrophyRedo;
  }
  ensureDoneToday(all, today);
  if (resumedAtTrophy) {
    await updateReviewStats();
    refreshBadge();
    showReviewComplete();
    return;
  }

  const totalPending = reviewQueue.filter((x) => x.status === 'pending').length;
  $('#review-count').textContent = pendingMainCount();
  $('#review-empty').classList.toggle('hidden', reviewQueue.length > 0);
  $('#review-box').classList.toggle('hidden', reviewQueue.length === 0);
  updateReviewStats();
  refreshBadge();

  if (reviewQueue.length > 0) {
    if (totalPending === 0 && !resumedBrowsing) {
      showReviewComplete();
    } else {
      isBrowsing = resumedBrowsing; // 回看中刷新/切页签，回到原来那一题
      if (reviewIndex >= reviewQueue.length) reviewIndex = 0;
      // 刷新/切页签回到已判分的题：按用户要求直接进入这道题的重做（可再次作答），
      // 不再只恢复只读结果视图；回看模式仍是只读浏览。
      if (!isBrowsing && reviewQueue[reviewIndex].status !== 'pending') enterRedo(reviewIndex);
      else renderQuestion();
    }
  } else {
    const doneToday = all.filter((q) => q.last_reviewed === today).length;
    if (doneToday > 0) showReviewComplete();
    else showReviewIdle();
  }
}

async function updateReviewStats() {
  let all;
  try {
    all = await dbGetAll();
  } catch (e) {
    return;
  }
  const today = fmtDate(new Date());
  const tomorrow = fmtDate(addDays(new Date(), 1));
  const doneToday = all.filter((q) => q.last_reviewed === today).length;
  const dueTomorrow = all.filter((q) => q.next_review === tomorrow).length;
  $('#review-stats').innerHTML =
    `<span class="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-600 font-medium">今日已复习 ${doneToday} 道</span>` +
    `<span class="px-2.5 py-1 rounded-full bg-sky-50 text-sky-600 font-medium">明天待复习 ${dueTomorrow} 道</span>`;
}

function currentItem() { return reviewQueue[reviewIndex] || null; }

function pendingMainCount() {
  return reviewQueue.filter((x) => x.kind === 'main' && x.status === 'pending').length;
}
function pendingRedoCount() {
  return reviewQueue.filter((x) => x.kind === 'redo' && x.status === 'pending').length;
}

// 顶部进度单独刷新：提交后 pending 数会立刻变，不能等下一次 renderQuestion
function updateReviewProgress() {
  const it = currentItem();
  const el = $('#review-progress');
  if (!it || !el) return;
  if (it.kind === 'main') {
    const pos = (it.seq != null ? it.seq : reviewIndex) + 1;
    el.textContent = `第 ${pos} / ${reviewTotal} 题`;
  } else {
    el.textContent = `错题重做 · 剩 ${pendingRedoCount()} 题`;
  }
}

// 「下一题」是否显示：还有下一题、或还有未做题可跳转时显示；回看模式浏览到最后一道时隐藏
function shouldShowNext() {
  if (isBrowsing) return reviewIndex + 1 < reviewQueue.length;
  // 正常复习：队列非空就显示（作「下一题」跳过，或做完全部题后作「完成」进入奖杯）
  return reviewQueue.length > 0;
}

// 下一题按钮文字：正常复习做完全部题后显示「完成」，其余显示「下一题」
function nextButtonLabel() {
  return (!isBrowsing && reviewQueue.length > 0 && !reviewQueue.some((x) => x.status === 'pending'))
    ? '完成'
    : '下一题';
}

// 统一刷新底部/侧边按钮的显示与文字
function refreshBottomBar() {
  const hasPendingNow = reviewQueue.some((x) => x.status === 'pending');
  // 完成页「回看今日错题」是重做模式：即使还有待做也保留返回，随时回完成页
  $('#review-back').classList.toggle('hidden', hasPendingNow && !isTrophyRedo && !isBrowsing);
  $('#next-question').classList.toggle('hidden', !shouldShowNext());
  const label = $('#next-question .side-label');
  if (label) label.textContent = nextButtonLabel();
}

function renderQuestion() {
  clearReviewAutoTimer();
  const it = currentItem();
  if (!it) { showReviewComplete(); return; }
  const q = it.q;

  // 切题时收起上一条笔记的编辑器，避免上题的文字被存到下一题
  $('#review-note-editor').classList.add('hidden');
  $('#review-note-text').value = '';
  reviewNoteOriginal = '';

  const optionsArr = Array.isArray(q.options) ? q.options : [];
  // 2/3 选项题按实际选项标签渲染，不能固定成 A-D 后显示两个空选项。
  const actualLabels = [...new Set(optionsArr.map((o) => o && o.label).filter(Boolean))].sort();
  const labels = q.type === 'judge'
    ? ['A', 'B']
    : (actualLabels.length >= 2
        ? actualLabels
        : (optionsArr.length >= 2 ? LABELS_ALL.slice(0, optionsArr.length) : LABELS_ALL));
  const contents = labels.map((l) => {
    const o = optionsArr.find((x) => x && x.label === l) || {};
    return { text: o.text || '', image: o.image || '' };
  });
  // 首次渲染生成打乱顺序并保存，回看/刷新后顺序不变；顺序数据损坏时重新生成，避免渲染崩溃
  const validOrder = Array.isArray(it.order) &&
    it.order.length === contents.length &&
    it.order.every((v) => Number.isInteger(v) && v >= 0 && v < contents.length) &&
    new Set(it.order).size === contents.length;
  if (!validOrder) {
    const order = contents.map((_, i) => i);
    if (q.type !== 'judge') shuffleArray(order);
    it.order = order;
  }
  const order = it.order;
  const answerSet = new Set(Array.isArray(q.answer) ? q.answer : []);
  const currentAnswer = [];
  order.forEach((origIdx, newPos) => {
    if (answerSet.has(labels[origIdx])) currentAnswer.push(labels[newPos]);
  });
  it.labels = labels;
  it.contents = contents;
  it.currentAnswer = currentAnswer;
  if (!Array.isArray(it.selectedAnswer)) it.selectedAnswer = [];

  const selectedAnswer = it.selectedAnswer || [];

  updateReviewProgress();
  $('#review-count').textContent = pendingMainCount();
  $('#review-cnt').innerHTML =
    `<span class="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 font-medium">答对 ${Number(q.correct_count) || 0} 次</span>` +
    `<span class="px-2 py-0.5 rounded-full bg-red-50 text-red-600 font-medium">答错 ${Number(q.wrong_count) || 0} 次</span>`;
  applyTypeBadge($('#review-type-badge'), q.type);
  // 仅未归类（无科目）的题显示设置科目图标，已归类的不再显示；题库题（bank_id）固定归行测，不给改科目
  $('#review-subject-btn').classList.toggle('hidden', SUBJECTS.includes(q.subject) || q.bank_id != null);

  $('#review-question').textContent = q.question_text || '';
  const img = $('#review-image');
  if (q.question_image) {
    img.src = q.question_image;
    img.classList.remove('hidden');
  } else {
    img.classList.add('hidden');
  }

  // 渲染选项（顺序固定，来自 it.order）
  const wrap = $('#review-options');
  wrap.innerHTML = '';
  const canAnswer = !isBrowsing && (it.status === 'pending' || it.retry === true);

  const displayOptions = labels.map((label, pos) => ({
    label,
    text: contents[order[pos]].text,
    image: contents[order[pos]].image,
  }));
  displayOptions.forEach((opt) => {
    const div = document.createElement('div');
    div.className = 'review-opt' + (canAnswer && selectedAnswer.includes(opt.label) ? ' selected' : '');
    div.dataset.label = opt.label;
    const textHtml = opt.text ? `<div>${escapeHtml(opt.text)}</div>` : '';
    const imgHtml = opt.image ? `<img src="${escapeHtml(opt.image)}" class="mt-1 max-h-32 rounded-lg" alt="" />` : '';
    div.innerHTML = `<span class="badge">${escapeHtml(opt.label)}</span><span class="flex-1 min-w-0">${textHtml}${imgHtml}</span>`;
    if (canAnswer) {
      // div 也能用键盘操作：Tab 聚焦，Enter/空格选择
      div.tabIndex = 0;
      div.setAttribute('role', 'button');
      div.setAttribute('aria-pressed', selectedAnswer.includes(opt.label) ? 'true' : 'false');
      const selectOption = () => {
        if (q.type === 'multiple') {
          it.selectedAnswer = it.selectedAnswer.includes(opt.label)
            ? it.selectedAnswer.filter((x) => x !== opt.label)
            : [...it.selectedAnswer, opt.label].sort();
        } else {
          it.selectedAnswer = [opt.label];
        }
        wrap.querySelectorAll('.review-opt').forEach((el) => {
          const on = it.selectedAnswer.includes(el.dataset.label);
          el.classList.toggle('selected', on);
          el.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      };
      div.addEventListener('click', selectOption);
      div.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectOption();
        }
      });
    }
    wrap.appendChild(div);
  });

  // 底部栏：上一题可用性（同阶段内向前翻，最前面则禁用）
  const prevBtn = $('#prev-question');
  let hasPrev = false;
  for (let i = reviewIndex - 1; i >= 0; i--) {
    if (reviewQueue[i].kind === it.kind) { hasPrev = true; break; }
  }
  prevBtn.disabled = !hasPrev;
  prevBtn.classList.toggle('opacity-40', !hasPrev);
  prevBtn.classList.remove('hidden');

  // 回看/完成浏览（无待做题）时显示「返回」按钮；下一题按钮按当前进度显示「下一题/完成」
  refreshBottomBar();
  updateAiVisibility();

  if (canAnswer) {
    $('#review-result').classList.add('hidden');
    $('#review-result').innerHTML = '';
    $('#submit-answer').classList.remove('hidden');
    $('#review-delete').classList.add('hidden');
    $('#review-note-btn').classList.add('hidden');
    $('#review-edit-btn').classList.add('hidden');
    $('#review-note-editor').classList.add('hidden');
    $('#review-note-display').classList.add('hidden');
  } else {
    renderAnsweredState(it);
  }
  saveSession();
}

function getNotes(q) {
  const list = [];
  if (typeof q.note === 'string' && q.note.trim()) {
    list.push({ text: q.note.trim(), kind: 'note' });
  }
  const arr = Array.isArray(q.notes) ? q.notes : [];
  arr.forEach((n, i) => {
    const text = typeof n === 'string' ? n : (n && n.text) || '';
    if (text.trim()) list.push({ text: text.trim(), kind: 'notes', index: i });
  });
  return list;
}

function deleteNoteEntry(q, n) {
  if (n.kind === 'note') {
    q.note = '';
  } else if (n.kind === 'notes') {
    if (Array.isArray(q.notes)) q.notes.splice(n.index, 1);
  }
}

function updateNoteEntry(q, n, text) {
  const t = (text || '').trim();
  if (n.kind === 'note') {
    q.note = t;
  } else if (n.kind === 'notes') {
    if (!Array.isArray(q.notes)) q.notes = [];
    const cur = q.notes[n.index];
    if (typeof cur === 'string') q.notes[n.index] = t;
    else if (cur) cur.text = t;
  }
}

// 单条笔记：文字 + 编辑/删除按钮；编辑时内联变为 textarea
function createNoteItem(q, n, onSaved) {
  const item = document.createElement('div');
  item.className = 'flex items-start gap-2 py-1.5';

  const textEl = document.createElement('div');
  textEl.className = 'flex-1 min-w-0 whitespace-pre-wrap break-words text-amber-800';
  textEl.textContent = n.text;
  item.appendChild(textEl);

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'shrink-0 text-amber-400 hover:text-primary-500 transition';
  editBtn.innerHTML = '<i class="fa fa-pencil"></i>';
  editBtn.title = '编辑这条笔记';
  item.appendChild(editBtn);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'shrink-0 text-amber-400 hover:text-red-500 transition';
  delBtn.innerHTML = '<i class="fa fa-times-circle"></i>';
  delBtn.title = '删除这条笔记';
  item.appendChild(delBtn);

  const startEdit = () => {
    item.className = 'flex flex-col gap-2 py-1.5';
    item.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.className = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:ring-2 focus:ring-primary-300 focus:outline-none';
    ta.value = n.text;
    const row = document.createElement('div');
    row.className = 'flex justify-end gap-2';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 text-sm font-medium hover:bg-slate-200 transition';
    cancelBtn.textContent = '取消';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'px-3 py-1.5 rounded-lg bg-primary-500 text-white text-sm font-medium hover:bg-primary-600 transition';
    saveBtn.textContent = '保存';
    row.appendChild(cancelBtn);
    row.appendChild(saveBtn);
    item.appendChild(ta);
    item.appendChild(row);

    saveBtn.addEventListener('click', async () => {
      const t = ta.value.trim();
      if (!t) deleteNoteEntry(q, n);
      else updateNoteEntry(q, n, t);
      try {
        await dbPut(q);
        toast(t ? '笔记已保存' : '笔记已删除');
        onSaved();
      } catch (e) {
        toast('保存失败：' + e.message, false);
      }
    });
    cancelBtn.addEventListener('click', () => onSaved());
    ta.focus();
  };

  editBtn.addEventListener('click', (e) => { e.stopPropagation(); startEdit(); });
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('删除这条笔记？')) return;
    deleteNoteEntry(q, n);
    try {
      await dbPut(q);
      toast('笔记已删除');
      onSaved();
    } catch (err) {
      toast('删除失败：' + err.message, false);
    }
  });

  return item;
}

function renderReviewNote(q) {
  const display = $('#review-note-display');
  const list = $('#review-note-list');
  const notes = getNotes(q);
  if (notes.length === 0) {
    display.classList.add('hidden');
    return;
  }
  list.innerHTML = '';
  notes.forEach((n, idx) => {
    const item = createNoteItem(q, n, () => renderReviewNote(q));
    if (idx > 0) item.classList.add('border-t', 'border-amber-100');
    list.appendChild(item);
  });
  display.classList.remove('hidden');
}

function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86400000);
}

function reviewNextHint(q) {
  if (!q.next_review) return '已掌握，无需再复习';
  if ((Number(q.review_stage) || 0) >= MASTER_STAGE) return '已掌握，无需再复习';
  if (!isRealDate(q.next_review)) return '下次复习日期有误，请修改题目后重新保存';
  const days = daysBetween(fmtDate(new Date()), q.next_review);
  if (days <= 0) return '将在今天复习';
  return `将在 ${days} 天后复习（${q.next_review}）`;
}

// 完成页「回看今日错题」：把今天做错的题加入重做队列，进入重做模式。
// 复用已有的待重做项，避免同一题因重复进入而堆出多条灰色序号。
function openTrophyRedo(ids, all) {
  const questions = ids
    .map((id) => all.find((q) => q.id === id))
    .filter(Boolean);
  if (questions.length === 0) return toast('今天没有做错的题', false);

  // 从奖杯页进入时重建重做队列：清掉旧的重做记录，避免同一题已有“已做”记录时，
  // 答题卡多出旧序号（数量与今日错题数不一致），也避免刚进去就看到绿色/红色的已做状态。
  for (let i = reviewQueue.length - 1; i >= 0; i--) {
    if (reviewQueue[i].kind === 'redo') reviewQueue.splice(i, 1);
  }

  const targets = [];
  questions.forEach((q) => {
    const it = { q, status: 'pending', kind: 'redo', retry: false, selectedAnswer: [], prevSelected: null };
    reviewQueue.push(it);
    targets.push(it);
  });

  trophyRedoIds = questions.map((q) => q.id);
  isBrowsing = false;
  isTrophyRedo = true;
  sessionAtTrophy = false;
  reviewSessionDate = fmtDate(new Date());
  reviewIndex = reviewQueue.indexOf(targets[0]);
  $('#review-empty').classList.add('hidden');
  $('#review-box').classList.remove('hidden');
  renderQuestion();
  saveSession();
  // 和回看一样压一个返回处理：点返回/手机返回都直接回完成页
  pushBack(exitBrowse);
}

async function showReviewComplete() {
  clearReviewAutoTimer();
  isBrowsing = false;
  isTrophyRedo = false;
  let all;
  try {
    all = await dbGetAll();
  } catch (e) {
    toast('加载失败：' + e.message, false);
    return;
  }
  const today = fmtDate(new Date());
  const doneToday = all.filter((q) => q.last_reviewed === today);
  const correctToday = doneToday.filter((q) => q.last_result === 'correct').length;
  const doneAll = all.filter((q) => q.last_reviewed);
  const correctAll = doneAll.filter((q) => q.last_result === 'correct').length;
  const pct = (c, t) => (t === 0 ? 0 : Math.round((c / t) * 100));

  // 今日错题：以数据库当前结果为主；本次从完成页重做过的题即使已经改对，
  // 也保留在 trophyRedoIds 里，直到离开复习页，方便继续回看/再练。
  const wrongIdSet = new Set([
    ...doneToday.filter((q) => q.last_result === 'wrong').map((q) => q.id),
    ...trophyRedoIds,
  ]);
  // 今天从完成页重做后，数据库里的 last_result 可能已经变对；
  // 从今天保存的会话里补上“主题目曾做错”的记录，切走再回来入口也不丢。
  const savedSession = getSavedSession();
  if (savedSession && savedSession.date === today && Array.isArray(savedSession.items)) {
    savedSession.items.forEach((s) => {
      if (s && s.kind === 'main' && (s.firstStatus || s.status) === 'wrong' && all.some((q) => q.id === s.id)) {
        wrongIdSet.add(s.id);
      }
    });
  }
  const wrongIds = Array.from(wrongIdSet).filter((id) => all.some((q) => q.id === id));

  // 题目被删光（比如唯一一题答对后删掉）时，别显示“今日做题 0 道”的奖杯页，回到普通空状态
  if (doneAll.length === 0 && reviewQueue.length === 0) {
    saveSession();
    showReviewIdle();
    return;
  }

  sessionAtTrophy = true;
  $('#review-box').classList.add('hidden');
  $('#review-empty').classList.remove('hidden');
  $('#review-empty').innerHTML = `
    <i class="fa fa-trophy text-5xl text-amber-400"></i>
    <p class="mt-3 font-medium text-slate-600">今日复习完成，太棒了！</p>
    <div class="mt-5 space-y-2 text-sm">
      <div class="px-4 py-3 bg-primary-50 border border-primary-100 rounded-lg">
        今日做题：<span class="font-bold text-primary-600">${doneToday.length}</span> 道，正确率 <span class="font-bold text-primary-600">${pct(correctToday, doneToday.length)}%</span>
      </div>
      <div class="px-4 py-3 bg-emerald-50 border border-emerald-100 rounded-lg">
        一共做题：<span class="font-bold text-emerald-600">${doneAll.length}</span> 道，正确率 <span class="font-bold text-emerald-600">${pct(correctAll, doneAll.length)}%</span>
      </div>
    </div>
    <button id="review-again-btn" class="mt-6 w-full py-2.5 rounded-lg bg-primary-600 hover:bg-primary-700 text-white font-semibold transition">
      <i class="fa fa-history mr-1"></i>回看今日题目
    </button>
    ${wrongIds.length > 0 ? `
    <button id="review-wrong-btn" class="mt-2 w-full py-2.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white font-semibold transition">
      <i class="fa fa-rotate-left mr-1"></i>回看今日错题（${wrongIds.length}）
    </button>` : ''}`;
  $('#review-count').textContent = '0';
  const badge = $('#due-badge');
  badge.textContent = '0';
  badge.classList.add('hidden');

  $('#review-again-btn').addEventListener('click', async () => {
    let mainItems = reviewQueue.filter((x) => x.kind === 'main');
    if (mainItems.length === 0) {      let all;
      try {
        all = await dbGetAll();
      } catch (e) {
        return toast('加载失败：' + e.message, false);
      }
      const today2 = fmtDate(new Date());
      const byId = new Map(all.map((q) => [q.id, q]));
      // 优先从保存的会话恢复今日完整题目顺序；否则从数据库按今天做过的题兜底
      const saved = getSavedSession();
      if (saved && saved.date === today2 && Array.isArray(saved.items)) {
        mainItems = saved.items
          .filter((s) => s && typeof s === 'object' && s.kind === 'main')
          .map((s) => {
            const q = byId.get(s.id);
            if (!q) return null;
            return {
              q,
              status: s.status === 'correct' ? 'correct' : s.status === 'wrong' ? 'wrong' : 'wrong',
              kind: 'main', retry: false, seq: s.seq != null ? s.seq : null,
              order: null, selectedAnswer: [],
            };
          })
          .filter(Boolean);
      }
      if (mainItems.length === 0) {
        mainItems = all
          .filter((q) => q.last_reviewed === today2)
          .map((q, i) => ({
            q,
            status: q.last_result === 'correct' ? 'correct' : 'wrong',
            kind: 'main', retry: false, seq: i, order: null, selectedAnswer: [],
          }));
      }
      reviewSessionDate = today2; // 这批回看题是今天的，会话日期跟着今天
    }
    if (mainItems.length === 0) return toast('今天还没有做题记录', false);
    isBrowsing = true;
    isTrophyRedo = false;
    sessionAtTrophy = false;
    reviewQueue.length = 0;
    mainItems.forEach((it) => reviewQueue.push(it));
    reviewTotal = mainItems.length;
    reviewIndex = 0;
    $('#review-empty').classList.add('hidden');
    $('#review-box').classList.remove('hidden');
    renderQuestion();
    pushBack(exitBrowse); // 回看时手机返回键/返回按钮都退回完成页
    saveSession(); // 记住“回看中”与当前位置，刷新/切页签不丢
  });

  const wrongBtn = $('#review-wrong-btn');
  if (wrongBtn) {
    wrongBtn.addEventListener('click', () => openTrophyRedo(wrongIds, all));
  }
  saveSession();
}

function renderAnsweredState(it) {
  const correct = it.status === 'correct';
  const selectedAnswer = it.selectedAnswer || [];
  const currentAnswer = it.currentAnswer || [];

  updateReviewProgress();
  $('#review-count').textContent = pendingMainCount();
  // 答对/答错次数随本次提交立即刷新（首次做对后 correct_count 已 +1，需同步显示）
  $('#review-cnt').innerHTML =
    `<span class="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 font-medium">答对 ${Number(it.q.correct_count) || 0} 次</span>` +
    `<span class="px-2 py-0.5 rounded-full bg-red-50 text-red-600 font-medium">答错 ${Number(it.q.wrong_count) || 0} 次</span>`;

  const opts = document.querySelectorAll('#review-options .review-opt');
  opts.forEach((el) => {
    const label = el.dataset.label;
    el.classList.remove('correct', 'wrong', 'selected');
    if (currentAnswer.includes(label)) el.classList.add('correct');
    if (selectedAnswer.includes(label) && !currentAnswer.includes(label)) el.classList.add('wrong');
    if (selectedAnswer.includes(label)) el.classList.add('selected');
    // 已判分后不再允许点选选项，避免选中状态被改动造成误解
    el.style.pointerEvents = 'none';
  });

  const result = $('#review-result');
  result.classList.remove('hidden');
  result.innerHTML = correct
    ? '<div class="p-4 bg-green-50 border border-green-200 rounded-lg text-green-700 font-medium"><i class="fa fa-check-circle mr-1"></i>回答正确</div>'
    : '<div class="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 font-medium"><i class="fa fa-times-circle mr-1"></i>回答错误，正确答案：' + escapeHtml(currentAnswer.join('、')) + '</div>';
  result.innerHTML += `<div class="mt-2 text-sm text-slate-500">${escapeHtml(reviewNextHint(it.q))}</div>`;

  $('#submit-answer').classList.add('hidden');
  refreshBottomBar(); // 更新「返回」按钮与「下一题/完成」按钮
  $('#review-note-btn').classList.remove('hidden');
  $('#review-edit-btn').classList.remove('hidden');
  // 这一版已按用户要求移除删除入口，答题正确时也不再显示“删除此题”
  $('#review-delete').classList.add('hidden');
  renderReviewNote(it.q);
  updateAiVisibility();
}

let answerSubmitting = false; // 防止连点提交/写库期间重复判分
// 提交/判分期间锁住选项，避免写库还没完成时改选，导致“判分用旧选择、画面用新选择”
function setReviewOptionsLocked(locked) {
  document.querySelectorAll('#review-options .review-opt').forEach((el) => {
    el.style.pointerEvents = locked ? 'none' : '';
  });
}
async function submitCurrentAnswer() {
  clearReviewAutoTimer();
  const it = currentItem();
  if (!it) return;
  if ((it.selectedAnswer || []).length === 0) return toast('请先选择答案', false);
  if (it.status !== 'pending' && it.retry !== true) return;

  setReviewOptionsLocked(true);
  const correct = sameSet(it.selectedAnswer, it.currentAnswer);
  const isManualRetry = it.retry === true;
  const isFirstAttempt = it.kind === 'main' && !isManualRetry;

  // 只有「首次作答」才更新遗忘曲线与统计；先写库成功再改内存，避免写库失败后卡死
  if (isFirstAttempt) {
    const q = it.q;
    // 记录作答前状态，便于之后「修改题目」纠正录入错误导致的误判；非法数值先归零，避免 NaN 污染复习日期
    const prevStage = Math.max(0, Math.min(Number(q.review_stage) || 0, MASTER_STAGE));
    const prevState = {
      review_stage: prevStage,
      correct_count: Number(q.correct_count) || 0,
      wrong_count: Number(q.wrong_count) || 0,
    };
    const newStage = correct ? Math.min(prevStage + 1, MASTER_STAGE) : 0;
    const changes = correct
      ? {
          review_stage: newStage,
          next_review: newStage >= MASTER_STAGE ? '' : fmtDate(addDays(new Date(), INTERVALS[newStage])),
          correct_count: prevState.correct_count + 1,
          last_result: 'correct',
        }
      : {
          review_stage: 0,
          next_review: fmtDate(addDays(new Date(), INTERVALS[0])),
          wrong_count: prevState.wrong_count + 1,
          last_result: 'wrong',
        };
    changes.last_reviewed = fmtDate(new Date());
    try {
      await dbPut({ ...q, ...changes });
    } catch (e) {
      setReviewOptionsLocked(false);
      toast('保存失败：' + e.message, false);
      return;
    }
    Object.assign(q, changes);
    it.prevState = prevState;
    // 这一轮重新开始，之前的“上次选择”已失效；重做时 enterRedo 会重新记
    it.prevSelected = null;
  }

  // 主复习项单独记住“今天第一次”的结果，答题卡颜色/今日错题只看它；
  // 手动重做无论在答题卡点绿卡还是红卡，都不改写这个首次结果。
  if (!it.firstStatus) {
    it.firstStatus = it.kind === 'main'
      ? (isFirstAttempt ? (correct ? 'correct' : 'wrong') : it.status)
      : null;
  }
  it.status = correct ? 'correct' : 'wrong';
  it.retry = false;

  // 做错：队尾追加一次重做；手动重做答错时，若已有待重做项就不重复加。
  // 首次已经做对的题被手动重做做错，不算“今天做错”，不追加错题重做。
  const hasPendingRedoForQ = reviewQueue.some(
    (x) => x.kind === 'redo' && x.q.id === it.q.id && x.status === 'pending'
  );
  if (!correct && it.firstStatus !== 'correct' && !hasPendingRedoForQ) {
    reviewQueue.push({ q: it.q, status: 'pending', kind: 'redo', retry: false, selectedAnswer: [], prevSelected: null });
  }

  updateReviewStats();
  refreshBadge();
  // 写库期间用户可能已翻到别的题，只在当前仍是这道题时才渲染结果，避免把旧结果画到新题上
  if (currentItem() === it) renderAnsweredState(it);
  saveSession();
  if (currentItem() === it && it.status === 'correct') scheduleReviewAutoNext();
}

$('#submit-answer').addEventListener('click', async () => {
  if (answerSubmitting) return;
  answerSubmitting = true;
  try {
    await submitCurrentAnswer();
  } finally {
    answerSubmitting = false;
  }
});

// 「下一题 / 完成」与自动快进共用同一条路径，避免两套逻辑走岔
function advanceReview() {
  clearReviewAutoTimer();
  const n = reviewQueue.length;
  if (n === 0) return;
  if (!confirmReviewNoteLeave()) return;

  // 回看模式：按顺序浏览已做过的题
  if (isBrowsing) {
    if (reviewIndex + 1 < n) {
      reviewIndex += 1;
      renderQuestion();
      updateReviewStats();
    }
    return;
  }

  // 正常复习：只跳到下一道“未做”的题，不落在已判分的题上。
  // 否则错题重做做完一遍后，可能停在一条旧的错误记录上，看到的还是上次的错误界面。
  let next = -1;
  for (let i = reviewIndex + 1; i < n; i++) {
    if (reviewQueue[i].status === 'pending') { next = i; break; }
  }
  if (next < 0) next = reviewQueue.findIndex((x) => x.status === 'pending');
  if (next >= 0) {
    reviewIndex = next;
    renderQuestion();
    updateReviewStats();
  } else {
    showReviewComplete();
    updateReviewStats();
  }
}

// 答对后延迟跳题：只在当前仍是这道刚答对的题、且还有未做题时执行；
// 任何手动翻题/答题卡/笔记/编辑/切页签都会 clearReviewAutoTimer，避免“定时器追着人跳”。
function scheduleReviewAutoNext() {
  clearReviewAutoTimer();
  if (!autoNextEnabled()) return;
  const it = currentItem();
  if (!it || it.status !== 'correct') return;
  reviewAutoTimer = setTimeout(() => {
    reviewAutoTimer = null;
    if (!autoNextEnabled()) return;
    const cur = currentItem();
    if (!cur || cur.status !== 'correct') return;
    if ($('#review-box').classList.contains('hidden')) return;
    if (!$('#answer-sheet-modal').classList.contains('hidden')) return;
    if (!$('#ai-modal').classList.contains('hidden')) return;
    // 最后一道答对：自动进入完成页，和题库最后一题的行为区分开（题库停在结果页）
    if (!reviewQueue.some((x) => x.status === 'pending')) {
      showReviewComplete();
      return;
    }
    advanceReview();
  }, REVIEW_AUTO_NEXT_DELAY);
}

$('#next-question').addEventListener('click', advanceReview);

$('#prev-question').addEventListener('click', () => {
  const it = reviewQueue[reviewIndex];
  if (!it) return;
  if (!confirmReviewNoteLeave()) return;
  // 上一题：只在同一阶段（主复习 / 错题重做）内向前翻，不回退到主题目
  for (let i = reviewIndex - 1; i >= 0; i--) {
    if (reviewQueue[i].kind === it.kind) {
      reviewIndex = i;
      renderQuestion();
      updateReviewStats();
      return;
    }
  }
});

// ============ 答题卡 ============
function enterRedo(index) {
  const it = reviewQueue[index];
  if (!isBrowsing && !confirmReviewNoteLeave()) return;
  // 回看是只读浏览，点已答卡只跳过去看结果，不能再进入重做/追加错题。
  if (isBrowsing) {
    reviewIndex = index;
    renderQuestion();
    return;
  }
  // 保留上次判分时的选择，之后若改答案，重判才能按“当时真实选了什么”来算
  if (!Array.isArray(it.prevSelected) || it.prevSelected.length === 0) {
    it.prevSelected = Array.isArray(it.selectedAnswer) ? it.selectedAnswer.slice() : [];
  }
  it.retry = true;
  it.selectedAnswer = [];
  reviewIndex = index;
  renderQuestion();
}

function renderAnswerSheet() {
  const grid = $('#answer-sheet-grid');
  grid.innerHTML = '';

  // 以“当前正在看的题”判断阶段：最后一题刚答完、还没点下一题时，仍显示主答题卡；
  // 只有真的在错题重做题上，才切到「错题重做」卡。
  const cur = currentItem();
  const inRedoPhase = !!cur && cur.kind === 'redo';

  if (inRedoPhase) {
    // 错题重做答题卡：按队列顺序列出每一次重做（同一题反复做错会有多条），
    // 序号 1、2、3… 每次做错都在最后新增一个序号，绿=对 红=错 灰=未做。
    $('#answer-sheet-title').textContent = '错题重做';
    const items = reviewQueue.filter((x) => x.kind === 'redo');
    items.forEach((it, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = i + 1;
      if (it.status === 'correct') btn.className = 'h-11 rounded-lg font-semibold text-sm bg-green-500 text-white';
      else if (it.status === 'wrong') btn.className = 'h-11 rounded-lg font-semibold text-sm bg-red-500 text-white';
      else btn.className = 'h-11 rounded-lg font-semibold text-sm bg-slate-200 text-slate-500';
      btn.addEventListener('click', () => {
        if (!confirmReviewNoteLeave()) return;
        $('#answer-sheet-modal').classList.add('hidden');
        reviewIndex = reviewQueue.indexOf(it);
        renderQuestion();
      });
      grid.appendChild(btn);
    });
  } else {
    $('#answer-sheet-title').textContent = '答题卡';
    const items = reviewQueue.filter((x) => x.kind === 'main').sort((a, b) => (a.seq || 0) - (b.seq || 0));
    items.forEach((it) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = (it.seq != null ? it.seq : 0) + 1;
      // 主项颜色只看今天第一次结果；手动重做做错不会把绿卡变红。
      const shownStatus = it.firstStatus || it.status;
      if (shownStatus === 'correct') btn.className = 'h-11 rounded-lg font-semibold text-sm bg-green-500 text-white';
      else if (shownStatus === 'wrong') btn.className = 'h-11 rounded-lg font-semibold text-sm bg-red-500 text-white';
      else btn.className = 'h-11 rounded-lg font-semibold text-sm bg-slate-200 text-slate-500';
      // 灰色未做也可点进（视为今天第一次做）；绿/红点击则进入手动重做
      btn.addEventListener('click', () => {
        $('#answer-sheet-modal').classList.add('hidden');
        const idx = reviewQueue.indexOf(it);
        if (it.status === 'pending') {
          if (!confirmReviewNoteLeave()) return;
          reviewIndex = idx;
          renderQuestion();
        } else {
          enterRedo(idx);
        }
      });
      grid.appendChild(btn);
    });
  }
}

$('#answer-sheet-btn').addEventListener('click', () => {
  clearReviewAutoTimer();
  renderAnswerSheet();
  $('#answer-sheet-modal').classList.remove('hidden');
});

$('#answer-sheet-close').addEventListener('click', () => {
  $('#answer-sheet-modal').classList.add('hidden');
});

// 退出回看：与「返回」按钮、手机返回键/手势共用同一条路径
function exitBrowse() {
  showReviewComplete();
}

// 从今日复习队列移除某题（首次 + 错题重做），并重排主题目序号。
// 复习内删除、列表/详情删除共用，避免删除后红圈与待复习数暂不一致。
function removeQuestionFromQueue(qid) {
  let removedBeforeCurrent = 0;
  for (let i = reviewQueue.length - 1; i >= 0; i--) {
    if (reviewQueue[i].q.id === qid) {
      // 删掉当前题之前的题，当前题的下标会前移，这里同步减掉，避免回复习时跳过一道题
      if (i < reviewIndex) removedBeforeCurrent++;
      reviewQueue.splice(i, 1);
    }
  }
  if (removedBeforeCurrent > 0) reviewIndex = Math.max(0, reviewIndex - removedBeforeCurrent);
  if (reviewQueue.length === 0) reviewIndex = 0;
  else if (reviewIndex >= reviewQueue.length) reviewIndex = reviewQueue.length - 1;
  reviewQueue
    .filter((x) => x.kind === 'main')
    .sort((a, b) => (a.seq || 0) - (b.seq || 0))
    .forEach((it, i) => { it.seq = i; });
  reviewTotal = reviewQueue.filter((x) => x.kind === 'main').length;
}

// 回看/完成浏览时的「返回」按钮：和手机返回键一样退回完成页
$('#review-back').addEventListener('click', () => {
  if (backHandlers.length > 0) history.back(); // 走 popstate → exitBrowse
  else exitBrowse();
});

$('#review-delete').addEventListener('click', async () => {
  clearReviewAutoTimer();
  const it = currentItem();
  if (!it) return;
  if (!confirm('确定删除这道题吗？')) return;
  try {
    await dbDelete(it.q.id);
    const qid = it.q.id;
    // 移除该题在队列中的所有项（首次 + 错题重做），并重排主题目序号
    removeQuestionFromQueue(qid);
    toast('已删除');
    if (reviewQueue.length === 0) {
      showReviewComplete();
    } else if (reviewIndex >= reviewQueue.length) {
      reviewIndex = reviewQueue.length - 1;
      renderQuestion();
    } else {
      renderQuestion();
    }
    updateReviewStats();
    refreshBadge();
  } catch (e) {
    toast(e.message, false);
  }
});

// ============ 复习中：添加笔记 / 修改题目 ============
$('#review-note-btn').addEventListener('click', () => {
  clearReviewAutoTimer();
  $('#review-note-text').value = '';
  reviewNoteOriginal = '';
  $('#review-note-editor').classList.remove('hidden');
  $('#review-note-btn').classList.add('hidden');
  $('#review-edit-btn').classList.add('hidden');
});

$('#review-note-cancel').addEventListener('click', () => {
  $('#review-note-editor').classList.add('hidden');
  $('#review-note-text').value = '';
  reviewNoteOriginal = '';
  $('#review-note-btn').classList.remove('hidden');
  $('#review-edit-btn').classList.remove('hidden');
});

let reviewNoteSaving = false;
$('#review-note-save').addEventListener('click', async () => {
  if (reviewNoteSaving) return;
  const it = currentItem();
  if (!it) return;
  const q = it.q;
  const text = $('#review-note-text').value.trim();
  if (!text) return toast('请先输入笔记内容', false);
  if (!Array.isArray(q.notes)) q.notes = [];
  const note = { text, created_at: new Date().toISOString() };
  q.notes.push(note);
  reviewNoteSaving = true;
  $('#review-note-save').disabled = true;
  try {
    await dbPut(q);
    toast('笔记已保存');
    $('#review-note-text').value = '';
    reviewNoteOriginal = '';
    $('#review-note-editor').classList.add('hidden');
    $('#review-note-btn').classList.remove('hidden');
    $('#review-edit-btn').classList.remove('hidden');
    renderReviewNote(q);
  } catch (e) {
    // 写库失败/题目已被别的标签页删除：撤回刚加的笔记，保留输入内容
    q.notes = q.notes.filter((n) => n !== note);
    toast('保存失败：' + e.message, false);
  } finally {
    reviewNoteSaving = false;
    $('#review-note-save').disabled = false;
  }
});

$('#review-edit-btn').addEventListener('click', () => {
  clearReviewAutoTimer();
  const q = currentItem().q;
  loadQuestionToInput(q);
});

$('#review-subject-btn').addEventListener('click', () => {
  clearReviewAutoTimer();
  const it = currentItem();
  if (!it) return;
  openSubjectModal(it.q, 'review');
});

// ============ 列表 ============
let listSelectMode = false;
let selectedIds = new Set();
let listKeyword = '';

// 列表视图状态：mode='all' 主列表（未分类）| 'bank' 行测 | 'subject' 某个科目
let listView = { mode: 'all', subject: null, typeFilter: 'all', page: 1 };
let currentFullList = [];
let currentPageList = []; // 当前页实际显示的题目（「全选本页」只选这一页）
// 每页题数，默认 50
const PAGE_SIZES = [20, 50, 100];
function loadPageSize(key) {
  try {
    const v = parseInt(localStorage.getItem(key), 10);
    return PAGE_SIZES.includes(v) ? v : 50;
  } catch (e) {
    return 50;
  }
}
function savePageSize(key, v) {
  try { localStorage.setItem(key, String(v)); } catch (e) {}
}
let listPageSize = loadPageSize('cuoti.listPageSize');

function matchListFilter(q) {
  if (listKeyword) {
    const kw = listKeyword.toLowerCase();
    const hay = [
      q.question_text,
      q.note,
      ...(Array.isArray(q.notes) ? q.notes.map((n) => (typeof n === 'string' ? n : (n && n.text) || '')) : []),
      ...(Array.isArray(q.options) ? q.options.map((o) => (o && o.text) || '') : []),
    ].join(' ').toLowerCase();
    if (!hay.includes(kw)) return false;
  }
  return true;
}

async function loadList() {
  const isSub = listView.mode === 'bank' || listView.mode === 'subject';

  // 主列表（未分类）与子视图（行测 / 某科目）的 UI 切换
  $('#source-entry').classList.toggle('hidden', isSub);
  $('#sub-view-head').classList.toggle('hidden', !isSub);
  renderListTypeTabs();

  let all;
  try {
    all = await dbGetAll();
  } catch (e) {
    toast('加载失败：' + e.message, false);
    return;
  }
  let fullList = [];

  if (listView.mode === 'bank') {
    // 行测错题：题库做错的（bank_id）与手动录入归入行测的（subject='行测'）合并显示
    fullList = all
      .filter((q) => q.bank_id != null || q.subject === '行测')
      .sort((a, b) => (b.id || 0) - (a.id || 0))
      .filter(matchListFilter);
    $('#list-search-clear').classList.toggle('hidden', !listKeyword);
  } else if (listView.mode === 'subject') {
    // 某科目错题：仅显示该科目的手动录入题
    fullList = all
      .filter((q) => q.bank_id == null && q.subject === listView.subject)
      .sort((a, b) => (b.id || 0) - (a.id || 0))
      .filter(matchListFilter);
    $('#list-search-clear').classList.toggle('hidden', !listKeyword);
  } else if (listKeyword) {
    // 搜索时跨全部错题（未分类 + 各科目 + 行测），避免带科目标签的题搜不到
    fullList = all
      .slice()
      .sort((a, b) => (b.id || 0) - (a.id || 0))
      .filter(matchListFilter);
    $('#list-search-clear').classList.remove('hidden');
    renderSubjectEntries(all);
    renderBankEntryCount(all);
  } else {
    // 默认：仅显示未分类的手动录入题，带科目的题进对应科目入口
    fullList = all
      .filter((q) => q.bank_id == null && !SUBJECTS.includes(q.subject))
      .sort((a, b) => (b.id || 0) - (a.id || 0));
    $('#list-search-clear').classList.add('hidden');
    renderSubjectEntries(all);
    renderBankEntryCount(all);
  }

  // 题型筛选
  if (listView.typeFilter !== 'all') {
    fullList = fullList.filter((q) => q.type === listView.typeFilter);
  }
  // 子视图标题的题数放在题型筛选之后，别出现“标题 100 题、列表 60 题”
  if (isSub) {
    const subLabel = listView.mode === 'bank' ? '行测' : listView.subject;
    $('#sub-view-title').textContent = `${subLabel} · ${fullList.length} 题`;
  }

  // 分页
  const totalPages = Math.max(1, Math.ceil(fullList.length / listPageSize));
  if (listView.page > totalPages) listView.page = totalPages;
  const start = (listView.page - 1) * listPageSize;
  const pageList = fullList.slice(start, start + listPageSize);

  renderListPager(totalPages, fullList.length);
  renderPageSizeBtns($('#list-pager'), listPageSize);
  $('#list-pager').classList.toggle('hidden', fullList.length === 0);

  currentFullList = fullList;
  currentPageList = pageList;
  // 数量口径：当前列表显示多少题就写多少题；纯主列表再额外显示「全部」总数。
  // “全部”必须包含行测题库错题，否则主列表总数会永远比科目入口少一截。
  const isPlainAll = listView.mode === 'all' && !listKeyword && listView.typeFilter === 'all';
  const allWrongCount = all.length;
  $('#list-total-label').textContent = isPlainAll ? '未分类' : '共';
  $('#list-total').textContent = fullList.length;
  $('#list-total-all-wrap').classList.toggle('hidden', !isPlainAll);
  $('#list-total-all').textContent = allWrongCount;
  renderListCards(pageList);
  let emptyText = '';
  if (listKeyword) emptyText = '没有找到匹配的题目';
  else if (listView.typeFilter !== 'all') emptyText = '没有符合筛选的题目';
  else if (listView.mode === 'bank') emptyText = '还没有行测错题';
  else if (listView.mode === 'subject') emptyText = `还没有「${listView.subject}」错题`;
  else if (all.length === 0) emptyText = '还没有录入错题';
  // 主列表只显示未分类题：如果题目都已归入科目/行测，不显示“没有未分类题”的提示，
  // 避免用户误以为题目丢了；科目入口本身已经说明了题目在哪。
  $('#list-empty-text').textContent = emptyText;
  $('#list-empty').classList.toggle('hidden', pageList.length > 0 || !emptyText);

  $('#batch-bar').classList.toggle('hidden', !listSelectMode);
  $('#batch-btn').innerHTML = listSelectMode
    ? '<i class="fa fa-times mr-1"></i>退出删除'
    : '<i class="fa fa-trash-o mr-1"></i>删除题目';
  $('#batch-count').textContent = selectedIds.size;
}

function renderListCards(list) {
  const wrap = $('#list-wrap');
  wrap.innerHTML = '';
  list.forEach((q) => {
    const card = document.createElement('div');
    card.className = 'border border-slate-200 rounded-xl overflow-hidden';
    const typeText = q.type === 'single' ? '单选' : q.type === 'multiple' ? '多选' : '判断';
    const isSel = selectedIds.has(q.id);

    card.innerHTML = `
      <div class="list-head flex items-start gap-3 p-4 cursor-pointer transition ${isSel ? 'bg-primary-50' : 'hover:bg-slate-50'}">
        ${listSelectMode ? `<div class="self-center shrink-0"><i class="fa ${isSel ? 'fa-check-square-o text-primary-500' : 'fa-square-o text-slate-300'} text-lg"></i></div>` : ''}
        <div class="flex-1 min-w-0">
          <div class="flex items-center flex-wrap gap-2 mb-1.5">
            <span class="px-2 py-0.5 rounded-full bg-primary-50 text-primary-600 text-xs font-medium">${typeText}</span>
            ${q.bank_id != null && listView.mode !== 'bank' ? '<span class="px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 text-xs font-medium">行测</span>' : ''}
            ${SUBJECTS.includes(q.subject) && listView.mode !== 'subject' && listView.mode !== 'bank' ? `<span class="px-2 py-0.5 rounded-full bg-primary-50 text-primary-600 text-xs font-medium">${escapeHtml(q.subject)}</span>` : ''}
          </div>
          <p class="text-sm font-medium whitespace-pre-wrap">${escapeHtml(q.question_text) || '（图片题）'}</p>
        </div>
        <div class="flex items-center gap-3 shrink-0">
          ${listSelectMode ? '' : `${listView.mode === 'all' && q.bank_id == null ? `<button class="subject-btn text-slate-400 hover:text-primary-500 transition" data-id="${q.id}" title="设置科目"><i class="fa fa-tag"></i></button>` : ''}<i class="fa fa-chevron-right text-slate-400 text-sm"></i>`}
        </div>
      </div>
    `;

    card.querySelector('.list-head').addEventListener('click', (e) => {
      if (e.target.closest('.del-btn') || e.target.closest('.subject-btn')) return;
      if (listSelectMode) toggleSelect(q.id);
      else showDetail(q);
    });

    wrap.appendChild(card);
  });

  wrap.querySelectorAll('.subject-btn').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const q = list.find((x) => x.id === Number(btn.dataset.id));
      if (q) openSubjectModal(q, 'list');
    })
  );
}

const TYPE_TABS = [
  { key: 'all', label: '全部' },
  { key: 'single', label: '单选' },
  { key: 'multiple', label: '多选' },
  { key: 'judge', label: '判断' },
];

function renderTypeTabs(container, currentType) {
  container.innerHTML = '';
  TYPE_TABS.forEach((t) => {
    const btn = document.createElement('button');
    btn.className = 'w-full px-3 py-1.5 rounded-lg text-sm text-center transition ' + (currentType === t.key ? 'bg-primary-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200');
    btn.textContent = t.label;
    btn.addEventListener('click', () => {
      listView.typeFilter = t.key;
      listView.page = 1;
      listPageBackCount = 0; // 筛选后页码重置，旧的分页返回栈也要丢弃
      selectedIds.clear(); // 筛选后不可见的勾选不能带到下一次批量删除
      loadList();
      window.scrollTo(0, 0);
    });
    container.appendChild(btn);
  });
}

function renderListTypeTabs() {
  renderTypeTabs($('#list-type-tabs'), listView.typeFilter);
}

function renderPager(totalPages, count, pageSize, prevBtn, nextBtn, infoEl) {
  const start = (listView.page - 1) * pageSize + 1;
  const end = Math.min(listView.page * pageSize, count);
  infoEl.textContent = `第 ${listView.page} / ${totalPages} 页（${start}-${end} 题）`;
  prevBtn.disabled = listView.page <= 1;
  nextBtn.disabled = listView.page >= totalPages;
}

function renderPageSizeBtns(container, currentSize) {
  const cur = container.querySelector('.size-current');
  if (cur) cur.textContent = currentSize;
  container.querySelectorAll('.size-btn').forEach((btn) => {
    const active = Number(btn.dataset.size) === currentSize;
    btn.classList.toggle('text-primary-600', active);
    btn.classList.toggle('font-semibold', active);
    btn.classList.toggle('text-slate-600', !active);
  });
}

function renderListPager(totalPages, count) {
  renderPager(totalPages, count, listPageSize, $('#list-prev'), $('#list-next'), $('#list-page-info'));
}

function renderSubjectEntries(all) {
  const wrap = $('#subject-entry-list');
  if (!wrap) return;
  wrap.innerHTML = '';
  SUBJECTS.filter((s) => s !== '行测').forEach((s) => {
    const count = (all || []).filter((q) => q.bank_id == null && q.subject === s).length;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-primary-200 bg-primary-50 hover:bg-primary-100 transition text-left';
    btn.innerHTML = `
      <i class="fa fa-book text-primary-600 text-lg shrink-0"></i>
      <span class="flex-1 min-w-0 text-sm font-semibold text-slate-700 truncate">${escapeHtml(s)}</span>
      <span class="shrink-0 text-xs text-slate-500">${count} 题</span>
      <i class="fa fa-chevron-right text-slate-300 shrink-0"></i>
    `;
    btn.addEventListener('click', () => enterSubjectList(s));
    wrap.appendChild(btn);
  });
}

function renderBankEntryCount(all) {
  const n = (all || []).filter((q) => q.bank_id != null || q.subject === '行测').length;
  // 0 题也要显示“0 题”，否则行测入口看起来像没加载出来。
  $('#bank-entry-count').textContent = `${n} 题`;
}

// ============ 快捷设置科目 ============
let subjectTargetId = null;   // 当前要设置科目的题目 id
let subjectTargetFrom = 'list'; // 'list' | 'detail' | 'review'

function renderSubjectModalOptions(current) {
  const wrap = $('#subject-modal-list');
  if (!wrap) return;
  wrap.innerHTML = '';
  const items = [{ key: null, label: '未分类' }, ...SUBJECTS.map((s) => ({ key: s, label: s }))];
  items.forEach((s) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'px-3 py-2.5 rounded-lg text-sm font-medium transition ' + (current === s.key ? 'bg-primary-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200');
    btn.textContent = s.label;
    btn.addEventListener('click', () => applySubject(s.key));
    wrap.appendChild(btn);
  });
}

function openSubjectModal(q, from) {
  subjectTargetId = q.id;
  subjectTargetFrom = from || 'list';
  renderSubjectModalOptions(q.subject || null);
  $('#subject-modal').classList.remove('hidden');
}

async function applySubject(subject) {
  const id = subjectTargetId;
  $('#subject-modal').classList.add('hidden');
  if (id == null) return;
  try {
    const all = await dbGetAll();
    const q = all.find((x) => x.id === id);
    if (!q) return;
    q.subject = subject;
    await dbPut(q);
    toast(subject ? '已归入「' + subject + '」' : '已设为未分类');
    if (subjectTargetFrom === 'detail') {
      const fresh = (await dbGetAll()).find((x) => x.id === id);
      if (fresh) renderDetail(fresh);
    } else if (subjectTargetFrom === 'review') {
      const it = currentItem();
      if (it && it.q.id === id) {
        it.q.subject = subject;
        $('#review-subject-btn').classList.toggle('hidden', SUBJECTS.includes(subject));
      }
    } else {
      loadList();
    }
  } catch (e) {
    toast(e.message, false);
  }
}

$('#subject-modal-close').addEventListener('click', () => {
  $('#subject-modal').classList.add('hidden');
});
$('#subject-modal').addEventListener('click', (e) => {
  if (e.target === $('#subject-modal')) $('#subject-modal').classList.add('hidden');
});

function enterBankList() {
  listView.mode = 'bank';
  listView.subject = null;
  listView.typeFilter = 'all';
  listView.page = 1;
  listSelectMode = false;
  selectedIds.clear();
  listKeyword = '';
  $('#list-search').value = '';
  pushBack(exitSubList);
  loadList();
  window.scrollTo(0, 0);
}

function enterSubjectList(subject) {
  listView.mode = 'subject';
  listView.subject = subject;
  listView.typeFilter = 'all';
  listView.page = 1;
  listSelectMode = false;
  selectedIds.clear();
  listKeyword = '';
  $('#list-search').value = '';
  pushBack(exitSubList);
  loadList();
  window.scrollTo(0, 0);
}

function exitSubList() {
  listView.mode = 'all';
  listView.subject = null;
  listView.typeFilter = 'all';
  listView.page = 1;
  listSelectMode = false;
  selectedIds.clear();
  loadList();
}

function toggleSelect(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  loadList();
}

$('#batch-btn').addEventListener('click', () => {
  listSelectMode = !listSelectMode;
  selectedIds.clear();
  loadList();
  if (listSelectMode) window.scrollTo(0, 0);
});

// 搜索防抖：每敲一个字都全量读库会卡，等 250ms 再查
let listSearchTimer = null;
$('#list-search').addEventListener('input', (e) => {
  listKeyword = e.target.value.trim();
  listView.page = 1;
  listPageBackCount = 0;
  selectedIds.clear();
  clearTimeout(listSearchTimer);
  listSearchTimer = setTimeout(() => {
    listSearchTimer = null;
    loadList();
  }, 250);
});
$('#list-search-clear').addEventListener('click', () => {
  clearTimeout(listSearchTimer);
  listSearchTimer = null;
  listKeyword = '';
  $('#list-search').value = '';
  listView.page = 1;
  listPageBackCount = 0;
  selectedIds.clear();
  loadList();
});
$('#batch-cancel').addEventListener('click', () => {
  listSelectMode = false;
  selectedIds.clear();
  loadList();
});
$('#batch-delete').addEventListener('click', async () => {
  if (selectedIds.size === 0) return toast('请先选择要删除的题目', false);
  // 只删除当前筛选结果里还看得见的题；筛选/搜索变化后残留的隐藏 id 不参与删除。
  const visibleIds = new Set(currentFullList.map((q) => q.id));
  const ids = [...selectedIds].filter((id) => visibleIds.has(id));
  if (ids.length === 0) return toast('当前列表里没有选中的题，请重新选择', false);
  if (!confirm(`确定删除选中的 ${ids.length} 道题吗？`)) return;
  // 单题失败不影响其它题，最后统一刷新界面
  let ok = 0, fail = 0;
  for (const id of ids) {
    try {
      await dbDelete(id);
      removeQuestionFromQueue(id);
      ok++;
    } catch (e) {
      fail++;
      console.warn('删除失败', id, e);
    }
  }
  saveSession();
  selectedIds.clear();
  listSelectMode = false;
  loadList();
  refreshBadge();
  toast(
    fail > 0 ? `已删除 ${ok} 道，${fail} 道删除失败` : `已删除 ${ok} 道题`,
    fail === 0
  );
});

$('#batch-select-current').addEventListener('click', () => {
  const ids = currentPageList.map((q) => q.id);
  if (ids.length === 0) return toast('当前页没有题目', false);
  const allSelected = ids.every((id) => selectedIds.has(id));
  if (allSelected) {
    ids.forEach((id) => selectedIds.delete(id));
    toast('已取消本页全选');
  } else {
    ids.forEach((id) => selectedIds.add(id));
    toast('已全选本页 ' + ids.length + ' 道题');
  }
  loadList();
});

$('#bank-entry-btn').addEventListener('click', enterBankList);
$('#sub-view-back').addEventListener('click', () => {
  // 子视图内可能翻过多页（每次翻页都压入了返回处理），返回列表时一次性丢弃这些历史记录，
  // 否则 history.back() 只会退一页、不会退出子视图
  if (backHandlers.length > 0) {
    history.go(-backHandlers.length);
    backHandlers.length = 0;
  }
  listPageBackCount = 0;
  exitSubList();
});
// 上一页：若之前压入了分页返回处理，走返回栈消费掉一个（保持栈与页码一致）；否则直接回退一页
function goPrevPage() {
  if (listView.page <= 1) return;
  if (listPageBackCount > 0) {
    history.back();
  } else {
    listView.page--;
    loadList();
    window.scrollTo(0, 0);
  }
}
// 下一页：压入「回退一页」的处理，再翻页
function goNextPage() {
  pushListPageBack();
  listView.page++;
  loadList();
  window.scrollTo(0, 0);
}
$('#list-prev').addEventListener('click', goPrevPage);
$('#list-next').addEventListener('click', goNextPage);

// 每页题数切换（20/50/100）
function closeAllSizeMenus() {
  document.querySelectorAll('.size-menu').forEach((m) => m.classList.add('hidden'));
}
document.addEventListener('click', (e) => {
  // 点击「每页 N ▾」：展开/收起选项菜单
  const toggle = e.target.closest('.size-toggle');
  if (toggle) {
    const menu = toggle.parentElement.querySelector('.size-menu');
    if (!menu) return;
    const willOpen = menu.classList.contains('hidden');
    closeAllSizeMenus();
    if (willOpen) menu.classList.remove('hidden');
    return;
  }
  // 点击某个数字：选中并收起
  const btn = e.target.closest('.size-btn');
  if (btn) {
    listPageSize = Number(btn.dataset.size);
    savePageSize('cuoti.listPageSize', listPageSize);
    listView.page = 1;
    listPageBackCount = 0;
    selectedIds.clear();
    closeAllSizeMenus();
    loadList();
    window.scrollTo(0, 0);
    return;
  }
  // 点击别处：收起所有菜单
  closeAllSizeMenus();
});

// ============ 详情 ============
function renderDetail(q) {
  const answerList = Array.isArray(q.answer) ? q.answer : [];
  const optionList = Array.isArray(q.options) ? q.options : [];
  const typeText = q.type === 'single' ? '单选' : q.type === 'multiple' ? '多选' : '判断';
  const stageNum = Math.max(0, Math.min(Number(q.review_stage) || 0, MASTER_STAGE));
  const mastered = !q.next_review || stageNum >= MASTER_STAGE; // 已掌握 = 无日期，或已到第 6 轮
  const stageText = mastered ? '已掌握' : `第 ${stageNum + 1} 轮复习`;
  const nextText = mastered ? '—' : escapeHtml(String(q.next_review));

  const optionsHtml = optionList
    .filter((opt) => opt && typeof opt === 'object')
    .map((opt) => {
      const isAnswer = answerList.includes(opt.label);
      return `
        <div class="flex items-start gap-2 py-2 ${isAnswer ? 'text-green-700 font-medium' : ''}">
          <span class="opt-badge">${escapeHtml(opt.label)}</span>
          <div class="flex-1 min-w-0">
            ${opt.text ? `<div class="whitespace-pre-wrap">${escapeHtml(opt.text)}</div>` : ''}
            ${opt.image ? `<img src="${escapeHtml(opt.image)}" class="mt-1 max-h-40 rounded-lg" alt="" />` : ''}
          </div>
          ${isAnswer ? '<i class="fa fa-check text-green-500 mt-0.5"></i>' : ''}
        </div>`;
    })
    .join('');

  const notes = getNotes(q);
  const notesHtml = notes.length === 0 ? '' : `
    <div class="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
      <div class="font-semibold text-amber-700 mb-1.5"><i class="fa fa-sticky-note-o mr-1"></i>笔记</div>
      <div id="detail-notes"></div>
    </div>`;

  $('#detail-content').innerHTML = `
    <div class="flex items-center flex-wrap gap-2 mb-4">
      <span class="px-2.5 py-0.5 rounded-full bg-primary-50 text-primary-600 text-xs font-medium">${typeText}</span>
      ${q.bank_id != null ? '<span class="px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-600 text-xs font-medium">行测</span>' : ''}
      ${q.bank_id == null && SUBJECTS.includes(q.subject) ? `<span class="px-2.5 py-0.5 rounded-full bg-primary-50 text-primary-600 text-xs font-medium">${escapeHtml(q.subject)}</span>` : ''}
      <span class="px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-500 text-xs">${stageText}</span>
      <span class="px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-500 text-xs">下次复习：${nextText}</span>
      <span class="px-2.5 py-0.5 rounded-full bg-green-50 text-green-600 text-xs font-medium">正确答案：${escapeHtml(answerList.join('、'))}</span>
    </div>
    <p class="text-base font-medium whitespace-pre-wrap mb-4">${escapeHtml(q.question_text) || '（图片题）'}</p>
    ${q.question_image ? `<img src="${escapeHtml(q.question_image)}" class="mb-4 max-h-96 rounded-lg" alt="题目图片" />` : ''}
    <div class="border-t border-slate-100 pt-3">
      <div class="text-xs font-semibold text-slate-400 mb-1">选项</div>
      ${optionsHtml}
    </div>
    ${notesHtml}
    <div class="mt-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
      <div class="font-semibold text-slate-600 mb-1.5 text-sm"><i class="fa fa-plus-circle mr-1"></i>添加笔记</div>
      <div class="relative">
        <textarea id="detail-note-text" rows="2" class="w-full rounded-lg border border-slate-300 px-3 pr-8 py-2 text-sm focus:ring-2 focus:ring-primary-300 focus:outline-none" placeholder="记录易错点、口诀、解题思路……"></textarea>
        <button type="button" class="input-clear hidden absolute right-2 top-2.5 text-slate-400 hover:text-slate-600" data-target="#detail-note-text"><i class="fa fa-times-circle"></i></button>
      </div>
      <button id="detail-note-save" class="mt-2 px-4 py-1.5 rounded-lg bg-primary-500 text-white text-sm font-medium hover:bg-primary-600 transition">保存笔记</button>
    </div>
    <div class="mt-5 flex flex-wrap gap-2">
      ${q.bank_id == null ? `<button id="detail-subject" class="px-4 py-2 rounded-lg bg-primary-50 text-primary-600 font-medium hover:bg-primary-100 transition"><i class="fa fa-tag mr-1"></i>设置科目</button>` : ''}
      <button id="detail-edit" class="px-4 py-2 rounded-lg bg-primary-50 text-primary-600 font-medium hover:bg-primary-100 transition"><i class="fa fa-pencil-square-o mr-1"></i>修改题目</button>
      <button id="detail-delete" class="hidden px-4 py-2 rounded-lg bg-red-50 text-red-600 font-medium hover:bg-red-100 transition"><i class="fa fa-trash-o mr-1"></i>删除此题</button>
    </div>
  `;

  $('#detail-delete').addEventListener('click', async () => {
    if (!confirm('确定删除这道错题吗？')) return;
    try {
      await dbDelete(q.id);
      removeQuestionFromQueue(q.id);
      saveSession();
      toast('已删除');
      if (backHandlers.length > 0) history.back();
      else switchTab('list');
      refreshBadge();
    } catch (e) {
      toast('删除失败：' + e.message, false);
    }
  });

  $('#detail-edit').addEventListener('click', () => {
    loadQuestionToInput(q, 'detail');
  });

  const detailSubjectBtn = $('#detail-subject');
  if (detailSubjectBtn) detailSubjectBtn.addEventListener('click', () => openSubjectModal(q, 'detail'));

  let detailNoteSaving = false;
  $('#detail-note-save').addEventListener('click', async () => {
    if (detailNoteSaving) return;
    const text = $('#detail-note-text').value.trim();
    if (!text) return toast('请先输入笔记内容', false);
    if (!Array.isArray(q.notes)) q.notes = [];
    const note = { text, created_at: new Date().toISOString() };
    q.notes.push(note);
    detailNoteSaving = true;
    $('#detail-note-save').disabled = true;
    try {
      await dbPut(q);
      toast('笔记已保存');
      renderDetail(q);
    } catch (e) {
      q.notes = q.notes.filter((n) => n !== note);
      toast('保存失败：' + e.message, false);
    } finally {
      detailNoteSaving = false;
      // renderDetail 可能已重建按钮；旧按钮禁用状态不影响新节点
      const btn = $('#detail-note-save');
      if (btn) btn.disabled = false;
    }
  });

  if (notes.length > 0) {
    const box = $('#detail-notes');
    notes.forEach((n, i) => {
      const item = createNoteItem(q, n, () => renderDetail(q));
      if (i > 0) item.classList.add('border-t', 'border-amber-100');
      box.appendChild(item);
    });
  }
}

function showDetail(q) {
  renderDetail(q);
  pushBack(() => switchTab('list'));
  switchTab('detail');
}
$('#back-to-list').addEventListener('click', () => {
  // 正常情况下走浏览器返回；返回栈缺失时兜底回列表，避免直接退出网页
  if (backHandlers.length > 0) history.back();
  else switchTab('list');
});

// ============ 导出 / 导入备份 ============
let importBusy = false; // 导入进行中，防止重复触发导致相似题弹窗互相覆盖

function setBackupMenuOpen(open) {
  $('#backup-menu').classList.toggle('hidden', !open);
  $('#backup-btn').setAttribute('aria-expanded', open ? 'true' : 'false');
}

// header 右上角齿轮菜单
$('#backup-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  clearReviewAutoTimer();
  clearBankAutoTimer();
  setBackupMenuOpen($('#backup-menu').classList.contains('hidden'));
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#backup-btn') && !e.target.closest('#backup-menu')) {
    setBackupMenuOpen(false);
  }
});

$('#auto-next-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  const next = !autoNextEnabled();
  setAutoNextEnabled(next);
  toast(next ? '已开启：答对自动下一题' : '已关闭：答对后停在当前题');
});

$('#export-btn').addEventListener('click', async () => {
  setBackupMenuOpen(false);
  try {
    const all = await dbGetAll();
    if (all.length === 0) return toast('暂无数据可导出', false);
    const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '错题本备份-' + fmtDate(new Date()) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 延迟释放，部分浏览器在 click 后立即 revoke 会导致下载失败
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已导出备份文件');
  } catch (e) {
    toast('导出失败：' + e.message, false);
  }
});

// 导入/覆盖之后，复习页内存里的 q 还是旧快照；只刷新“同类对象”，
// 不重建整个会话，避免打断当前题和已选答案。
async function refreshReviewQueueFromDb() {
  if (!reviewQueue.length) return;
  const all = await dbGetAll();
  const byId = new Map(all.map((q) => [q.id, q]));
  let changed = false;
  reviewQueue.forEach((it) => {
    const fresh = byId.get(it.q.id);
    if (fresh && fresh !== it.q) { it.q = fresh; changed = true; }
  });
  if (!changed) return;
  const cur = currentItem();
  if (!cur || $('#review-box').classList.contains('hidden')) return;
  // 统一走 renderQuestion：它会按新 q.answer/options 重算 currentAnswer，
  // 不能只调 renderAnsweredState（导入覆盖后 currentAnswer 已被清空，会显示“答案空”）。
  renderQuestion();
}

$('#import-btn').addEventListener('click', () => {
  setBackupMenuOpen(false);
  $('#import-file').click();
});
$('#import-file').addEventListener('change', async () => {
  const files = Array.from($('#import-file').files || []);
  $('#import-file').value = ''; // 立即清空，允许再次选择同一个文件重试
  if (!files.length) return;
  if (importBusy) return toast('正在导入，请稍候', false);
  importBusy = true;

  let total = 0, updated = 0, skipped = 0, failed = 0;
  try {
    const existing = await dbGetAll();
    const today = fmtDate(new Date());
    const saved = getSavedSession();
    const sessionToday = !!(saved && saved.date === today);

    for (const file of files) {
      let arr;
      try {
        // 兼容带 BOM 的 JSON 文件；单个文件损坏不影响其它文件
        arr = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
      } catch (e) {
        failed++;
        continue;
      }
      if (!Array.isArray(arr)) { failed++; continue; }

      for (const raw of arr) {
        try {
          // 去掉旧 id，重新生成；对每条题单独校验，坏题跳过不中断整个导入
          const source = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
          const { id, ...rest } = source;
          const q = sanitizeBackupQuestion(rest);
          // 导入的图片也做「白底 + 去黑边」处理，和 JSON 录入一致
          await processQuestionImages(q);
          // 备份导入时，题干和选项完全一样就是同一道题：直接合并复习状态
          // （不会一道一道问），把手机上的做题时间/轮次带过来。
          const exact = existing.find((item) => isSameQuestionContent(q, item));
          if (exact) {
            mergeImportedQuestion(exact, q);
            await dbPut(exact);
            syncReviewItemAfterImport(exact);
            updated++;
            continue;
          }
          // 今日复习会话已开始时，新导入的到期题推迟到明天，避免打乱今日队列与答题卡
          if (q.next_review && q.next_review <= today && sessionToday) {
            q.next_review = fmtDate(addDays(new Date(), 1));
          }
          const similar = findSimilar(q, existing);
          if (similar) {
            const choice = await askDuplicate(q, similar, 'sync');
            if (choice === 'skip') { skipped++; continue; }
          }
          q.id = await dbAdd(q);
          existing.push(q);
          total++;
        } catch (e) {
          failed++;
          console.warn('导入题目跳过：' + e.message);
        }
      }
    }

    const parts = ['成功导入 ' + total + ' 题'];
    if (updated > 0) parts.push('更新 ' + updated + ' 题');
    if (skipped > 0) parts.push('跳过重复 ' + skipped + ' 题');
    if (failed > 0) parts.push('跳过无效 ' + failed + ' 题');
    if (total === 0 && updated === 0 && skipped === 0 && failed === 0) {
      toast('文件里没有题目', false);
    } else {
      toast(parts.join('，'), total > 0 || updated > 0);
    }
    loadList();
    refreshBadge();
    await refreshReviewQueueFromDb();
  } catch (e) {
    toast('导入失败：' + e.message, false);
  } finally {
    importBusy = false;
  }
});

// ============ JSON 录入 ============
$('#to-json-input').addEventListener('click', () => {
  if (isInputDirty() && !confirm('切换到 JSON 录入会清空当前正在录入的内容，确定吗？')) return;
  pushBack(() => {
    $('#input-json').classList.add('hidden');
    $('#input-paste').classList.remove('hidden');
    $('#json-text').value = '';
  });
  resetInput();
  $('#input-paste').classList.add('hidden');
  $('#input-json').classList.remove('hidden');
});
$('#to-paste-input').addEventListener('click', () => {
  if (backHandlers.length > 0) {
    history.back(); // 走 popstate 的未保存确认
  } else {
    if ($('#json-text').value.trim() && !confirm('JSON 内容还没导入，确定返回吗？')) return;
    $('#input-json').classList.add('hidden');
    $('#input-paste').classList.remove('hidden');
    $('#json-text').value = '';
  }
});

$('#json-rule-btn').addEventListener('click', () => {
  $('#json-rule-panel').classList.toggle('hidden');
});

// 给桌面端 AI（豆包 / DeepSeek 等）的现成提示词：规则 + 示例 + 指令
const AI_PROMPT = `请把下面的题目转换成一个 JSON 数组（纯文本，可直接复制粘贴）。

【最重要：输出格式】
只输出这个 JSON 数组本身。不要输出任何解释、开场白、"好的"、结束语，也不要加 \`\`\` 代码块标记。

【JSON 规则】
整体是一个 JSON 数组 [ ... ]，每道题是一个对象，字段如下：
- type：单选=single、多选=multiple、判断=judge
- question_text：题干文字（必填）
- options：选项数组。每个选项用对象 { "label": "A", "text": "选项内容" }，label 用 A/B/C/D（判断题只用 A/B）；也可以把选项直接写成字符串数组 ["选项A内容", "选项B内容", ...]，推荐用对象形式
- answer：正确选项字母数组。单选如 ["D"]、多选如 ["A","C"]、判断 ["A"]=对 / ["B"]=错
- note：备注（可选，没有就省略）
- question_image：题干图片网址或 base64（可选，没有就省略）
- subject：科目（可选）：电路 / 电机 / 电分 / 继保 / 高压 / 设备 / 电力电子 / 行测；不确定就省略

【示例】
[
  {
    "type": "single",
    "question_text": "下列关于潮流计算的计算机算法中，错误的是",
    "options": [
      { "label": "A", "text": "牛顿-拉夫逊法按平方关系收敛，效果最好" },
      { "label": "B", "text": "PQ分解法按线性关系收敛，速度慢于牛顿法" },
      { "label": "C", "text": "PQ分解法主要用于输电系统潮流计算" },
      { "label": "D", "text": "PQ分解法计算速度最快，高斯-赛德尔最慢" }
    ],
    "answer": ["D"],
    "note": "潮流计算",
    "subject": "电分"
  },
  {
    "type": "judge",
    "question_text": "电力系统的频率是衡量电能质量的重要指标之一",
    "options": [
      { "label": "A", "text": "正确" },
      { "label": "B", "text": "错误" }
    ],
    "answer": ["A"]
  }
]

【要求】
接下来把我上传的图片中的题目，全部按上述规则转换成 JSON 数组。`;

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

$('#copy-prompt-btn').addEventListener('click', async () => {
  const ok = await copyText(AI_PROMPT);
  toast(ok ? '提示词已复制，去 AI 里粘贴即可' : '复制失败，请长按文字手动复制', ok);
});

// 把解析出的数组批量录入（上传文件和粘贴文本共用）
async function importJsonArray(arr) {
  if (!Array.isArray(arr)) throw new Error('JSON 顶层必须是数组 [ ... ]');
  if (arr.length === 0) throw new Error('没有题目');
  if (importBusy) throw new Error('正在导入，请稍候');
  importBusy = true;
  try {
    let ok = 0, fail = 0, skipped = 0, retried = 0, replaced = 0;
    const existing = await dbGetAll();
    for (let i = 0; i < arr.length; i++) {
      try {
        const q = normalizeQuestion(arr[i], i);
        await processQuestionImages(q);
        const similar = findSimilar(q, existing);
        if (similar) {
          // JSON 批量录入也是“新录入”：即使来源是别人的备份题，进度也重置为全新题。
          const exact = isSameQuestionContent(q, similar);
          const choice = await askDuplicate(q, similar, 'create', exact);
          if (choice === 'skip') { skipped++; continue; }
          if (choice === 'replace') {
            replaceQuestionContentKeepingProgress(similar, q);
            await dbPut(similar);
            syncReviewItemAfterImport(similar);
            replaced++;
            continue;
          }
          if (choice === 'retry') {
            await dbPut(resetDuplicateForTomorrow(similar));
            removeQuestionFromQueue(similar.id);
            saveSession();
            retried++;
            continue;
          }
        }
        q.id = await dbAdd(q);
        existing.push(q);
        ok++;
      } catch (e) {
        fail++;
        console.warn('第 ' + (i + 1) + ' 题跳过：' + e.message);
      }
    }
    if (ok > 0 || retried > 0 || replaced > 0) {
      toast('成功录入 ' + ok + ' 题' + (replaced > 0 ? '，替换 ' + replaced + ' 题' : '') + (retried > 0 ? '，重新安排 ' + retried + ' 题' : '') + (skipped > 0 ? '，跳过重复 ' + skipped + ' 题' : '') + (fail > 0 ? '，失败 ' + fail + ' 题' : ''));
      loadList();
      refreshBadge();
      await refreshReviewQueueFromDb();
    } else if (skipped > 0) {
      toast('全部为重复题目，已跳过', false);
    } else {
      toast('没有成功录入任何题目，请检查格式', false);
    }
  } finally {
    importBusy = false;
  }
}

// 从 AI 回复 / 文件内容中提取干净的 JSON 数组文本：去掉 BOM、```json 代码块、前后解释文字
function cleanJsonText(raw) {
  let text = String(raw || '').replace(/^\uFEFF/, '').trim();
  if (!text) return '';

  // 1) 整段就是一个 ``` 代码块
  let m = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (m) return m[1].trim();

  // 2) 回复里夹带代码块：提取第一个 ```json 或 ``` 块
  m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (m) return m[1].trim();

  // 3) 没有代码块：直接取最外层 [ ... ] 数组，容忍前面有「好的，以下…」等文字
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) return text.slice(start, end + 1).trim();

  return text;
}

$('#json-upload-btn').addEventListener('click', () => $('#json-file').click());
$('#json-file').addEventListener('change', async () => {
  const file = $('#json-file').files[0];
  $('#json-file').value = '';
  if (!file) return;
  try {
    await importJsonArray(JSON.parse(cleanJsonText(await file.text())));
  } catch (e) {
    toast('导入失败：' + e.message, false);
  }
});

$('#json-parse-btn').addEventListener('click', async () => {
  const text = cleanJsonText($('#json-text').value);
  if (!text) return toast('请先粘贴 JSON 内容', false);
  try {
    await importJsonArray(JSON.parse(text));
    $('#json-text').value = '';
  } catch (e) {
    toast('解析失败：' + e.message, false);
  }
});

// 剥离选项文字行首的序号前缀（A. A、 A： A) （A） 1. ① 等），用于 JSON 导入字符串数组选项
function stripOptionPrefix(text) {
  return String(text || '').replace(
    /^\s*(?:(?:[（(]\s*[A-Da-d]\s*[)）])|(?:[A-Da-d]\s*[.、．:：)）])|(?:[1-8]\s*[.、．:：])|[①②③④⑤⑥⑦⑧])\s*/,
    ''
  ).trim();
}

// 取一个选项（字符串/对象）的纯文字
function optionTextOf(o) {
  if (o == null) return '';
  if (typeof o === 'string') return stripOptionPrefix(o);
  if (typeof o === 'object') return String(o.text || '').trim();
  return String(o).trim();
}

// 把一条 JSON 记录规范成「全新题目」（清空复习进度，去掉 id）
function normalizeQuestion(raw, idx) {
  const where = idx == null ? '' : '第 ' + (idx + 1) + ' 题';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(where + ' 不是有效对象');

  // 题型：先映射中文，再按「两选项且为对/错」识别判断，最后按答案数量识别单/多选
  const TYPE_MAP = { '单选': 'single', '单选题': 'single', '多选': 'multiple', '多选题': 'multiple', '判断': 'judge', '判断题': 'judge' };
  let type = typeof raw.type === 'string' ? raw.type.trim() : raw.type;
  if (TYPE_MAP[type]) type = TYPE_MAP[type];
  if (typeof type === 'string') type = type.toLowerCase();
  if (!['single', 'multiple', 'judge'].includes(type)) {
    const opts = Array.isArray(raw.options) ? raw.options : [];
    if (opts.length === 2) {
      if (/^(正确|对|√|✓)$/.test(optionTextOf(opts[0])) && /^(错误|错|×|✗)$/.test(optionTextOf(opts[1]))) type = 'judge';
    }
    if (!['single', 'multiple', 'judge'].includes(type)) {
      const ansLen = Array.isArray(raw.answer) ? raw.answer.length : (raw.answer != null ? 1 : 0);
      type = ansLen >= 2 ? 'multiple' : 'single';
    }
  }

  const labels = resolveOptionLabels(raw, type, raw.options);

  // 选项：支持数组 [{label,text,image}]、数组 [字符串]、对象 {A:'..', B:'..'}；字符串自动剥离 A./B./1. 前缀
  let options;
  if (Array.isArray(raw.options)) {
    // 选项对象自带 label 时按标签归位（防止数组顺序错乱导致答案对应错误），
    // 纯字符串数组 / 无 label 的旧格式则按数组顺序填写
    const optArr = raw.options;
    const useLabels = optArr.some((o) =>
      o && typeof o === 'object' && o.label != null && normalizeLabel(String(o.label)).length === 1
    );
    options = labels.map((l, i) => {
      const o = useLabels
        ? optArr.find((x) => x && typeof x === 'object' && normalizeLabel(String(x.label || '')) === l)
        : optArr[i];
      let text = '', image = '';
      if (typeof o === 'string') text = stripOptionPrefix(o);
      else if (o && typeof o === 'object') { text = String(o.text || '').trim(); image = typeof o.image === 'string' ? o.image : ''; }
      else if (o != null) text = String(o).trim();
      return { label: l, text, image };
    });
  } else if (raw.options && typeof raw.options === 'object') {
    options = labels.map((l) => {
      const v = raw.options[l];
      if (typeof v === 'string') return { label: l, text: stripOptionPrefix(v), image: '' };
      if (v && typeof v === 'object') return { label: l, text: String(v.text || '').trim(), image: typeof v.image === 'string' ? v.image : '' };
      if (v != null) return { label: l, text: String(v).trim(), image: '' };
      return { label: l, text: '', image: '' };
    });
  } else {
    options = labels.map((l) => ({ label: l, text: '', image: '' }));
  }
  if (type === 'judge') {
    options = [
      { label: 'A', text: '正确', image: '' },
      { label: 'B', text: '错误', image: '' },
    ];
  }

  // 答案：支持数组、单个字母、合并字符串（"AC" / "A,C" / "A、C"）；判断支持「对/错」文字自动转 A/B
  let answer = parseAnswerTokens(raw.answer);
  if (type === 'judge') {
    answer = answer.map((a) => {
      if (/^(正确|对|√|✓|TRUE|是|A)$/.test(a)) return 'A';
      if (/^(错误|错|×|✗|FALSE|否|B)$/.test(a)) return 'B';
      return a;
    });
  }
  // 统一全角字母 / 数字标签（如 Ａ、１），再过滤非法答案
  answer = [...new Set(answer.map((a) => normalizeLabel(a)))].filter((a) => labels.includes(a)).sort();
  // 标注为单选却给了多个答案时，按多选处理，避免复习时永远判错
  if (type === 'single' && answer.length > 1) type = 'multiple';

  const question_text = String(raw.question_text || raw.question || raw.stem || raw.title || '').trim();
  const question_image = typeof raw.question_image === 'string' ? raw.question_image : '';
  const note = String(raw.note || '').trim();

  if (!question_text && !question_image) throw new Error(where + ' 缺少题干（question_text）');
  if (options.some((o) => !o.text && !o.image)) throw new Error(where + ' 选项内容不完整');
  if (answer.length === 0) throw new Error(where + ' 缺少正确答案（answer）');

  // 当作全新题目：清空复习进度
  return {
    type,
    question_text,
    question_image,
    options,
    answer,
    subject: SUBJECTS.includes(raw.subject) ? raw.subject : null,
    note,
    notes: [],
    review_stage: 0,
    next_review: fmtDate(addDays(new Date(), INTERVALS[0])),
    correct_count: 0,
    // 新录入/新导入的题还没在 App 里作答，答错次数从 0 开始；
    // 第一次复习答错才记 1 次，避免“录入即 1 次 + 第一次答错又 1 次”。
    wrong_count: 0,
    last_reviewed: '',
    last_result: '',
    created_at: new Date().toISOString(),
  };
}

// 备份导入：保留复习进度，同时校验/修复字段，避免损坏或第三方备份文件导致页面崩溃
function sanitizeBackupQuestion(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('不是有效题目对象');

  const TYPE_MAP = { '单选': 'single', '单选题': 'single', '多选': 'multiple', '多选题': 'multiple', '判断': 'judge', '判断题': 'judge' };
  let type = typeof raw.type === 'string' ? raw.type.trim() : '';
  type = TYPE_MAP[type] || type.toLowerCase();
  if (!['single', 'multiple', 'judge'].includes(type)) {
    // 备份里缺 type 时，先认“两个选项且是正确/错误”的判断题，别按单选处理导致缺 C/D 报错
    const opts = Array.isArray(raw.options) ? raw.options : [];
    const looksJudge = opts.length === 2 &&
      /^(正确|对|√|✓)$/.test(optionTextOf(opts[0])) &&
      /^(错误|错|×|✗)$/.test(optionTextOf(opts[1]));
    type = looksJudge
      ? 'judge'
      : ((Array.isArray(raw.answer) && raw.answer.length >= 2) ? 'multiple' : 'single');
  }
  const labels = resolveOptionLabels(raw, type, raw.options);

  // 答案：对/错文字转 A/B，全角字母与数字序号归一，过滤非法标签；
  // 与 JSON 录入共用 parseAnswerTokens，支持 "AC" / "A,C" 合并串，不再整条丢弃
  let answerRaw = parseAnswerTokens(raw.answer);
  if (type === 'judge') {
    answerRaw = answerRaw.map((a) =>
      /^(正确|对|√|✓|TRUE|是|A)$/i.test(a) ? 'A' :
      /^(错误|错|×|✗|FALSE|否|B)$/i.test(a) ? 'B' : a
    );
  }
  const answer = [...new Set(answerRaw.map((a) => normalizeLabel(a)))].filter((a) => labels.includes(a)).sort();
  if (answer.length === 0) throw new Error('缺少正确答案');
  if (type === 'single' && answer.length > 1) type = 'multiple';

  // 选项：支持数组与 { A: '...' }；数组带 label 时按标签归位，否则按顺序；
  // 字符串以外的字段一律丢弃
  const rawOpts = Array.isArray(raw.options) ? raw.options : null;
  const useLabels = !!rawOpts && rawOpts.some((o) =>
    o && typeof o === 'object' && o.label != null && normalizeLabel(String(o.label)).length === 1
  );
  const findOption = (l) => {
    if (rawOpts) {
      const o = useLabels
        ? rawOpts.find((x) => x && typeof x === 'object' && normalizeLabel(String(x.label || '')) === l)
        : rawOpts[labels.indexOf(l)];
      if (typeof o === 'string') return { text: o };
      if (o && typeof o === 'object') return o;
      return null;
    }
    if (raw.options && typeof raw.options === 'object') {
      const v = raw.options[l];
      if (typeof v === 'string') return { text: v };
      if (v && typeof v === 'object') return v;
    }
    return null;
  };
  let options = labels.map((l) => {
    const o = findOption(l) || {};
    return {
      label: l,
      text: typeof o.text === 'string' ? o.text.trim() : (o.text == null ? '' : String(o.text).trim()),
      image: typeof o.image === 'string' ? o.image : '',
    };
  });
  if (type === 'judge') {
    options = [{ label: 'A', text: '正确', image: '' }, { label: 'B', text: '错误', image: '' }];
  } else if (options.some((o) => !o.text && !o.image)) {
    throw new Error('选项内容不完整');
  }

  const question_text = typeof raw.question_text === 'string' ? raw.question_text.trim() : '';
  const question_image = typeof raw.question_image === 'string' ? raw.question_image : '';
  if (!question_text && !question_image) throw new Error('缺少题干');

  const stageNum = Number(raw.review_stage);
  const review_stage = Number.isFinite(stageNum)
    ? Math.max(0, Math.min(MASTER_STAGE, Math.trunc(stageNum)))
    : 0;
  let next_review;
  if (review_stage >= MASTER_STAGE) {
    // 已掌握：必须没有下次复习日期，兼容 stage=6 但带了日期的旧/坏数据
    next_review = '';
  } else if (raw.next_review === '') {
    // 轮次还没到 6 却给空日期：这是“没安排复习”，按当前轮次补一个，别当成已掌握
    next_review = fmtDate(addDays(new Date(), INTERVALS[Math.min(review_stage, INTERVALS.length - 1)]));
  } else if (isRealDate(raw.next_review)) {
    next_review = raw.next_review;
  } else {
    next_review = fmtDate(addDays(new Date(), INTERVALS[Math.min(review_stage, INTERVALS.length - 1)]));
  }

  const count = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  };
  const notes = Array.isArray(raw.notes)
    ? raw.notes.map((n) => {
        if (typeof n === 'string') return { text: n.trim() };
        if (n && typeof n.text === 'string') {
          return { text: n.text.trim(), created_at: typeof n.created_at === 'string' ? n.created_at : '' };
        }
        return null;
      }).filter((n) => n && n.text)
    : [];

  const q = {
    type,
    question_text,
    question_image,
    options,
    answer,
    subject: SUBJECTS.includes(raw.subject) ? raw.subject : null,
    note: typeof raw.note === 'string' ? raw.note : '',
    notes,
    review_stage,
    next_review,
    correct_count: count(raw.correct_count),
    wrong_count: count(raw.wrong_count),
    last_reviewed: isRealDate(raw.last_reviewed) ? raw.last_reviewed : '',
    last_result: raw.last_result === 'correct' || raw.last_result === 'wrong' ? raw.last_result : '',
    created_at: typeof raw.created_at === 'string' && raw.created_at ? raw.created_at : new Date().toISOString(),
  };
  if (Number.isInteger(raw.bank_id)) q.bank_id = raw.bank_id;
  return q;
}

// ============ 徽标 ============
function refreshBadge() {
  const badge = $('#due-badge');
  const apply = (n) => {
    badge.textContent = n;
    badge.classList.toggle('hidden', n === 0);
  };
  // 有活跃复习会话时，红圈显示剩余待复习（首次）题数，与复习页「待复习 X 题」保持一致，不含错题重做
  if (reviewQueue.length > 0) {
    apply(pendingMainCount());
  } else {
    // 刷新后队列为空：优先用今日已保存会话的剩余待做题数
    const saved = getSavedSession();
    const today = fmtDate(new Date());
    if (saved && saved.date === today && Array.isArray(saved.items) && saved.items.length > 0) {
      apply(saved.items.filter((x) => x && x.status === 'pending' && x.kind !== 'redo').length);
    } else {
      dbGetAll().then((all) => {
        // 查询期间可能已经进入复习会话，此时以会话剩余题数为准，避免旧结果覆盖红圈
        if (reviewQueue.length > 0) { apply(pendingMainCount()); return; }
        const due = all.filter((q) => q.next_review && q.next_review <= today).length;
        apply(due);
      }).catch(() => {});
    }
  }
}

// ============ 输入框一键清空 ============
function updateClearBtn(input) {
  if (!input || !input.id) return;
  const btn = document.querySelector('.input-clear[data-target="#' + input.id + '"]');
  if (btn) btn.classList.toggle('hidden', !input.value);
}
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t && t.matches && t.matches('input, textarea')) updateClearBtn(t);
});
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.input-clear');
  if (!btn) return;
  const input = document.querySelector(btn.dataset.target);
  if (!input) return;
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  updateClearBtn(input);
  input.focus();
});

// ============ 题库刷题 ============
const BANK_PROGRESS_KEY = 'cuoti.bank.progress';
const BANK_ANSWERS_KEY = 'cuoti.bank.answers';
const BANK_CATS = ['形势政策', '企业文化', '公司战略', '新型电力系统', '品牌建设'];
let bankCategory = null;   // 当前分类名
let bankList = [];         // 当前分类的题列表（按 bank_id 升序）
let bankIndex = 0;         // 当前题在 bankList 的索引
let bankItems = [];        // 每题作答状态 { status: null|'correct'|'wrong', selected: [] }
let bankAutoTimer = null;  // 做对后自动跳下一题的定时器
const BANK_AUTO_NEXT_DELAY = 200; // 做对后停留时长(ms)，短于手动点下一题

function loadBankProgress() {
  try {
    const v = JSON.parse(localStorage.getItem(BANK_PROGRESS_KEY));
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    // 只保留合法分类 + 非负整数：损坏的负数/字符串/对象不再显示成“已刷到第 -2 题”
    const clean = {};
    Object.keys(v).forEach((k) => {
      const n = Number(v[k]);
      if (BANK_CATS.includes(k) && Number.isInteger(n) && n >= 0) clean[k] = n;
    });
    return clean;
  } catch (e) { return {}; }
}

function saveBankProgress(category, index) {
  const p = loadBankProgress();
  // 记录上次停留的题号索引，下次从这里继续；刷完（归 0）从头
  p[category] = index;
  try { localStorage.setItem(BANK_PROGRESS_KEY, JSON.stringify(p)); } catch (e) {}
}

// 每题作答结果持久化：{ [category]: { [bank_id]: { status, selected } } }，刷新后答题卡仍能看到历史对错与错选
function loadBankAnswers() {
  try {
    const v = JSON.parse(localStorage.getItem(BANK_ANSWERS_KEY));
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch (e) { return {}; }
}
function saveBankAnswer(category, bankId, status, selected) {
  const all = loadBankAnswers();
  if (!all[category]) all[category] = {};
  // 同时记录当时选了哪些选项，刷新后仍能显示错选
  all[category][bankId] = { status, selected: Array.isArray(selected) ? selected : [] };
  try { localStorage.setItem(BANK_ANSWERS_KEY, JSON.stringify(all)); } catch (e) {}
}
function clearBankAnswers(category) {
  const all = loadBankAnswers();
  delete all[category];
  try { localStorage.setItem(BANK_ANSWERS_KEY, JSON.stringify(all)); } catch (e) {}
}
function removeBankAnswer(category, bankId) {
  const all = loadBankAnswers();
  if (all[category]) {
    delete all[category][bankId];
    if (Object.keys(all[category]).length === 0) delete all[category];
  }
  try { localStorage.setItem(BANK_ANSWERS_KEY, JSON.stringify(all)); } catch (e) {}
}

function bankCatCount(category) {
  return (window.BANK_DATA || []).filter((q) => q.category === category).length;
}

function renderBankCategories() {
  clearBankAutoTimer();
  // 从刷题/答题卡退回分类页时，把答题卡弹层一起关掉，避免它盖在分类页上继续改隐藏状态
  $('#answer-sheet-modal').classList.add('hidden');
  $('#bank-quiz').classList.add('hidden');
  $('#bank-categories').classList.remove('hidden');
  const progress = loadBankProgress();
  const wrap = $('#bank-cat-list');
  wrap.innerHTML = '';
  BANK_CATS.forEach((cat) => {
    const total = bankCatCount(cat);
    const p = progress[cat];
    const statusText = p == null ? '未开始' : p >= total ? '已刷完' : `已刷到第 ${p + 1} 题`;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'text-left p-4 rounded-xl border border-slate-200 hover:border-primary-300 hover:bg-primary-50 transition';
    card.innerHTML = `
      <div class="flex items-center justify-between mb-1">
        <span class="font-semibold text-slate-700">${cat}</span>
        <span class="text-xs text-slate-400">${total} 题</span>
      </div>
      <div class="flex items-center justify-between text-xs text-slate-500">
        <span>${statusText}</span>
        <i class="fa fa-angle-right text-slate-300"></i>
      </div>`;
    card.addEventListener('click', () => startBankQuiz(cat));
    wrap.appendChild(card);
  });
}

function startBankQuiz(category) {
  clearBankAutoTimer();
  bankCategory = category;
  bankList = (window.BANK_DATA || [])
    .filter((q) => q.category === category)
    .sort((a, b) => a.bank_id - b.bank_id);
  if (bankList.length === 0) { toast('该分类暂无题目', false); return; }
  const savedAnswers = loadBankAnswers()[category] || {};
  bankItems = bankList.map((q) => {
    const st = savedAnswers[q.bank_id];
    if (!st) return { status: null, selected: [] };
    // 兼容旧格式（直接存 'correct'/'wrong'）
    const status = typeof st === 'string' ? st : st.status;
    const selected = st && Array.isArray(st.selected) ? st.selected : [];
    return (status === 'correct' || status === 'wrong')
      ? { status, selected }
      : { status: null, selected: [] };
  });
  const p = loadBankProgress()[category];
  // 进度损坏（负数/非整数）或已刷完时，都从第一题开始
  const idx = (Number.isInteger(p) && p >= 0 && p < bankList.length) ? p : 0;
  if (p != null && p >= bankList.length) saveBankProgress(category, 0);
  bankIndex = idx;
  // 进入后保留已答状态；要重做点结果区的「重做本题」，避免一进分类/看答题卡就抹掉记录
  $('#bank-categories').classList.add('hidden');
  $('#bank-quiz').classList.remove('hidden');
  pushBack(() => renderBankCategories());
  renderBankQuestion();
}

function renderBankQuestion() {
  clearBankAutoTimer();
  const q = bankList[bankIndex];
  if (!q) return;
  const item = bankItems[bankIndex];
  const answered = item && item.status !== null;

  $('#bank-progress').textContent = `第 ${bankIndex + 1} / ${bankList.length} 题`;
  const catBadge = $('#bank-category-badge');
  if (catBadge) {
    catBadge.textContent = bankCategory || '';
    catBadge.className = 'px-2 py-0.5 rounded-full bg-primary-50 text-primary-600 font-medium';
  }
  applyTypeBadge($('#bank-type-badge'), q.type);
  $('#bank-question').textContent = q.question_text || '';

  renderBankOptions(q, answered ? item.selected : []);

  if (answered) {
    renderBankAnsweredState();
  } else {
    $('#bank-result').classList.add('hidden');
    $('#bank-result').innerHTML = '';
    $('#bank-submit').classList.remove('hidden');
  }
  refreshBankBar();
}

function renderBankOptions(q, selected) {
  const wrap = $('#bank-options');
  wrap.innerHTML = '';
  const answered = bankItems[bankIndex].status !== null;
  (q.options || []).forEach((opt) => {
    const div = document.createElement('div');
    div.className = 'review-opt' + (selected.includes(opt.label) ? ' selected' : '');
    div.dataset.label = opt.label;
    div.style.pointerEvents = answered ? 'none' : ''; // 已判分就锁住，避免事后改选造成“判分和画面对不上”
    div.innerHTML = `<span class="badge">${escapeHtml(opt.label)}</span><span class="flex-1 min-w-0"><div>${escapeHtml(opt.text || '')}</div></span>`;
    if (!answered) {
      div.tabIndex = 0;
      div.setAttribute('role', 'button');
      div.setAttribute('aria-pressed', selected.includes(opt.label) ? 'true' : 'false');
      const selectOption = () => {
        const item = bankItems[bankIndex];
        if (q.type === 'multiple') {
          item.selected = item.selected.includes(opt.label)
            ? item.selected.filter((x) => x !== opt.label)
            : [...item.selected, opt.label].sort();
        } else {
          item.selected = [opt.label];
        }
        wrap.querySelectorAll('.review-opt').forEach((el) => {
          const on = item.selected.includes(el.dataset.label);
          el.classList.toggle('selected', on);
          el.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      };
      div.addEventListener('click', selectOption);
      div.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectOption();
        }
      });
    }
    wrap.appendChild(div);
  });
}

function renderBankAnsweredState() {
  const q = bankList[bankIndex];
  const item = bankItems[bankIndex];
  const correct = item.status === 'correct';
  const answerSet = new Set(q.answer || []);
  document.querySelectorAll('#bank-options .review-opt').forEach((el) => {
    const label = el.dataset.label;
    el.classList.remove('correct', 'wrong');
    if (answerSet.has(label)) el.classList.add('correct');
    if (item.selected.includes(label) && !answerSet.has(label)) el.classList.add('wrong');
    el.style.pointerEvents = 'none';
  });
  const result = $('#bank-result');
  result.classList.remove('hidden');
  result.innerHTML = correct
    ? `<div class="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-700"><i class="fa fa-check-circle mr-1"></i>回答正确</div>`
    : `<div class="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700"><i class="fa fa-times-circle mr-1"></i>回答错误，正确答案：${escapeHtml(q.answer.join('、'))}</div>`;
  const redo = document.createElement('button');
  redo.type = 'button';
  redo.id = 'bank-redo';
  redo.className = 'mt-2 w-full py-2 rounded-lg border border-slate-300 text-sm font-semibold text-slate-600 hover:bg-slate-50 transition';
  redo.innerHTML = '<i class="fa fa-rotate-left mr-1"></i>重做本题';
  redo.addEventListener('click', () => {
    clearBankAutoTimer();
    const it = bankItems[bankIndex];
    if (!it) return;
    it.status = null;
    it.selected = [];
    removeBankAnswer(bankCategory, bankList[bankIndex].bank_id);
    renderBankQuestion();
  });
  result.appendChild(redo);
  $('#bank-submit').classList.add('hidden');
}

function refreshBankBar() {
  const item = bankItems[bankIndex];
  const answered = item && item.status !== null;
  $('#bank-submit').classList.toggle('hidden', answered);
  const prev = $('#bank-prev');
  prev.disabled = bankIndex === 0;
  prev.classList.toggle('opacity-40', bankIndex === 0);
  prev.classList.remove('hidden');
  $('#bank-next').classList.remove('hidden');
}

async function addToWrongBook(q) {
  try {
    const all = await dbGetAll();
    const existing = all.find((x) => x.bank_id === q.bank_id);
    if (!existing) {
      const newQ = {
        type: q.type,
        question_text: q.question_text,
        question_image: '',
        options: (q.options || []).map((o) => ({ label: o.label, text: o.text, image: '' })),
        answer: q.answer,
        note: '',
        notes: [],
        bank_id: q.bank_id,
        review_stage: 0,
        next_review: fmtDate(addDays(new Date(), INTERVALS[0])),
        correct_count: 0,
        wrong_count: 1,
        last_reviewed: '',
        last_result: '',
        created_at: new Date().toISOString(),
      };
      await dbAdd(newQ);
    } else {
      // 题库里每次做错都累加错题次数，并回到第 0 轮、明天再复习
      existing.wrong_count = (Number(existing.wrong_count) || 0) + 1;
      existing.review_stage = 0;
      existing.next_review = fmtDate(addDays(new Date(), INTERVALS[0]));
      await dbPut(existing);
    }
    refreshBadge();
  } catch (e) {
    console.error('记入错题本失败', e);
    toast('记入错题本失败：' + e.message, false);
  }
}

function clearBankAutoTimer() {
  if (bankAutoTimer) { clearTimeout(bankAutoTimer); bankAutoTimer = null; }
}

function scheduleAutoNext() {
  clearBankAutoTimer();
  if (!autoNextEnabled()) return;
  // 最后一题不要自动退出：让用户看清判分和正确答案；手动点「下一题」再回分类
  if (bankIndex >= bankList.length - 1) return;
  bankAutoTimer = setTimeout(() => {
    bankAutoTimer = null;
    if (!autoNextEnabled()) return;
    bankNext();
  }, BANK_AUTO_NEXT_DELAY);
}

function bankSubmit() {
  clearBankAutoTimer();
  const item = bankItems[bankIndex];
  if (!item || item.status !== null) return;
  if (item.selected.length === 0) return toast('请先选择答案', false);
  const q = bankList[bankIndex];
  const correct = sameSet(item.selected, q.answer || []);
  item.status = correct ? 'correct' : 'wrong';
  saveBankAnswer(bankCategory, q.bank_id, item.status, item.selected);
  // 提交即保存进度：答完不点“下一题”就切页签/返回，分类卡也不会还是“未开始”；
  // 最后一题提交后记成 length，分类卡显示“已刷完”。
  saveBankProgress(bankCategory, bankIndex >= bankList.length - 1 ? bankList.length : bankIndex);
  if (!correct) {
    addToWrongBook(q);
    toast('已记入错题本');
  }
  renderBankAnsweredState();
  refreshBankBar();
  if (correct) scheduleAutoNext();
}

function bankNext() {
  clearBankAutoTimer();
  const n = bankList.length;
  if (n === 0) return;
  const next = bankIndex + 1;
  if (next < n) {
    bankIndex = next;
    saveBankProgress(bankCategory, next);
    renderBankQuestion();
  } else {
    const firstPending = bankItems.findIndex((it) => it.status === null);
    if (firstPending >= 0) {
      bankIndex = firstPending;
      saveBankProgress(bankCategory, firstPending);
      renderBankQuestion();
    } else {
      saveBankProgress(bankCategory, bankList.length);
      // 保留作答记录：下次进来只从第一题重新开始，不再把整类答题卡清空
      toast('本分类已刷完');
      if (backHandlers.length > 0) history.back();
      else renderBankCategories();
    }
  }
}

function bankPrev() {
  clearBankAutoTimer();
  if (bankIndex - 1 >= 0) {
    bankIndex -= 1;
    saveBankProgress(bankCategory, bankIndex);
    renderBankQuestion();
  }
}

function renderBankAnswerSheet() {
  const grid = $('#answer-sheet-grid');
  grid.innerHTML = '';
  $('#answer-sheet-title').textContent = '答题卡';
  bankList.forEach((q, i) => {
    const st = bankItems[i] ? bankItems[i].status : null;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = i + 1;
    if (st === 'correct') btn.className = 'h-11 rounded-lg font-semibold text-sm bg-green-500 text-white';
    else if (st === 'wrong') btn.className = 'h-11 rounded-lg font-semibold text-sm bg-red-500 text-white';
    else btn.className = 'h-11 rounded-lg font-semibold text-sm bg-slate-200 text-slate-500';
    btn.addEventListener('click', () => {
      clearBankAutoTimer();
      $('#answer-sheet-modal').classList.add('hidden');
      bankIndex = i;
      saveBankProgress(bankCategory, i);
      // 答题卡只负责跳转，不重置作答；重做走结果区的按钮
      renderBankQuestion();
    });
    grid.appendChild(btn);
  });
}

$('#bank-submit').addEventListener('click', bankSubmit);
$('#bank-next').addEventListener('click', bankNext);
$('#bank-prev').addEventListener('click', bankPrev);
$('#bank-sheet-btn').addEventListener('click', () => {
  clearBankAutoTimer();
  renderBankAnswerSheet();
  $('#answer-sheet-modal').classList.remove('hidden');
});

// ============ 私人 AI 解析（仅解锁的设备可见） ============
const AI_TOKEN_KEY = 'cuoti.ai.token';
const AI_CACHE_KEY = 'cuoti.ai.cache.v2';
const AI_ENDPOINT = '/api/ai';
let aiBusy = false;

function getAiToken() {
  try { return localStorage.getItem(AI_TOKEN_KEY) || ''; } catch (e) { return ''; }
}

function aiUnlocked() {
  return !!getAiToken();
}

function updateAiVisibility() {
  const it = currentItem();
  const canAnswer = !!it && (it.status === 'pending' || it.retry === true);
  const row = $('#review-ai-row');
  // 只在「已作答」且本机已解锁时显示 AI；作答前不显示，避免直接看答案
  if (row) row.classList.toggle('hidden', !aiUnlocked() || !it || canAnswer);
  const modal = $('#ai-modal');
  if (modal && !aiUnlocked()) modal.classList.add('hidden');
}

// 私人口令只存在本机浏览器；网址后加 #ai-unlock 解锁，#ai-lock 锁定
// 已经解锁过再用 #ai-unlock 打开时不再弹框，避免收藏了解锁网址后每次打开都要输一遍
function initAiUnlock() {
  if (location.hash === '#ai-unlock') {
    let token = null;
    if (!getAiToken()) {
      token = prompt('请输入 AI 私人口令（只保存在这台设备）');
    }
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    if (token && token.trim()) {
      const t = token.trim();
      const saveToken = () => {
        try { localStorage.setItem(AI_TOKEN_KEY, t); } catch (e) {}
        updateAiVisibility();
        toast('AI 已在这台设备解锁');
      };
      if (location.protocol === 'file:') {
        saveToken();
      } else {
        // 先在服务端校验口令，口令正确才保存，避免错误口令也显示 AI 按钮
        fetch(AI_ENDPOINT, { method: 'GET', headers: { Authorization: 'Bearer ' + t } })
          .then((res) => {
            if (res.status === 401) toast('口令不正确，AI 未解锁', false);
            else saveToken();
          })
          .catch(saveToken); // 网络异常时先保存，真正请求时再校验
      }
    }
  } else if (location.hash === '#ai-lock') {
    try { localStorage.removeItem(AI_TOKEN_KEY); } catch (e) {}
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    toast('AI 已在这台设备锁定');
  }
  updateAiVisibility();
}

function hashText(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// 只接受压缩后的本地位图或 http(s) 图片；其他格式/超大图片不带给 AI
function aiImageValue(img) {
  const s = typeof img === 'string' ? img.trim() : '';
  if (!s) return '';
  if (/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(s)) {
    return s.length <= 4 * 1024 * 1024 ? s : '';
  }
  if (/^https?:\/\/\S+$/i.test(s) && s.length <= 8192) return s;
  return '';
}

// 用「当前屏幕上实际显示的选项顺序」构造请求，保证 AI 说的 A/B/C/D 和用户看到的一致
function buildAiPayload(it) {
  const q = it.q;
  const labels = Array.isArray(it.labels) && it.labels.length
    ? it.labels
    : (q.type === 'judge' ? LABELS_JUDGE : LABELS_ALL);
  const contents = Array.isArray(it.contents) && it.contents.length
    ? it.contents
    : labels.map((l) => {
        const o = (Array.isArray(q.options) ? q.options : []).find((x) => x && x.label === l) || {};
        return { text: o.text || '', image: o.image || '' };
      });
  const order = Array.isArray(it.order) && it.order.length === contents.length
    ? it.order
    : contents.map((_, i) => i);
  // 与 Worker 一致的总大小上限，超出的图片不再上传，省流量也避免请求被拒
  let imageBudget = 16 * 1024 * 1024;
  let droppedImages = 0; // 因过大/格式不支持而没发给 AI 的图片数，用来提示用户
  const takeImage = (img) => {
    const raw = typeof img === 'string' ? img.trim() : '';
    const v = aiImageValue(raw);
    if (!v) {
      if (/^(data:image\/|https?:\/\/)/i.test(raw)) droppedImages++;
      return '';
    }
    if (v.length > imageBudget) { droppedImages++; return ''; }
    imageBudget -= v.length;
    return v;
  };
  const questionImage = takeImage(q.question_image);
  const options = labels.map((label, pos) => {
    const c = contents[order[pos]] || {};
    return {
      label,
      text: c.text || (c.image ? '（见选项配图）' : ''),
      image: takeImage(c.image),
    };
  });
  const answer = Array.isArray(it.currentAnswer) ? it.currentAnswer : [];
  return {
    question: String(q.question_text || ''),
    questionImage,
    type: ['single', 'multiple', 'judge'].includes(q.type) ? q.type : 'single',
    options,
    answer,
    droppedImages,
  };
}

// 记录「生成解析时」每个字母对应哪个选项内容，用于之后选项顺序变化时换算字母
function aiOptionKeys(it) {
  const q = it.q;
  const labels = Array.isArray(it.labels) && it.labels.length
    ? it.labels
    : (q.type === 'judge' ? LABELS_JUDGE : LABELS_ALL);
  const contents = Array.isArray(it.contents) && it.contents.length
    ? it.contents
    : labels.map((l) => {
        const o = (Array.isArray(q.options) ? q.options : []).find((x) => x && x.label === l) || {};
        return { text: o.text || '', image: o.image || '' };
      });
  const order = Array.isArray(it.order) && it.order.length === contents.length
    ? it.order
    : contents.map((_, i) => i);
  return labels.map((label, pos) => {
    const c = contents[order[pos]] || {};
    const text = c.text || '';
    return { label, key: text ? 't:' + text : (c.image ? 'i:' + hashText(c.image) : '') };
  });
}

// 把旧解析里的 A/B/C/D 换成本次屏幕上的字母；只替换明确的选项引用，避免误伤公式
function remapAiLabels(text, fromOptions, toOptions) {
  if (!text || !Array.isArray(fromOptions) || !Array.isArray(toOptions)) return text;
  const countKeys = (list) => list.reduce((m, o) => {
    const k = o && o.key;
    if (k) m[k] = (m[k] || 0) + 1;
    return m;
  }, {});
  const fromCount = countKeys(fromOptions);
  const toCount = countKeys(toOptions);
  const map = {};
  let changed = false;
  fromOptions.forEach((o) => {
    if (!o || !o.label || !o.key) return;
    if (fromCount[o.key] !== 1 || toCount[o.key] !== 1) return;
    const target = toOptions.find((t) => t && t.key === o.key);
    if (target && target.label && target.label !== o.label) {
      map[o.label] = target.label;
      changed = true;
    }
  });
  if (!changed) return text;

  const remapInline = (line) => {
    // 「选项A、C」「选项A和C」要逐个替换，不能只换第一个字母
    const inlineRe = /(选项\s*)([A-D](?:\s*[、,，/和]\s*[A-D])*)|([A-D])(\s*项)|([（(]\s*)([A-D])(\s*[）)])|([A-D](?:\s*[、,，/和]\s*[A-D])+)/g;
    return line.replace(inlineRe, (m, p1, l1, l2, p2, p3, l3, p4, run) => {
      if (l1) return p1 + l1.replace(/[A-D]/g, (ch) => map[ch] || ch);
      if (l2) return (map[l2] || l2) + p2;
      if (l3) return p3 + (map[l3] || l3) + p4;
      if (run) return run.replace(/[A-D]/g, (ch) => map[ch] || ch);
      return m;
    });
  };

  return String(text).split('\n').map((line) => {
    // 答案行：兼容「答案：A」「答案：A。」「答案：A（…）」「**答案：A**」，
    // 只换算「答案：」后开头那段字母，不动后面的解释。
    const ans = line.match(/^(\s*(?:\*\*)?\s*答案\s*[：:]\s*)([\s\S]*)$/);
    if (ans) {
      const rest = ans[2];
      const lead = rest.match(/^([A-D]{1,4}(?:\s*[、,，;；/和]\s*[A-D]{1,4})*)/);
      if (lead) {
        const tail = rest.slice(lead[1].length);
        return ans[1] + lead[1].replace(/[A-D]/g, (ch) => map[ch] || ch) + remapInline(tail);
      }
      return remapInline(line);
    }
    // 选项行：行首字母是编号（兼容 **A.**），单独换算；其余部分再处理行内引用
    const head = line.match(/^(\s*(?:\*\*|\*)?\s*)([A-D])(?=\s*[.．:：、]|\s+(?:对|错|正确|错误))([\s\S]*)$/);
    if (head) {
      return head[1] + (map[head[2]] || head[2]) + remapInline(head[3]);
    }
    return remapInline(line);
  }).join('\n');
}

// 缓存 key 与选项顺序无关：顺序变了直接复用解析，再把字母换算过来
// 图片也纳入 key：题干/选项图换了，解析必须重新生成
function aiCacheKey(payload, q) {
  const optionKeys = payload.options
    .map((o) => (o.image ? (o.text || '') + '|i:' + hashText(o.image) : (o.text || '')))
    .sort();
  const answerTexts = payload.options
    .filter((o) => payload.answer.includes(o.label))
    .map((o) => o.text)
    .sort();
  // 纯文字题的 key 与旧版完全一致，避免升级后整库缓存失效；有图片才加入图片指纹
  const keyData = {
    question: payload.question,
    type: payload.type,
    options: optionKeys,
    answer: answerTexts,
  };
  if (payload.questionImage) keyData.questionImage = hashText(payload.questionImage);
  return String(q.id) + ':' + hashText(JSON.stringify(keyData));
}

function readAiCache() {
  try {
    const v = JSON.parse(localStorage.getItem(AI_CACHE_KEY));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) { return {}; }
}

function writeAiCache(key, content, options) {
  try {
    const cache = readAiCache();
    cache[key] = {
      content,
      at: Date.now(),
      options: Array.isArray(options) ? options : [],
    };
    const keys = Object.keys(cache).sort((a, b) => (cache[b].at || 0) - (cache[a].at || 0));
    keys.slice(30).forEach((k) => delete cache[k]);
    localStorage.setItem(AI_CACHE_KEY, JSON.stringify(cache));
  } catch (e) {}
}

function openAiModal() {
  $('#ai-modal').classList.remove('hidden');
}

function closeAiModal() {
  $('#ai-modal').classList.add('hidden');
}

function setAiContent(text) {
  $('#ai-content').textContent = text;
}

async function askAi(force) {
  if (aiBusy) return;
  if (location.protocol === 'file:') {
    return toast('AI 功能需要部署到 Cloudflare Pages 后使用', false);
  }
  const it = currentItem();
  if (!it) return;
  const token = getAiToken();
  if (!token) return toast('请先在网址后加 #ai-unlock 解锁 AI', false);

  const q = it.q;
  const payload = buildAiPayload(it);
  const cacheKey = aiCacheKey(payload, q);
  if (payload.droppedImages > 0) {
    toast(`有 ${payload.droppedImages} 张图片过大或格式不支持，这次没有发给 AI`, false);
  }
  openAiModal();
  const noteBtn = $('#ai-to-note');
  noteBtn.classList.add('hidden');

  if (!force) {
    const cached = readAiCache()[cacheKey];
    if (cached && cached.content) {
      setAiContent(remapAiLabels(cached.content, cached.options, aiOptionKeys(it)));
      $('#ai-retry').classList.remove('hidden');
      noteBtn.classList.remove('hidden');
      return;
    }
  }

  aiBusy = true;
  let waited = 0;
  let waitingLabel = 'AI 正在思考…';
  const spinner = () => {
    $('#ai-content').innerHTML =
      '<span class="text-slate-400"><i class="fa fa-spinner fa-spin mr-1"></i>' +
      escapeHtml(waitingLabel) + '已 ' + waited + ' 秒</span>';
  };
  spinner();
  const spinnerTimer = setInterval(() => {
    if (latest) return;
    waited++;
    spinner();
  }, 1000);
  $('#ai-retry').classList.add('hidden');

  let latest = '';
  const showText = (text) => {
    latest = text;
    setAiContent(text);
    const box = $('#ai-content');
    box.scrollTop = box.scrollHeight;
  };
  // 读取流式响应：DeepSeek 每吐出几个字就刷新一次弹窗
  const readStream = async (res, onTick) => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    const handleLine = (line) => {
      if (!line.startsWith('data:')) return;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') return;
      let obj;
      try { obj = JSON.parse(raw); } catch (e) { return; }
      const delta = (obj.choices && obj.choices[0] && obj.choices[0].delta) || {};
      const piece = typeof delta.content === 'string' ? delta.content : '';
      if (piece) {
        full += piece;
        showText(full);
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onTick();
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, idx).replace(/\r$/, ''));
        buffer = buffer.slice(idx + 1);
      }
    }
    buffer += decoder.decode();
    buffer.split('\n').forEach((line) => handleLine(line.replace(/\r$/, '')));
    return full;
  };

  // 单次请求；空闲 90 秒没有新数据才超时（带图上传/模型思考可能较久），整体最多 140 秒
  const runOnce = async () => {
    const controller = new AbortController();
    let idleTimer = null;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), 90000);
    };
    const totalTimer = setTimeout(() => controller.abort(), 140000);
    resetIdle();
    try {
      const res = await fetch(AI_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) throw new Error('口令无效，请在网址后加 #ai-unlock 重新输入');
        throw new Error(data.error || 'AI 请求失败');
      }
      const ctype = res.headers.get('content-type') || '';
      if (ctype.includes('text/event-stream') && res.body) {
        const text = await readStream(res, resetIdle);
        if (!text.trim()) throw new Error('AI 没有返回内容，请重试');
        return text;
      }
      // 服务端未按流式返回时的兼容分支
      const data = await res.json().catch(() => ({}));
      if (!data.content) throw new Error('AI 没有返回内容，请重试');
      showText(data.content);
      return data.content;
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
    }
  };

  try {
    let content;
    try {
      content = await runOnce();
    } catch (e) {
      // 网络层断开（Failed to fetch）且还没显示任何内容时，自动重试一次
      if (e && e.name === 'TypeError' && !latest) {
        waitingLabel = '网络不稳定，正在自动重试…';
        waited = 0;
        spinner();
        content = await runOnce();
      } else {
        throw e;
      }
    }
    writeAiCache(cacheKey, content, aiOptionKeys(it));
    $('#ai-retry').classList.remove('hidden');
    noteBtn.classList.remove('hidden');
  } catch (e) {
    const msg = e && e.name === 'AbortError'
      ? 'AI 响应超时，可点「重新生成」再试'
      : e && e.name === 'TypeError'
        ? '网络连接中断（Failed to fetch），请检查网络后点「重新生成」'
        : '出错了：' + ((e && e.message) || '未知错误');
    setAiContent(latest ? latest + '\n\n（' + msg + '）' : msg);
    $('#ai-retry').classList.remove('hidden');
  } finally {
    clearInterval(spinnerTimer);
    aiBusy = false;
  }
}

$('#review-ai-btn').addEventListener('click', () => {
  clearReviewAutoTimer();
  askAi(false);
});
$('#ai-retry').addEventListener('click', () => askAi(true));
// 一键把当前显示的解析存成这道题的笔记（之后可在笔记里自行编辑）
let aiNoteSaving = false;
$('#ai-to-note').addEventListener('click', async () => {
  if (aiNoteSaving) return;
  const it = currentItem();
  if (!it) return toast('没有正在复习的题目', false);
  const text = ($('#ai-content').textContent || '').trim();
  if (!text) return toast('还没有可保存的解析', false);
  const q = it.q;
  if (!Array.isArray(q.notes)) q.notes = [];
  const note = { text, created_at: new Date().toISOString() };
  q.notes.push(note);
  aiNoteSaving = true;
  $('#ai-to-note').disabled = true;
  try {
    await dbPut(q);
    renderReviewNote(q);
    closeAiModal();
    toast('已存为笔记，点铅笔可编辑');
  } catch (e) {
    q.notes = q.notes.filter((n) => n !== note);
    toast('保存失败：' + e.message, false);
  } finally {
    aiNoteSaving = false;
    $('#ai-to-note').disabled = false;
  }
});
$('#ai-close').addEventListener('click', closeAiModal);
$('#ai-modal').addEventListener('click', (e) => {
  if (e.target === $('#ai-modal')) closeAiModal();
});

// ============ 初始化 ============
async function cleanupBlankQuestions() {
  const all = await dbGetAll();
  const bad = all.filter((q) => !isQuestionContentComplete(q));
  if (!bad.length) return;
  for (const q of bad) await dbDelete(q.id);
  toast(`已清理 ${bad.length} 道空白题目`);
}

async function init() {
  // 尽量让浏览器把 IndexedDB 当持久数据，降低系统自动清理导致错题丢失的概率
  if (navigator.storage && typeof navigator.storage.persist === 'function') {
    navigator.storage.persist().catch(() => {});
  }
  initAiUnlock();
  updateAutoNextUI();
  await cleanupBlankQuestions();
  setType('single');
  switchTab('review');
  refreshBadge();
  document.querySelectorAll('input[type="text"], textarea').forEach(updateClearBtn);
}
init().catch((e) => toast('初始化失败：' + e.message, false));
