// AI help with wording, through the user's own Claude API key. The only thing in this app that leaves the phone:
// when the user taps "AI로 다듬기", that one text (a memo, or a message draft with its place line) goes to
// api.anthropic.com and the answer comes back. No photos, no drawings, no project or company names.
const API = 'https://api.anthropic.com/v1/messages';
export const AI_MODEL = 'claude-haiku-5-5';

const KEEP = '숫자, 단위, 부재 기호(C1, RW2A, DS1 등), 그리드(X3~X4 / Y17~Y18), 층(B2F), 날짜, 사람·업체 이름, "_01" 같은 번호는 글자 그대로 둔다.';
const SYSTEM = {
  memo: '건설 현장 사진에 붙이는 메모를 다듬는다.\n' +
    '- 뜻과 사실은 그대로 두고, 입력에 없는 내용은 보태지 않는다.\n' +
    '- 오타와 띄어쓰기를 고치고, 짧고 분명한 현장 기록체(명사형, "~함", "~필요")로 쓴다.\n' +
    `- ${KEEP}\n` +
    '- 줄 수는 입력과 같게 한다. 이미 잘 쓰인 메모면 거의 그대로 둔다.\n' +
    '- 다듬은 메모만 출력한다. 설명, 따옴표, 머리말을 붙이지 않는다.',
  message: '건설 현장에서 사진과 함께 카카오톡으로 보낼 메시지를 쓴다. 입력은 위치(층 · 실 · 그리드 · 부재)와 메모다.\n' +
    '- 입력에 있는 사실만 쓰고 보태지 않는다.\n' +
    '- 위치가 있으면 첫 줄에 입력 그대로 둔다. 그 아래에 메모 내용을 공손한 한두 문장("…입니다", "…부탁드립니다")으로 쓴다.\n' +
    `- ${KEEP}\n` +
    '- 인사말, 이모지, 꾸밈말을 넣지 않는다. 메시지 본문만 출력한다.',
};
const ERR = {
  nokey: "AI 키가 없어요. 더보기 → 'AI 연결'에서 넣어 주세요",
  offline: '인터넷이 없어서 AI를 못 써요',
  network: 'AI 서버에 닿지 못했어요. 잠시 뒤에 다시 해 보세요',
  key: 'AI 키가 맞지 않아요. 더보기에서 다시 넣어 주세요',
  money: 'AI 계정에 남은 금액이 없거나 결제 등록이 안 됐어요',
  busy: 'AI가 바빠요. 잠시 뒤에 다시 해 보세요',
  empty: 'AI가 답을 주지 않았어요',
  other: 'AI가 답하지 못했어요',
};
export const aiErrorText = (e) => ERR[e && e.code] || ERR.other;
function fail(code, detail = '') { const e = new Error(detail || code); e.code = code; return e; }

// kind: 'memo' | 'message' | 'ping'; style: the user's own extra instruction
export async function askAI(key, kind, text, style = '') {
  if (!key) throw fail('nokey');
  if (navigator.onLine === false) throw fail('offline');
  const system = kind === 'ping' ? '"ok"라고만 답한다.' : SYSTEM[kind] + (style.trim() ? `\n- 추가 지시: ${style.trim()}` : '');
  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 2000, system, messages: [{ role: 'user', content: text }] }),
    });
  } catch (e) {
    throw fail('network');
  }
  if (!res.ok) {
    let msg = '';
    try { msg = ((await res.json()).error || {}).message || ''; } catch (e) { /* no body */ }
    if (res.status === 401 || res.status === 403) throw fail('key', msg);
    if (res.status === 402 || /credit|billing|balance/i.test(msg)) throw fail('money', msg);
    if (res.status === 429 || res.status >= 500) throw fail('busy', msg);
    throw fail('other', msg);
  }
  const data = await res.json();
  const out = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!out) throw fail('empty');
  return out;
}
