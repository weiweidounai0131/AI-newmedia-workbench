// M1 验证脚本：不触网、不耗 Key，用 stub fetch 拦截 openai SDK 发出的请求，
// 断言「按能力路由到正确 baseURL / 模型 / 请求体」以及 Key 加密往返正确。
// 注意：此脚本必须使用临时数据目录，绝不能覆盖用户已保存的真实 Key。
// 运行：npm run verify:m1
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type CapId = 'text' | 'visionImg' | 'visionVideo' | 'image';

interface Call {
  url: string;
  method: string;
  body: any;
}

function makeStub(onCall: (c: Call) => void): typeof globalThis.fetch {
  return async (url: string | URL | Request, init?: any) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    onCall({ url: String(url), method: init?.method ?? 'POST', body });
    const u = String(url);
    let fake: any;
    if (u.includes('/chat/completions')) {
      fake = { id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: '<fake-chat>' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    } else if (u.includes('/images/generations') || u.includes('/images/edits')) {
      fake = { created: 1, data: [{ b64_json: 'AAAA' }] };
    } else if (u.includes('/models')) {
      fake = { object: 'list', data: [{ id: 'gpt-image-2' }] };
    } else {
      fake = {};
    }
    return new Response(JSON.stringify(fake), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}  ${detail}`);
  }
}

async function run() {
  // services/settings 在导入时初始化目录；故必须先指定隔离目录再动态导入服务。
  const verifyDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmedia-workbench-verify-'));
  process.env.NEWMEDIA_DATA_DIR = verifyDataDir;
  const { settings } = await import('./services/settings.js');
  const { CAP_SLOTS, CAP_IDS } = await import('./services/caps.js');
  const { generateText, recognize, generateImage, verifyCap } = await import('./services/aiProxy.js');

  try {
    console.log('\n=== M1 验证：Key 加密往返 ===');
  // 为每个 keyId 写入假 Key 并读回，验证 AES 加密/解密（Node 降级路径）
  for (const cap of CAP_IDS) {
    const keyId = CAP_SLOTS[cap].keyId;
    const dummy = `sk-dummy-${cap}`;
    settings.setKey(keyId, dummy);
    const back = settings.getKey(keyId);
    check(`加密往返 ${keyId}`, back === dummy, `读回=${back}`);
  }
  // 明文不落盘：settings.json 中不应含 sk-dummy 明文
  const raw = fs.readFileSync(path.join(verifyDataDir, 'settings.json'), 'utf8');
  check('明文 Key 不落盘', !/sk-dummy-/.test(raw), 'settings.json 含明文');
  // 额外供应商的 Key 也必须走同一套加密存储。
  settings.setKey('sudocode', 'sk-dummy-sudocode');
  check('加密往返 sudocode', settings.getKey('sudocode') === 'sk-dummy-sudocode');

  console.log('\n=== M1 验证：四能力路由 + 请求体 ===');
  const calls: Partial<Record<CapId, Call>> = {};
  const stub = makeStub((c) => {
    // 仅记录最后一次调用（按 cap 区分需在外层绑定）
  });
  // 用闭包分别记录每个 cap 的调用
  async function capture(cap: CapId, fn: (f: typeof globalThis.fetch) => Promise<any>): Promise<Call> {
    let last: Call = { url: '', method: '', body: null };
    const s = makeStub((c) => (last = c));
    await fn(s);
    return last;
  }

  // text
  let c = await capture('text', (f) => generateText({ user: 'hello' }, f));
  check('text 路由到 DeepSeek', c.url === 'https://api.deepseek.com/chat/completions', c.url);
  check('text 模型=deepseek-chat', c.body?.model === 'deepseek-chat', c.body?.model);

  // text 供应商切换：切换到智谱后，模型自动落到 GLM-5.3-Flash，随后验证 GLM-4.5-Air。
  let err = settings.setProvider('text', 'zhipu');
  check('text 切换到智谱', !err && settings.providerId('text') === 'zhipu', err ?? '');
  c = await capture('text', (f) => generateText({ user: 'hello' }, f));
  check('text 智谱路由', c.url === 'https://open.bigmodel.cn/api/paas/v4/chat/completions', c.url);
  check('text 智谱默认模型=glm-5.3-flash', c.body?.model === 'glm-5.3-flash', c.body?.model);
  err = settings.setSupplier('text', 'glm-4.5-air');
  check('text 选择 GLM-4.5-Air', !err, err ?? '');
  c = await capture('text', (f) => generateText({ user: 'hello' }, f));
  check('text 智谱模型=glm-4.5-air', c.body?.model === 'glm-4.5-air', c.body?.model);
  settings.setProvider('text', 'deepseek');

  // visionImg
  c = await capture('visionImg', (f) => recognize({ cap: 'visionImg', parts: [{ type: 'image', data: 'xx', mime: 'image/jpeg' }] }, f));
  check('visionImg 路由到智谱', c.url === 'https://open.bigmodel.cn/api/paas/v4/chat/completions', c.url);
  const imgPart = c.body?.messages?.[0]?.content?.find((p: any) => p.type === 'image_url');
  check('visionImg 含 image_url part', !!imgPart, JSON.stringify(c.body?.messages?.[0]?.content));

  // visionVideo
  c = await capture('visionVideo', (f) => recognize({ cap: 'visionVideo', parts: [{ type: 'video', data: 'xx', mime: 'video/mp4' }] }, f));
  check('visionVideo 路由到通义', c.url === 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', c.url);
  const vidPart = c.body?.messages?.[0]?.content?.find((p: any) => p.type === 'video_url');
  check('visionVideo 含 video_url part', !!vidPart, JSON.stringify(c.body?.messages?.[0]?.content));

  // image（无参考图 → generations）
  c = await capture('image', (f) => generateImage({ prompt: 'a poster' }, f));
  check('image 经 AIHubMix 主网关中转', c.url === 'https://aihubmix.com/v1/images/generations', c.url);
  check('image 模型=gpt-image-2', c.body?.model === 'gpt-image-2', c.body?.model);
  check('image 请求模型', c.body?.model === 'gpt-image-2', c.body?.model);
  check('image 固定 n=1', c.body?.n === 1, String(c.body?.n));

  // image（有参考图 → edits）
  c = await capture('image', (f) => generateImage({ prompt: 'a poster', refImgs: [{ type: 'image', data: 'yy', mime: 'image/png' }] }, f));
  check('image 有参考图走 /images/edits', c.url === 'https://aihubmix.com/v1/images/edits', c.url);

  // image 供应商切换：SudoCode 使用独立 Key 与网关，切回 AIHubMix 后不影响默认链路。
  err = settings.setProvider('image', 'sudocode');
  check('image 切换到 SudoCode', !err && settings.providerId('image') === 'sudocode', err ?? '');
  c = await capture('image', (f) => generateImage({ prompt: 'a poster' }, f));
  check('image 经 SudoCode 网关', c.url === 'https://api.sudocode.chat/v1/images/generations', c.url);
  check('image SudoCode 模型=gpt-image-2', c.body?.model === 'gpt-image-2', c.body?.model);
  settings.setProvider('image', 'aihubmix');

  console.log('\n=== M1 验证：dry-run 验证（verifyCap） ===');
  for (const cap of CAP_IDS) {
    const r = await verifyCap(cap, stub);
    check(`verifyCap(${cap}) ok`, r.ok === true, r.error ?? '');
  }

    console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    fs.rmSync(verifyDataDir, { recursive: true, force: true });
  }
}

run();
