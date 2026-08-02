//  src\http.ts
import { BiliApiResponse, BilibiliCookie, BiliSendMessageResponseData, NavWbiImg, NewSessionsData, QrCodeData, QrCodePollResult, SessionMessagesData, UploadImageData, WbiKeys } from './types';
import { logInfo, loggerError } from '../index';
import { BilibiliDmBot } from './bot';
import { Context, Quester } from 'koishi';
import { v4 as uuidv4 } from 'uuid';
import type { Client, Auth } from '@renmu/bili-api';

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getBilibiliAvatarProxyUrl } from '../utils/media-proxy';

const MIXIN_KEY_ENCODE_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

type RenmuUser = Client['user'];
type RenmuSearch = Client['search'];
type RenmuVideo = Client['video'];
type RenmuLive = Client['live'];
type RenmuReply = Awaited<ReturnType<Client['newReply']>>;

interface RenmuClient
{
  user: RenmuUser;
  search: RenmuSearch;
  video: RenmuVideo;
  live: RenmuLive;
  newReply(oid: number, type: number): Promise<RenmuReply>;
}

interface RenmuAuthModule
{
  default: new () => Auth;
}

interface RenmuLoginModule
{
  WebQrcodeLogin: new () => WebQrcodeLoginLike;
}

interface RenmuUserModule
{
  default: new (auth?: Auth, useCookie?: boolean) => RenmuUser;
}

interface RenmuSearchModule
{
  default: new (auth?: Auth, useCookie?: boolean) => RenmuSearch;
}

interface RenmuVideoModule
{
  default: new (auth?: Auth, useCookie?: boolean) => RenmuVideo;
}

interface RenmuLiveModule
{
  default: new (auth?: Auth, useCookie?: boolean) => RenmuLive;
}

interface RenmuReplyModule
{
  default: new (auth?: Auth, useCookie?: boolean, oid?: number, type?: number) => RenmuReply;
}

interface WebQrcodeLoginLike
{
  getQrcode(): Promise<{ url: string; qrcode_key: string; }>;
  poll(qrcodeKey: string): Promise<{ data: {
    code: number;
    url?: string;
    message?: string;
  }; }>;
}

type DynamicImporter = <T>(specifier: string) => Promise<T>;

// 使用未被打包器改写的动态 import，兼容 Koishi 的 CommonJS 加载方式。
const dynamicImport = new Function('specifier', 'return import(specifier)') as DynamicImporter;
const resolvePackage = createRequire(__filename);

export class HttpClient
{
  private cookies: BilibiliCookie = {} as BilibiliCookie;
  private biliJct = '';
  private readonly deviceId: string;
  private wbiKeys: WbiKeys | null = null;
  private wbiKeysTimestamp = 0;
  private wbiKeysFetchPromise: Promise<WbiKeys> | null = null;
  private myAvatarUrl = '';
  private selfId = 'unknown';
  private cookieVerified = false;
  private renmuAuth: Auth | undefined;
  private renmuClientPromise: Promise<RenmuClient> | undefined;

  public http: Quester;
  public isDisposed = false;

  constructor(private ctx: Context, config?: { selfId?: string; }, private bot?: BilibiliDmBot)
  {
    this.selfId = config?.selfId || 'unknown';

    this.http = ctx.http.extend({
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://message.bilibili.com/',
        'Origin': 'https://message.bilibili.com',
      },
      timeout: 10000,
    });
    this.deviceId = this.generateDeviceId();

    logInfo(`HttpClient初始化，selfId=${this.selfId}`);

    ctx.on('dispose', () =>
    {
      this.isDisposed = true;
    });
  }

  private async safeRequest<T>(requestFn: () => Promise<T>, errorMessage: string, defaultValue: T): Promise<T>
  {
    if (this.isDisposed)
    {
      logInfo('HttpClient 实例已停用，跳过HTTP请求。');
      return defaultValue;
    }

    try
    {
      try
      {
        this.ctx.setTimeout(() => { }, 0);
      } catch (error)
      {
        if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'INACTIVE_EFFECT')
        {
          logInfo('上下文已不活跃，跳过HTTP请求');
          this.isDisposed = true;
          return defaultValue;
        }
      }

      return await requestFn();
    } catch (error)
    {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('context disposed'))
      {
        this.isDisposed = true;
        return defaultValue;
      }
      loggerError(`${errorMessage}: ${message}`);
      return defaultValue;
    }
  }

  private loadRenmuModule<T>(specifier: string): Promise<T>
  {
    return dynamicImport<T>(specifier);
  }

  private loadRenmuFile<T>(relativePath: string): Promise<T>
  {
    const entry = resolvePackage.resolve('@renmu/bili-api');
    const file = path.resolve(path.dirname(entry), relativePath);
    return this.loadRenmuModule<T>(pathToFileURL(file).href);
  }

  private syncRenmuAuth(): void
  {
    if (!this.renmuAuth || !this.cookies.SESSDATA || !this.cookies.bili_jct)
    {
      return;
    }

    const uid = Number(this.cookies.DedeUserID || this.selfId || 0);
    this.renmuAuth.setAuth(
      {
        SESSDATA: this.cookies.SESSDATA,
        bili_jct: this.cookies.bili_jct,
        DedeUserID: this.cookies.DedeUserID || uid,
      },
      uid,
    );
  }

  async getRenmuClient(): Promise<RenmuClient>
  {
    if (!this.renmuClientPromise)
    {
      this.renmuClientPromise = Promise.all([
        this.loadRenmuFile<RenmuAuthModule>('base/Auth.js'),
        this.loadRenmuFile<RenmuUserModule>('user/index.js'),
        this.loadRenmuFile<RenmuSearchModule>('search/index.js'),
        this.loadRenmuFile<RenmuVideoModule>('video/index.js'),
        this.loadRenmuFile<RenmuLiveModule>('live/index.js'),
        this.loadRenmuFile<RenmuReplyModule>('video/reply.js'),
      ]).then(([authModule, userModule, searchModule, videoModule, liveModule, replyModule]) =>
      {
        this.renmuAuth = new authModule.default();
        this.syncRenmuAuth();
        const auth = this.renmuAuth;
        return {
          user: new userModule.default(auth, true),
          search: new searchModule.default(auth, true),
          video: new videoModule.default(auth, true),
          live: new liveModule.default(auth, true),
          newReply: async (oid: number, type: number) => new replyModule.default(auth, true, oid, type),
        };
      }).catch((error) =>
      {
        this.renmuClientPromise = undefined;
        throw error;
      });
    }
    return this.renmuClientPromise;
  }

  setCookies(cookies: BilibiliCookie)
  {
    this.cookies = cookies;
    this.biliJct = cookies.bili_jct || '';
    const cookieString = Object.entries(cookies)
      .filter(([key]) => !key.startsWith('wbi_'))
      .map(([k, v]) => `${k}=${v}`).join('; ');

    if (this.http.config.headers)
    {
      (this.http.config.headers as Record<string, string>)['Cookie'] = cookieString;
    }

    if (cookies.wbi_img_key && cookies.wbi_sub_key && cookies.wbi_timestamp)
    {
      this.wbiKeys = {
        img_key: cookies.wbi_img_key,
        sub_key: cookies.wbi_sub_key,
      };
      this.wbiKeysTimestamp = cookies.wbi_timestamp;
    }

    this.syncRenmuAuth();
    logInfo(`成功设置cookie，长度: ${cookieString.length}`);
  }

  hasCookies(): boolean
  {
    return this.cookieVerified || !!(this.cookies && this.cookies.SESSDATA && this.cookies.bili_jct);
  }

  setCookieVerified(verified: boolean): void
  {
    this.cookieVerified = verified;
    logInfo(`Cookie验证状态设置为: ${verified}`);
  }

  private getMixinKey(orig: string): string
  {
    let temp = '';
    MIXIN_KEY_ENCODE_TABLE.forEach((n) => { temp += orig[n]; });
    return temp.slice(0, 32);
  }

  public async getWbiKeys(): Promise<WbiKeys>
  {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startOfToday = today.getTime();

    if (this.wbiKeys && this.wbiKeysTimestamp >= startOfToday)
    {
      return this.wbiKeys;
    }

    if (this.cookies.wbi_timestamp && this.cookies.wbi_img_key && this.cookies.wbi_sub_key && this.cookies.wbi_mixin_key)
    {
      if (this.cookies.wbi_timestamp >= startOfToday)
      {
        logInfo('从cookie文件加载WBI密钥');
        this.wbiKeys = {
          img_key: this.cookies.wbi_img_key,
          sub_key: this.cookies.wbi_sub_key,
        };
        this.wbiKeysTimestamp = this.cookies.wbi_timestamp;
        return this.wbiKeys;
      }
    }

    if (this.wbiKeysFetchPromise)
    {
      return this.wbiKeysFetchPromise;
    }

    this.wbiKeysFetchPromise = this.safeRequest(async () =>
    {
      logInfo('WBI密钥已过期或未找到，正在从API获取新密钥...');
      const res = await this.http.get<BiliApiResponse<{ wbi_img: NavWbiImg; }>>('https://api.bilibili.com/x/web-interface/nav', {
        headers: { 'Referer': 'https://www.bilibili.com/', 'Origin': 'https://www.bilibili.com' }
      });

      if (res.code === 0 && res.data?.wbi_img?.img_url && res.data?.wbi_img?.sub_url)
      {
        const imgKey = res.data.wbi_img.img_url.substring(res.data.wbi_img.img_url.lastIndexOf('/') + 1, res.data.wbi_img.img_url.lastIndexOf('.'));
        const subKey = res.data.wbi_img.sub_url.substring(res.data.wbi_img.sub_url.lastIndexOf('/') + 1, res.data.wbi_img.sub_url.lastIndexOf('.'));

        const mixinKey = this.getMixinKey(imgKey + subKey);

        this.wbiKeys = { img_key: imgKey, sub_key: subKey };
        const timestamp = Date.now();
        this.wbiKeysTimestamp = timestamp;

        this.cookies.wbi_img_key = imgKey;
        this.cookies.wbi_sub_key = subKey;
        this.cookies.wbi_mixin_key = mixinKey;
        this.cookies.wbi_timestamp = timestamp;

        if (this.bot)
        {
          await this.bot.saveCookie(this.cookies);
        }

        logInfo('WBI密钥获取并缓存成功。');
        return this.wbiKeys;
      }

      throw new Error(`Failed to get WBI keys: ${res.message || 'Invalid response data'}`);
    }, '获取WBI密钥时发生网络错误', null).finally(() =>
    {
      this.wbiKeysFetchPromise = null;
    });

    return this.wbiKeysFetchPromise;
  }

  private async signWithWbi(params: Record<string, string | number>): Promise<{ w_rid: string, wts: number; }>
  {
    await this.getWbiKeys();
    const mixinKey = this.cookies.wbi_mixin_key;
    if (!mixinKey)
    {
      throw new Error('无法获取 mixinKey，请检查 WBI 密钥是否正确获取和缓存');
    }

    const currTime = Math.round(Date.now() / 1000);
    const signedParams: Record<string, string | number> = { ...params, wts: currTime };
    const query = Object.keys(signedParams).sort().map((key) =>
    {
      const value = String(signedParams[key]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    }).join('&');

    const wbiSign = createHash('md5').update(query + mixinKey).digest('hex');
    return { w_rid: wbiSign, wts: currTime };
  }

  async getWbiSignature(params: Record<string, string | number>): Promise<{ w_rid: string; wts: number; }>
  {
    const { w_rid, wts } = await this.signWithWbi(params);

    if (!w_rid || !wts)
    {
      throw new Error('新包返回的 WBI 签名结果缺少必要字段');
    }

    return { w_rid, wts };
  }

  getBiliJct(): string
  {
    return this.biliJct;
  }

  async getQrCodeData(): Promise<QrCodeData | null>
  {
    return this.safeRequest(async () =>
    {
      const loginModule = await this.loadRenmuFile<RenmuLoginModule>('user/login.js');
      const login = new loginModule.WebQrcodeLogin();
      const res = await login.getQrcode();
      return { url: res.url, qrcode_key: res.qrcode_key };
    }, '获取二维码数据时发生网络错误', null);
  }

  async pollQrCodeStatus(qrcodeKey: string): Promise<QrCodePollResult>
  {
    return this.safeRequest(async () =>
    {
      const loginModule = await this.loadRenmuFile<RenmuLoginModule>('user/login.js');
      const login = new loginModule.WebQrcodeLogin();
      const res = await login.poll(qrcodeKey);
      const data = res.data;

        if (data.code === 0 && data.url)
        {
          const url = new URL(data.url);
          const SESSDATA = url.searchParams.get('SESSDATA');
          const bili_jct = url.searchParams.get('bili_jct');
          const DedeUserID = url.searchParams.get('DedeUserID');
          if (SESSDATA && bili_jct && DedeUserID)
          {
            return { status: 'success', message: '登录成功', cookies: { SESSDATA, bili_jct, DedeUserID } };
          }

          return { status: 'success', message: '登录成功', loginUrl: data.url };
      }

      if (data.code === 86038)
      {
        return { status: 'expired', message: '二维码已失效' };
      }
      if (data.code === 86090)
      {
        return { status: 'scanned', message: '已扫描，待确认' };
      }
      if (data.code === 86101)
      {
        return { status: 'waiting', message: '等待扫码' };
      }
      return {
        status: 'error',
        message: `二维码登录接口错误（${data.code}）：${data.message || '未知错误'}`,
      };
    }, '[轮询] 轮询二维码状态时发生网络错误', { status: 'error', message: '二维码状态请求失败，请查看后端日志' });
  }

  async exchangeQrCodeLogin(loginUrl: string): Promise<BilibiliCookie | null>
  {
    return this.safeRequest(async () =>
    {
      const response = await this.http(loginUrl, {
        redirect: 'manual',
        validateStatus: (status) => status >= 200 && status < 400,
        headers: {
          Referer: 'https://www.bilibili.com/',
          Origin: 'https://www.bilibili.com',
        },
      });
      const headers = response.headers as Headers & {
        getSetCookie?: () => string[];
      };
      const setCookies = headers.getSetCookie?.() || [];
      const setCookie = headers.get('set-cookie');
      const cookieHeaders = setCookies.length > 0 ? setCookies : setCookie ? [setCookie] : [];
      if (cookieHeaders.length === 0)
      {
        loggerError(`二维码跨域登录响应未返回 Cookie: status=${response.status}, url=${response.url}, location=${headers.get('location') || ''}`);
        return null;
      }

      const cookies: Record<string, string> = {};
      for (const header of cookieHeaders)
      {
        for (const item of header.split(/, (?=[A-Za-z0-9_]+=[^;]+)/))
        {
          const match = item.match(/^\s*([^=;]+)=([^;]*)/);
          if (match)
          {
            cookies[match[1]] = match[2];
          }
        }
      }

      const SESSDATA = cookies.SESSDATA;
      const bili_jct = cookies.bili_jct;
      const DedeUserID = cookies.DedeUserID;
      if (!SESSDATA || !bili_jct || !DedeUserID)
      {
        loggerError(`二维码跨域登录 Cookie 不完整: status=${response.status}, url=${response.url}, cookieNames=${Object.keys(cookies).join(',')}`);
        return null;
      }

      return { SESSDATA, bili_jct, DedeUserID };
    }, '交换二维码登录 Cookie 时发生网络错误', null);
  }

  async getMyInfo(): Promise<{ nickname: string, avatar: string, isValid: boolean; }>
  {
    return this.safeRequest(async () =>
    {
      if (!this.hasCookies())
      {
        this.setCookieVerified(false);
        return { nickname: '', avatar: '', isValid: false };
      }

      const res = await (await this.getRenmuClient()).user.getMyInfo();
      this.setCookieVerified(true);

      const avatarUrl = getBilibiliAvatarProxyUrl(this.ctx, res.profile.face);
      this.myAvatarUrl = avatarUrl;

      return { nickname: res.profile.name, avatar: avatarUrl, isValid: true };
    }, '验证Cookie失败', { nickname: '', avatar: '', isValid: false });
  }

  getMyAvatarUrl(): string
  {
    return this.myAvatarUrl;
  }

  async getUser(userId: string): Promise<{ nickname: string, avatar: string; } | null>
  {
    return this.safeRequest(async () =>
    {
      const uid = Number(userId);
      if (Number.isNaN(uid))
      {
        return null;
      }

      const res = await (await this.getRenmuClient()).user.getUserInfo(uid, true);
      return { nickname: res.name, avatar: res.face };
    }, `获取B站用户${userId} 信息时发生网络错误`, null);
  }

  async getNewSessions(begin_ts: number): Promise<NewSessionsData | null>
  {
    if (!this.cookies || !this.cookies.SESSDATA || !this.cookies.bili_jct || !this.cookieVerified)
    {
      loggerError('轮询新会话失败: 未设置cookie或cookie无效');
      return null;
    }

    return this.safeRequest(async () =>
    {
      const res = await this.http.get<BiliApiResponse<NewSessionsData>>(
        'https://api.vc.bilibili.com/session_svr/v1/session_svr/new_sessions',
        {
          params: { begin_ts, build: 0, mobi_app: 'web' },
          headers: {
            Cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '),
          },
        }
      );
      if (res.code === 0) return res.data;
      loggerError('轮询新会话失败: ', res);
      return null;
    }, '轮询新会话时发生网络错误', null);
  }

  async fetchSessionMessages(talker_id: number, session_type: number, begin_seqno: number): Promise<SessionMessagesData | null>
  {
    if (!this.cookieVerified)
    {
      loggerError('获取消息失败: 未设置cookie或cookie无效');
      return null;
    }

    if (!this.cookies || !this.cookies.SESSDATA || !this.cookies.bili_jct)
    {
      loggerError('获取消息失败: 未设置cookie或cookie无效');
      return null;
    }

    logInfo(`正在获取用户 ${talker_id} 在时间戳 ${begin_seqno} 之后的消息`);
    return this.safeRequest(async () =>
    {
      const httpResponse = await this.http.get<BiliApiResponse<SessionMessagesData>>(
        'https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs',
        {
          params: {
            talker_id,
            session_type,
            begin_seqno,
            size: 20,
            build: 0,
            mobi_app: 'web',
          },
          headers: {
            Cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '),
          },
          responseType: 'text',
        }
      );

      const resText = httpResponse as unknown as string;
      let res: BiliApiResponse<SessionMessagesData>;
      try
      {
        const transformedResText = resText.replace(/"msg_key":(\d+)/g, '"msg_key":"$1"');
        res = JSON.parse(transformedResText);
      } catch (error)
      {
        const message = error instanceof Error ? error.message : String(error);
        loggerError(`fetchSessionMessages JSON parse error: ${message}, raw: ${resText}`);
        return null;
      }

      if (res.code === 0) return res.data;
      logInfo(`获取用户 ${talker_id} 的消息失败: ${res.message} (错误码: ${res.code})`);
      return null;
    }, `获取用户 ${talker_id} 的消息时发生网络错误`, null);
  }

  async updateAck(talker_id: number, session_type: number, ack_seqno: number): Promise<void>
  {
    return this.safeRequest(async () =>
    {
      await this.http.post(
        'https://api.vc.bilibili.com/session_svr/v1/session_svr/update_ack',
        new URLSearchParams({
          talker_id: talker_id.toString(),
          session_type: session_type.toString(),
          ack_seqno: ack_seqno.toString(),
          build: '0',
          mobi_app: 'web',
          csrf: this.biliJct,
          csrf_token: this.biliJct,
        })
      );
      logInfo(`已将用户 ${talker_id} 的会话标记为已读，直到时间戳 ${ack_seqno}`);
    }, `将用户 ${talker_id} 的会话标记为已读失败`, undefined);
  }

  async uploadImage(imageBuffer: Buffer): Promise<UploadImageData | null>
  {
    const boundary = `----WebKitFormBoundary${uuidv4().replace(/-/g, '')}`;
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file_up"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`),
      imageBuffer,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="biz"\r\n\r\n`),
      Buffer.from('im'),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n`),
      Buffer.from(this.biliJct),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    return this.safeRequest(async () =>
    {
      const res = await this.http.post<BiliApiResponse<UploadImageData>>(
        'https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs',
        payload,
        { headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } }
      );
      if (res.code === 0 && res.data) return res.data;
      logInfo('上传图片失败:', res.message);
      return null;
    }, '上传图片时发生网络错误', null);
  }

  async sendMessage(senderUid: string, receiverId: number, msgContent: string, msgType: 1 | 2 | 5): Promise<string | null>
  {
    const msgObject = {
      sender_uid: senderUid,
      receiver_id: receiverId,
      receiver_type: 1,
      msg_type: msgType,
      msg_status: 0,
      content: msgContent,
      timestamp: Math.floor(Date.now() / 1000),
      dev_id: this.deviceId,
      new_face_version: 1,
    };

    const formPayload = new URLSearchParams({
      'msg[sender_uid]': msgObject.sender_uid.toString(),
      'msg[receiver_id]': msgObject.receiver_id.toString(),
      'msg[receiver_type]': msgObject.receiver_type.toString(),
      'msg[msg_type]': msgObject.msg_type.toString(),
      'msg[msg_status]': msgObject.msg_status.toString(),
      'msg[content]': msgObject.content,
      'msg[timestamp]': msgObject.timestamp.toString(),
      'msg[dev_id]': msgObject.dev_id,
      'msg[new_face_version]': msgObject.new_face_version.toString(),
      'build': '0',
      'mobi_app': 'web',
      'csrf_token': this.biliJct,
      'csrf': this.biliJct,
    }).toString();

    return this.safeRequest(async () =>
    {
      const urlParams = await this.signWithWbi({
        w_sender_uid: senderUid,
        w_receiver_id: receiverId,
        w_dev_id: this.deviceId,
      });

      const apiUrl = 'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg';
      const httpResponse = await this.http.post<BiliApiResponse<BiliSendMessageResponseData>>(
        apiUrl,
        formPayload,
        {
          params: urlParams,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': 'https://message.bilibili.com/h5',
            'Origin': 'https://message.bilibili.com',
          },
          responseType: 'text',
        }
      );

      const resText = httpResponse as unknown as string;
      let res: BiliApiResponse<BiliSendMessageResponseData>;
      try
      {
        const transformedResText = resText.replace(/"msg_key":(\d+)/g, '"msg_key":"$1"');
        res = JSON.parse(transformedResText);
      } catch (error)
      {
        const message = error instanceof Error ? error.message : String(error);
        loggerError(`sendMessage JSON parse error: ${message}, raw: ${resText}`);
        return null;
      }

      if (res.code === 0)
      {
        logInfo(`成功发送消息给 ${receiverId} (msg_key: ${res.data?.msg_key})`);
        return res.data?.msg_key || null;
      }

      if (res.code === 21020)
      {
        logInfo(`发送消息给 ${receiverId} 失败: 频率过快，请稍后再发 (code: ${res.code})`);
      } else if (res.code === 10005)
      {
        logInfo(`发送消息给 ${receiverId} 失败: 消息ID不存在 (code: ${res.code})`);
      } else
      {
        logInfo(`发送消息给 ${receiverId} 失败: ${res.message || res.msg} (code: ${res.code})`);
      }

      return null;
    }, `发送消息给 ${receiverId} 失败`, null);
  }

  public async safeFileRequest(url: string, errorMessage: string): Promise<{ data: Buffer, type: string, name: string, mime: string; } | null>
  {
    const fileResponse = await this.safeRequest(() => this.ctx.http.file(url), errorMessage, null);

    if (fileResponse)
    {
      const bufferData = Buffer.from(fileResponse.data);
      return {
        data: bufferData,
        type: fileResponse.type,
        name: fileResponse.filename,
        mime: fileResponse.mime,
      };
    }
    return null;
  }

  private generateDeviceId(): string
  {
    return uuidv4().toUpperCase();
  }
}
