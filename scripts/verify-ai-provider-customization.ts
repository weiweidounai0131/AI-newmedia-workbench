import assert from 'node:assert/strict';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { HttpsProxyAgent } from 'https-proxy-agent';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmedia-ai-provider-verify-'));
const fakeHome = path.join(tempRoot, 'home');
const fakeData = path.join(tempRoot, '.data');
fs.mkdirSync(fakeHome, { recursive: true });
fs.mkdirSync(fakeData, { recursive: true });

// Isolate the singleton before importing any product settings or AI service module.
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.NEWMEDIA_DATA_DIR = fakeData;
process.env.HTTPS_PROXY = '';
process.env.https_proxy = '';
process.env.ALL_PROXY = '';
process.env.all_proxy = '';
process.env.DEBUG = 'true';

const legacySettings = {
  keys: { deepseek: 'synthetic-invalid-cipher-placeholder' },
  providers: { text: 'deepseek', visionImg: 'zhipu', visionVideo: 'qwen', image: 'aihubmix' },
  suppliers: { text: 'deepseek-reasoner', visionImg: 'glm-4v-flash', visionVideo: 'qwen-vl-max', image: 'gpt-image-2' },
  verified: { text: 'deepseek-reasoner' },
  rootDir: path.join(tempRoot, 'library'),
  xhsDownloadDir: path.join(tempRoot, 'xhs'),
};
fs.writeFileSync(path.join(fakeData, 'settings.json'), JSON.stringify(legacySettings, null, 2), { mode: 0o600 });

type CapturedRequest = { method: string; path: string; headers: http.IncomingHttpHeaders; body: Buffer };
const upstreamRequests: CapturedRequest[] = [];
let upstreamSlowDelay = 350;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const upstream = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const route = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  const captured = { method: req.method || '', path: route, headers: req.headers, body };
  upstreamRequests.push(captured);
  const bearer = typeof req.headers.authorization === 'string' ? req.headers.authorization.replace(/^Bearer\s+/i, '') : '';
  const key = (req.headers['x-api-key'] as string | undefined) || bearer;

  if (route.includes('/slow/') && route.endsWith('/models')) {
    setTimeout(() => sendJson(res, 200, { data: [{ id: 'slow-model' }] }), upstreamSlowDelay);
    return;
  }
  if (route.endsWith('/models')) {
    if (route.includes('/not-found/')) return sendJson(res, 404, { error: { message: `echo body ${key}` } });
    if (key === 'synthetic-401-key') return sendJson(res, 401, { error: { message: `echo key ${key}` } });
    if (route.includes('/empty/')) return sendJson(res, 200, { data: [] });
    return sendJson(res, 200, { data: [{ id: 'provider-model-alpha' }, { id: 'provider-model-beta' }] });
  }
  if (route.endsWith('/chat/completions')) {
    if (key === 'synthetic-chat-error-key') {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end(`echo secret ${key}`);
      return;
    }
    return sendJson(res, 200, { choices: [{ message: { content: 'chat synthetic reply' } }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } });
  }
  if (route.endsWith('/responses')) {
    return sendJson(res, 200, { output_text: 'responses synthetic reply', usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 } });
  }
  if (route.endsWith('/messages')) {
    return sendJson(res, 200, { content: [{ type: 'text', text: 'anthropic synthetic reply' }], usage: { input_tokens: 2, output_tokens: 3 } });
  }
  if (route.endsWith('/images/generations') || route.endsWith('/images/edits')) {
    return sendJson(res, 200, { data: [{ b64_json: 'c3ludGhldGljLWltYWdl' }] });
  }
  return sendJson(res, 404, { error: { message: 'synthetic route missing' } });
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('synthetic server did not bind a TCP port');
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function bodyOf(request: CapturedRequest): any {
  const text = request.body.toString('utf8');
  try { return JSON.parse(text); } catch { return text; }
}

function captureAt(method: string, suffix: string): CapturedRequest {
  const item = [...upstreamRequests].reverse().find((request) => request.method === method && request.path.endsWith(suffix));
  assert.ok(item, `expected synthetic request ${method} *${suffix}`);
  return item;
}

async function run(): Promise<void> {
  const { settings, validateProviderBaseURL } = await import('../electron/main/server/services/settings.js');
  const { settingsRouter } = await import('../electron/main/server/routes/settings.js');
  const ai = await import('../electron/main/server/services/aiProxy.js');
  const capModule = await import('../electron/main/server/services/caps.js');

  assert.equal(settings.providerId('text'), 'deepseek', 'legacy provider assignment remains readable');
  assert.equal(settings.currentModel('text'), 'deepseek-reasoner', 'legacy model assignment remains readable');
  assert.equal(settings.rootDir, legacySettings.rootDir);
  assert.equal(settings.xhsDownloadDir, legacySettings.xhsDownloadDir);
  assert.equal(settings.getKey('deepseek'), null, 'synthetic invalid legacy cipher fails closed without blocking load');
  assert.equal(validateProviderBaseURL('http://127.0.0.1:9000/gateway/v1'), 'http://127.0.0.1:9000/gateway/v1');
  for (const badURL of ['file:///tmp/a', 'http://user:pass@127.0.0.1/v1', 'http://127.0.0.1/v1#', 'http://127.0.0.1/v1?token=synthetic']) {
    assert.throws(() => validateProviderBaseURL(badURL), undefined, `reject unsafe base URL ${badURL.split(':')[0]}`);
  }
  assert.equal(capModule.providerSupportsCapability({ protocol: 'openai-responses' }, 'image'), false);
  assert.equal(capModule.providerSupportsCapability({ protocol: 'anthropic-messages' }, 'visionVideo'), false);

  const port = await listen(upstream);
  const baseURL = `http://127.0.0.1:${port}/tenant/v1`;
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/settings', settingsRouter);
  const apiServer = http.createServer(app);
  const apiPort = await listen(apiServer);
  const apiBase = `http://127.0.0.1:${apiPort}`;

  try {
    const initialSettings = await fetch(`${apiBase}/api/settings`).then((r) => r.json()) as any;
    assert.ok(initialSettings.providers.some((item: any) => item.id === 'deepseek'));
    assert.doesNotMatch(JSON.stringify(initialSettings), /synthetic-invalid-cipher-placeholder/);

    if (process.argv.includes('--cap-config-only')) {
      const initialText = initialSettings.caps.find((item: any) => item.cap === 'text');
      assert.ok(initialText.configurations.some((item: any) => item.providerId === 'deepseek' && item.model === 'deepseek-reasoner' && item.active), 'legacy active provider/model is visible without migration');
      assert.equal(JSON.parse(fs.readFileSync(path.join(fakeData, 'settings.json'), 'utf8')).capabilityConfigs, undefined, 'opening old settings does not eagerly rewrite a capability index');

      const shared = settings.saveProvider({
        label: 'Legacy Shared Config', baseURL, protocol: 'openai-chat-completions', apiKey: 'synthetic-shared-scope-key',
        models: [{ id: 'shared-legacy-model', capabilities: ['text', 'visionImg'] }],
      });
      assert.equal(await settings.setCapability('text', shared.id, 'shared-legacy-model'), null);
      assert.equal(await settings.setCapability('visionImg', shared.id, 'shared-legacy-model'), null);

      const clonedResponse = await fetch(`${apiBase}/api/settings/providers/save`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cap: 'text', mode: 'edit', id: shared.id, sourceProviderId: shared.id, sourceModel: 'shared-legacy-model',
          label: 'Text Scoped Clone', baseURL: `${baseURL}/text-copy`, protocol: 'openai-chat-completions', apiKey: '',
          models: [{ id: 'text-scoped-model', capabilities: ['text'] }],
        }),
      });
      assert.equal(clonedResponse.status, 200);
      const clonedResult = await clonedResponse.json() as any;
      const textCloneId = clonedResult.providerId as string;
      assert.notEqual(textCloneId, shared.id, 'editing a legacy cross-cap config clones it for this capability');
      assert.equal(settings.providerId('text'), textCloneId, 'editing the active legacy config atomically switches only its own capability');
      assert.equal(settings.currentModel('text'), 'text-scoped-model');
      assert.equal(settings.providerId('visionImg'), shared.id, 'the other capability keeps its legacy provider');
      assert.equal(settings.currentModel('visionImg'), 'shared-legacy-model');
      assert.equal(settings.getKey(`provider:${textCloneId}`), 'synthetic-shared-scope-key', 'the clone receives its Key internally without exposing it');
      assert.throws(() => settings.saveProvider({
        id: textCloneId, label: 'Scope bypass attempt', baseURL, protocol: 'openai-chat-completions',
        models: [{ id: 'scope-bypass-model', capabilities: ['text', 'visionImg'] }],
      }), /所属类型/, 'the legacy provider endpoint cannot clear or broaden a capability scope');
      assert.equal(settings.providerById(textCloneId)?.scopeCap, 'text');
      assert.notEqual(await settings.setCapability('visionImg', textCloneId, 'text-scoped-model'), null, 'another capability cannot select a scoped provider');
      const internalSettings = settings as any;
      internalSettings.data.providers.visionImg = textCloneId;
      internalSettings.data.suppliers.visionImg = 'text-scoped-model';
      assert.throws(() => settings.resolveRequest('visionImg'), /图文识别/, 'request resolution fails closed if persisted selection crosses scope');
      assert.equal(await settings.setCapability('visionImg', shared.id, 'shared-legacy-model'), null, 'the previous capability assignment can be restored');
      let stored = JSON.parse(fs.readFileSync(path.join(fakeData, 'settings.json'), 'utf8'));
      assert.ok(stored.capabilityConfigs.text.some((item: any) => item.providerId === textCloneId && item.model === 'text-scoped-model'));
      const scopedSummary = await fetch(`${apiBase}/api/settings`).then((r) => r.json()) as any;
      assert.ok(scopedSummary.caps.find((item: any) => item.cap === 'visionImg').configurations.some((item: any) => item.providerId === shared.id && item.model === 'shared-legacy-model'), 'the unmaterialized legacy index derives the untouched capability config');
      assert.equal(stored.capabilityConfigs.visionImg, undefined, 'editing one capability does not rewrite the other capability index');

      const currentDelete = await fetch(`${apiBase}/api/settings/providers/${encodeURIComponent(textCloneId)}/config?cap=text&model=text-scoped-model`, { method: 'DELETE' });
      assert.equal(currentDelete.status, 409, 'the current provider/model pair cannot be removed');

      const alternate = settings.saveProvider({
        cap: 'text', mode: 'create', sourceProviderId: textCloneId, sourceModel: 'text-scoped-model', label: 'Text Alternate', baseURL, protocol: 'openai-chat-completions',
        models: [{ id: 'text-alternate-model', capabilities: ['text'] }],
      });
      assert.equal(settings.providerId('text'), textCloneId, 'adding a config does not silently enable it');
      const radioSwitch = await fetch(`${apiBase}/api/settings/capability`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cap: 'text', providerId: alternate.id, model: 'text-alternate-model' }),
      });
      assert.equal(radioSwitch.status, 200);
      stored = JSON.parse(fs.readFileSync(path.join(fakeData, 'settings.json'), 'utf8'));
      assert.equal(stored.providers.text, alternate.id);
      assert.equal(stored.suppliers.text, 'text-alternate-model');
      const persistedSummary = await fetch(`${apiBase}/api/settings`).then((r) => r.json()) as any;
      assert.ok(persistedSummary.caps.find((item: any) => item.cap === 'text').configurations.some((item: any) => item.providerId === alternate.id && item.model === 'text-alternate-model' && item.active));
      const alternateDeleteWhileCurrent = await fetch(`${apiBase}/api/settings/providers/${encodeURIComponent(alternate.id)}/config?cap=text&model=text-alternate-model`, { method: 'DELETE' });
      assert.equal(alternateDeleteWhileCurrent.status, 409);

      assert.equal(await settings.setCapability('text', 'deepseek', 'deepseek-reasoner'), null);
      const alternateDelete = await fetch(`${apiBase}/api/settings/providers/${encodeURIComponent(alternate.id)}/config?cap=text&model=text-alternate-model`, { method: 'DELETE' });
      assert.equal(alternateDelete.status, 200);
      assert.equal(settings.providerById(alternate.id), undefined);
      assert.equal(settings.getKey(`provider:${textCloneId}`), 'synthetic-shared-scope-key', 'removing an unrelated config keeps the other scoped Key');
      assert.equal(settings.providerId('visionImg'), shared.id);
      const sharedDeleteWhileCurrent = await fetch(`${apiBase}/api/settings/providers/${encodeURIComponent(shared.id)}/config?cap=visionImg&model=shared-legacy-model`, { method: 'DELETE' });
      assert.equal(sharedDeleteWhileCurrent.status, 409);
      assert.equal(await settings.setCapability('visionImg', 'zhipu', 'glm-4v-flash'), null);
      const sharedDelete = await fetch(`${apiBase}/api/settings/providers/${encodeURIComponent(shared.id)}/config?cap=visionImg&model=shared-legacy-model`, { method: 'DELETE' });
      assert.equal(sharedDelete.status, 200);
      assert.equal(settings.providerById(shared.id), undefined, 'an unreferenced custom provider is cleaned up after its last cap config is removed');
      assert.equal(settings.getKey(`provider:${shared.id}`), null, 'the original Key is removed only after all capability references are gone');
      assert.equal(settings.providerId('text'), 'deepseek');
      assert.equal(settings.currentModel('text'), 'deepseek-reasoner');
      assert.equal(settings.providerId('visionImg'), 'zhipu');
      assert.equal(settings.currentModel('visionImg'), 'glm-4v-flash');
      console.log('AI capability model config synthetic verifier: passed');
      return;
    }

    const createResponse = await fetch(`${apiBase}/api/settings/providers/save`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'Synthetic Chat Gateway', baseURL, protocol: 'openai-chat-completions', apiKey: 'custom-chat-key-no-prefix',
        models: [{ id: 'chat-model-unusual-id', capabilities: ['text', 'visionImg', 'visionVideo', 'image'] }],
      }),
    });
    assert.equal(createResponse.status, 200);
    const created = await createResponse.json() as any;
    const chatProviderId = created.providerId as string;
    assert.match(chatProviderId, /^custom-/);
    assert.doesNotMatch(JSON.stringify(created), /custom-chat-key-no-prefix/);
    assert.equal(settings.getKey(`provider:${chatProviderId}`), 'custom-chat-key-no-prefix');
    const settingsJSON = fs.readFileSync(path.join(fakeData, 'settings.json'), 'utf8');
    assert.doesNotMatch(settingsJSON, /custom-chat-key-no-prefix/);
    assert.ok(JSON.parse(settingsJSON).keys[`provider:${chatProviderId}`], 'custom Key is encrypted at rest under one provider keyId');

    const listViaRoute = await fetch(`${apiBase}/api/settings/providers/models`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: chatProviderId, baseURL, protocol: 'openai-chat-completions' }),
    });
    assert.equal(listViaRoute.status, 200);
    const discovered = await listViaRoute.json() as any;
    assert.deepEqual(discovered.models, ['provider-model-alpha', 'provider-model-beta']);
    assert.ok(upstreamRequests.some((item) => item.method === 'GET' && item.path === '/tenant/v1/models'));
    assert.equal(captureAt('GET', '/models').headers.authorization, 'Bearer custom-chat-key-no-prefix');

    const keyUpdate = await fetch(`${apiBase}/api/settings/providers/key`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: chatProviderId, key: 'custom-chat-key-updated' }),
    }).then((r) => r.json()) as any;
    assert.equal(settings.getKey(`provider:${chatProviderId}`), 'custom-chat-key-updated');
    assert.doesNotMatch(JSON.stringify(keyUpdate), /custom-chat-key-updated/);

    const capabilityResponse = await fetch(`${apiBase}/api/settings/capability`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cap: 'text', providerId: chatProviderId, model: 'chat-model-unusual-id' }),
    });
    assert.equal(capabilityResponse.status, 200);
    await ai.fetchProviderModels({ baseURL, protocol: 'openai-responses', apiKey: 'synthetic-responses-list-key' });
    await ai.fetchProviderModels({ baseURL, protocol: 'anthropic-messages', apiKey: 'synthetic-anthropic-list-key' });
    assert.equal(captureAt('GET', '/models').headers.authorization, undefined, 'Anthropic removes SDK Bearer auth');
    assert.equal(captureAt('GET', '/models').headers['x-api-key'], 'synthetic-anthropic-list-key');

    const deleteGuard = await fetch(`${apiBase}/api/settings/providers/${encodeURIComponent(chatProviderId)}`, { method: 'DELETE' });
    assert.equal(deleteGuard.status, 409);
    assert.match((await deleteGuard.json() as any).error, /文字改写/);
    assert.equal(settings.saveProvider({ id: chatProviderId, label: 'Edited Chat Gateway', baseURL, protocol: 'openai-chat-completions', apiKey: '', models: [{ id: 'chat-model-unusual-id', capabilities: ['text', 'visionImg', 'visionVideo', 'image'] }] }).label, 'Edited Chat Gateway');
    assert.equal(settings.getKey(`provider:${chatProviderId}`), 'custom-chat-key-updated', 'blank edit preserves the existing Key');

    await settings.setProviderKey('deepseek', 'sk-synthetic-builtin-key');
    const chatResult = await ai.generateText({ user: 'synthetic user text' });
    assert.equal(chatResult.text, 'chat synthetic reply');
    let chatRequest = captureAt('POST', '/chat/completions');
    let chatBody = bodyOf(chatRequest);
    assert.equal(chatRequest.path, '/tenant/v1/chat/completions', 'provider base path is preserved');
    assert.equal(chatBody.model, 'chat-model-unusual-id');
    assert.equal(chatBody.messages.at(-1).content, 'synthetic user text');

    const imageData = Buffer.from('synthetic-pixel').toString('base64');
    assert.equal(await settings.setCapability('visionImg', chatProviderId, 'chat-model-unusual-id'), null);
    const chatVision = await ai.recognize({ cap: 'visionImg', parts: [{ type: 'image', data: imageData, mime: 'image/png' }], user: 'read synthetic image' });
    assert.equal(chatVision.text, 'chat synthetic reply');
    chatRequest = captureAt('POST', '/chat/completions');
    chatBody = bodyOf(chatRequest);
    assert.ok(chatBody.messages[0].content.some((part: any) => part.type === 'image_url' && part.image_url.url === `data:image/png;base64,${imageData}`));

    const responseProvider = settings.saveProvider({
      label: 'Synthetic Responses Gateway', baseURL, protocol: 'openai-responses', apiKey: 'synthetic-responses-key',
      models: [{ id: 'responses-model-without-prefix', capabilities: ['text', 'visionImg'] }],
    });
    assert.equal(await settings.setCapability('text', responseProvider.id, 'responses-model-without-prefix'), null);
    const responsesResult = await ai.generateText({ system: 'system instruction', user: 'hello responses' });
    assert.equal(responsesResult.text, 'responses synthetic reply');
    const responsesRequest = captureAt('POST', '/responses');
    const responsesBody = bodyOf(responsesRequest);
    assert.equal(responsesBody.instructions, 'system instruction');
    assert.equal(responsesBody.input, 'hello responses');
    assert.equal(await settings.setCapability('visionImg', responseProvider.id, 'responses-model-without-prefix'), null);
    const responsesVision = await ai.recognize({ cap: 'visionImg', parts: [{ type: 'image', data: imageData, mime: 'image/png' }], user: 'read response image' });
    assert.equal(responsesVision.text, 'responses synthetic reply');
    const responsesVisionBody = bodyOf(captureAt('POST', '/responses'));
    assert.ok(responsesVisionBody.input[0].content.some((part: any) => part.type === 'input_image' && part.image_url === `data:image/png;base64,${imageData}`));
    assert.notEqual(await settings.setCapability('image', responseProvider.id, 'responses-model-without-prefix'), null, 'Responses cannot be assigned to OpenAI Images');
    assert.equal((await ai.verifyCap('text')).ok, true);
    assert.equal(bodyOf(captureAt('POST', '/responses')).max_output_tokens, 16, 'Responses verify uses schema minimum');
    assert.equal(await settings.saveProvider({ id: responseProvider.id, label: 'Synthetic Responses Gateway Edited', baseURL, protocol: 'openai-responses', apiKey: '', models: [{ id: 'responses-model-without-prefix', capabilities: ['text', 'visionImg'] }] }).label, 'Synthetic Responses Gateway Edited');
    assert.equal(settings.isVerified('text'), false, 'provider revision invalidates verified state');

    const anthropicProvider = settings.saveProvider({
      label: 'Synthetic Anthropic Gateway', baseURL, protocol: 'anthropic-messages', apiKey: 'synthetic-anthropic-key',
      models: [{ id: 'anthropic-model-manual', capabilities: ['text', 'visionImg'] }],
    });
    assert.equal(await settings.setCapability('text', anthropicProvider.id, 'anthropic-model-manual'), null);
    assert.equal((await ai.generateText({ system: 'system', user: 'hello anthropic' })).text, 'anthropic synthetic reply');
    const anthropicTextReq = captureAt('POST', '/messages');
    const anthropicTextBody = bodyOf(anthropicTextReq);
    assert.equal(anthropicTextBody.max_tokens, 4096);
    assert.equal(anthropicTextBody.system, 'system');
    assert.equal(anthropicTextReq.headers.authorization, undefined);
    assert.equal(anthropicTextReq.headers['x-api-key'], 'synthetic-anthropic-key');
    assert.equal(await settings.setCapability('visionImg', anthropicProvider.id, 'anthropic-model-manual'), null);
    const anthropicVision = await ai.recognize({ cap: 'visionImg', parts: [{ type: 'image', data: imageData, mime: 'image/png' }], user: 'read anthropic image' });
    assert.equal(anthropicVision.text, 'anthropic synthetic reply');
    const anthropicVisionBody = bodyOf(captureAt('POST', '/messages'));
    assert.deepEqual(anthropicVisionBody.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } });
    assert.notEqual(await settings.setCapability('visionVideo', anthropicProvider.id, 'anthropic-model-manual'), null);

    assert.equal(await settings.setCapability('image', chatProviderId, 'chat-model-unusual-id'), null);
    assert.equal((await ai.verifyCap('image')).ok, true, 'image verify is auth/model-list only');
    assert.equal(upstreamRequests.some((item) => item.path.endsWith('/images/generations')), false, 'verify does not generate images');
    assert.equal((await ai.generateImage({ prompt: 'synthetic generation', size: '1024x1024' })).images[0].b64, 'c3ludGhldGljLWltYWdl');
    assert.equal(captureAt('POST', '/images/generations').path, '/tenant/v1/images/generations');
    assert.equal((await ai.generateImage({ prompt: 'synthetic edit', refImgs: [{ type: 'image', data: imageData, mime: 'image/png' }] })).usedEdit, true);
    assert.equal(captureAt('POST', '/images/edits').path, '/tenant/v1/images/edits');

    assert.equal(await settings.setCapability('visionVideo', 'qwen', 'qwen-vl-max'), null);
    assert.equal(settings.setKeyForCap('visionVideo', 'sk-synthetic-qwen-key'), null);
    const videoData = Buffer.from('synthetic-video').toString('base64');
    let qwenBody: any;
    await ai.recognize({ cap: 'visionVideo', parts: [{ type: 'video', data: videoData, mime: 'video/mp4' }] }, async (_input, init) => {
      qwenBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'synthetic Qwen reply' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    assert.ok(qwenBody.messages[0].content.some((part: any) => part.type === 'video_url' && part.video_url.url === `data:video/mp4;base64,${videoData}`));

    const authFail = await ai.fetchProviderModels({ baseURL: `http://127.0.0.1:${port}/auth401/v1`, protocol: 'openai-chat-completions', apiKey: 'synthetic-401-key' }).then(() => null, (error: any) => error);
    assert.equal(authFail.code, 'invalid_base');
    assert.match(authFail.message, /401/);
    assert.doesNotMatch(authFail.message, /synthetic-401-key/);
    assert.equal(upstreamRequests.filter((item) => item.path.includes('/auth401/') && item.path.endsWith('/models')).length, 1, 'model discovery does not retry');
    const notFound = await ai.fetchProviderModels({ baseURL: `http://127.0.0.1:${port}/not-found/v1`, protocol: 'openai-chat-completions', apiKey: 'synthetic-404-key' }).then(() => null, (error: any) => error);
    assert.equal(notFound.status, 404);
    assert.match(notFound.message, /404/);
    const empty = await ai.fetchProviderModels({ baseURL: `http://127.0.0.1:${port}/empty/v1`, protocol: 'openai-chat-completions', apiKey: 'synthetic-empty-key' }).then(() => null, (error: any) => error);
    assert.equal(empty.code, 'empty_model_list');
    const abortController = new AbortController();
    const cancelledModels = ai.fetchProviderModels({ baseURL: `http://127.0.0.1:${port}/slow/v1`, protocol: 'openai-chat-completions', apiKey: 'synthetic-slow-key' }, abortController.signal);
    setTimeout(() => abortController.abort(), 25);
    const cancelled = await cancelledModels.then(() => null, (error: any) => error);
    assert.equal(cancelled.code, 'timeout', 'model list supports cancellation and returns a safe timeout status');
    assert.equal(upstreamRequests.filter((item) => item.path.includes('/slow/') && item.path.endsWith('/models')).length, 1, 'cancelled model list is not retried');

    const proxyValue = 'http://127.0.0.1:9999';
    process.env.HTTPS_PROXY = proxyValue;
    const proxy = ai.proxyAgent();
    process.env.HTTPS_PROXY = '';
    assert.ok(proxy instanceof HttpsProxyAgent, 'SDK clients retain the configured proxy agent path');
    proxy?.destroy();

    // DEBUG is synthetically enabled. Exercise two overlapping SDK calls: one throws after an echoed body,
    // one succeeds; SDK logs stay suppressed while ordinary application logging still passes through.
    const capturedLogs: string[] = [];
    const consoleBefore = console.log;
    console.log = (...args: unknown[]) => { capturedLogs.push(args.map((arg) => String(arg)).join(' ')); };
    const logSecret = 'synthetic-echo-secret-never-log';
    let failedStarted!: () => void;
    let goodStarted!: () => void;
    let releaseGood!: (value: Response) => void;
    const failedFetchStarted = new Promise<void>((resolve) => { failedStarted = resolve; });
    const goodFetchStarted = new Promise<void>((resolve) => { goodStarted = resolve; });
    const failedFetch: typeof fetch = async () => {
      failedStarted();
      return new Response(`upstream echoed ${logSecret}`, { status: 401, headers: { 'content-type': 'text/plain' } });
    };
    const goodFetch: typeof fetch = async () => {
      goodStarted();
      return new Promise<Response>((resolve) => { releaseGood = resolve; });
    };
    try {
      const failVerify = ai.verifyCap('text', failedFetch);
      const goodVerify = ai.verifyCap('visionImg', goodFetch);
      await Promise.all([failedFetchStarted, goodFetchStarted]);
      console.log('synthetic non-SDK log preserved');
      releaseGood(new Response(JSON.stringify({ output_text: 'ok', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
      const [failedResult, goodResult] = await Promise.all([failVerify, goodVerify]);
      assert.equal(failedResult.ok, false);
      assert.equal(goodResult.ok, true);
      console.log('synthetic after-restore log preserved');
    } finally {
      console.log = consoleBefore;
    }
    assert.ok(capturedLogs.some((line) => line.includes('synthetic non-SDK log preserved')));
    assert.ok(capturedLogs.some((line) => line.includes('synthetic after-restore log preserved')));
    assert.doesNotMatch(capturedLogs.join('\n'), /OpenAI:DEBUG:|synthetic-echo-secret-never-log|upstream echoed/);
    const audit = fs.readFileSync(path.join(fakeData, 'ai-audit.jsonl'), 'utf8');
    assert.doesNotMatch(audit, /synthetic-echo-secret-never-log|upstream echoed/);

    // A provider key change during a request must keep the in-flight verification from marking the new key valid.
    assert.equal(await settings.setCapability('text', responseProvider.id, 'responses-model-without-prefix'), null);
    let staleStarted!: () => void;
    let resolveStale!: (value: Response) => void;
    const staleFetchStarted = new Promise<void>((resolve) => { staleStarted = resolve; });
    const staleFetch: typeof fetch = async () => {
      staleStarted();
      return new Promise<Response>((resolve) => { resolveStale = resolve; });
    };
    const staleCheck = ai.verifyCap('text', staleFetch);
    await staleFetchStarted;
    assert.equal(settings.setProviderKey(responseProvider.id, 'synthetic-new-key-during-verify'), null);
    resolveStale(new Response(JSON.stringify({ output_text: 'ok', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const staleResult = await staleCheck;
    assert.equal(staleResult.ok, false);
    assert.match(staleResult.error || '', /配置已改变/);
    assert.equal(settings.isVerified('text'), false);

    const deleteCandidate = settings.saveProvider({ label: 'Delete candidate', baseURL, protocol: 'openai-chat-completions', models: [{ id: 'unused-model', capabilities: ['text'] }] });
    await fetch(`${apiBase}/api/settings/providers/${encodeURIComponent(deleteCandidate.id)}`, { method: 'DELETE' }).then(async (r) => assert.equal(r.status, 200));
    assert.equal(settings.providerById(deleteCandidate.id), undefined);

    const finalSummary = await fetch(`${apiBase}/api/settings`).then((r) => r.json());
    assert.doesNotMatch(JSON.stringify(finalSummary), /custom-chat-key-updated|synthetic-new-key-during-verify|synthetic-anthropic-key/);
    const finalFile = fs.readFileSync(path.join(fakeData, 'settings.json'), 'utf8');
    assert.doesNotMatch(finalFile, /custom-chat-key-updated|synthetic-new-key-during-verify|synthetic-anthropic-key/);
    console.log('AI provider customization synthetic verifier: passed');
  } finally {
    await close(apiServer);
    await close(upstream);
  }
}

try {
  await run();
} finally {
  process.env.DEBUG = '';
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) process.env[key] = '';
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
