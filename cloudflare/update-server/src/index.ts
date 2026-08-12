export interface Env {
  UPDATES: R2Bucket;
}

/**
 * 只读更新分发端：electron-updater 只会请求 latest*.yml、安装包和 blockmap。
 * 不暴露对象列表与写入接口，R2 的上传权限始终只保存在 GitHub Actions Secrets。
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (!key || key.includes('..') || key.includes('\\')) return new Response('Not Found', { status: 404 });

    const object = await env.UPDATES.get(key);
    if (!object) return new Response('Not Found', { status: 404 });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('ETag', object.httpEtag);
    headers.set('X-Content-Type-Options', 'nosniff');
    // latest*.yml 必须及时刷新；带版本的安装包与差分文件可长期缓存。
    headers.set('Cache-Control', key.endsWith('.yml') ? 'no-store' : 'public, max-age=31536000, immutable');
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  },
};
