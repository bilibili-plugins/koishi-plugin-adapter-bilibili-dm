import { Context } from 'koishi';
import { } from '@koishijs/plugin-server';
import { Readable } from 'node:stream';

const MEDIA_PROXY_ROUTE = '/adapter/bilibili-dm/proxy/avatar';
const MEDIA_PROXY_REFERER = 'https://www.bilibili.com/';
const MEDIA_PROXY_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const registeredContexts = new WeakSet<Context>();

function isValidUrl(url: string): boolean
{
  try
  {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch
  {
    return false;
  }
}

function getServerBaseUrl(ctx: Context): string
{
  const server = ctx.server as {
    config?: { selfUrl?: string; };
    host?: string;
    port?: number;
  };
  const selfUrl = server.config?.selfUrl?.trim();
  if (selfUrl) return selfUrl;

  const host = server.host?.trim();
  const port = server.port || 5140;
  const normalizedHost = !host || host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  return `http://${normalizedHost}:${port}`;
}

export function getBilibiliAvatarProxyUrl(ctx: Context, url: string): string
{
  if (!isValidUrl(url)) return url;

  const query = new URLSearchParams({ url });
  return new URL(`${MEDIA_PROXY_ROUTE}?${query.toString()}`, getServerBaseUrl(ctx)).toString();
}

export function registerBilibiliMediaProxyRoute(ctx: Context): void
{
  if (registeredContexts.has(ctx)) return;
  registeredContexts.add(ctx);

  ctx.server.get(MEDIA_PROXY_ROUTE, async (koaCtx) =>
  {
    const rawUrl = typeof koaCtx.query.url === 'string' ? koaCtx.query.url : '';
    if (!rawUrl || !isValidUrl(rawUrl))
    {
      koaCtx.status = 400;
      koaCtx.body = 'invalid avatar url';
      return;
    }

    const controller = new AbortController();
    const abortRequest = () => controller.abort();
    koaCtx.req.once('aborted', abortRequest);
    koaCtx.req.once('close', abortRequest);

    try
    {
      const response = await fetch(rawUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          referer: MEDIA_PROXY_REFERER,
          'user-agent': MEDIA_PROXY_USER_AGENT,
          accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      });

      if (!response.ok)
      {
        koaCtx.status = response.status;
        koaCtx.body = `failed to proxy avatar: HTTP ${response.status}`;
        return;
      }

      const contentType = response.headers.get('content-type');
      const contentLength = response.headers.get('content-length');
      const cacheControl = response.headers.get('cache-control');
      if (contentType) koaCtx.type = contentType;
      if (contentLength) koaCtx.set('content-length', contentLength);
      if (cacheControl) koaCtx.set('cache-control', cacheControl);
      koaCtx.body = response.body ? Readable.fromWeb(response.body) : undefined;
    } catch (error)
    {
      if (error instanceof Error && error.name === 'AbortError') return;
      koaCtx.status = 502;
      koaCtx.body = 'failed to proxy avatar';
    } finally
    {
      koaCtx.req.off('aborted', abortRequest);
      koaCtx.req.off('close', abortRequest);
    }
  });
}
