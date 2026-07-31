//  src\service.ts
import { BotStatus, logInfo, loggerError, loggerInfo } from '../index';
import { BilibiliCookie, PluginConfig } from './types';
import { BilibiliDmBot } from './bot';
import { Context } from 'koishi';
import QRCode from 'qrcode';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { getDataFilePath } from './utils';

type RenmuCookieFile = {
  cookie_info: {
    cookies: Array<{ name: string; value: string; }>;
  };
  token_info?: {
    access_token?: string;
    mid?: number;
  };
};

export class BilibiliService
{
  private status: Record<string, BotStatus> = {};
  private isDisposed = false;
  public config: PluginConfig;
  private launcher: { updateStatus?: (status: BotStatus) => void; } | undefined;

  constructor(private ctx: Context, config: PluginConfig)
  {
    this.config = config;

    ctx.on('dispose', () =>
    {
      this.isDisposed = true;
      loggerInfo('正在关闭连接 Bilibili ...');
      delete this.status[this.config.selfId];
      logInfo('已从服务状态中移除');
    });
  }

  setLauncher(launcher: { updateStatus?: (status: BotStatus) => void; }): void
  {
    this.launcher = launcher;
    logInfo('BilibiliService 已关联 launcher 实例');
  }

  getStatus(): Record<string, BotStatus>
  {
    return this.status;
  }

  markAsDisposed(): void
  {
    this.isDisposed = true;
    logInfo('服务已标记为已停用状态');
  }

  updateStatus(selfId: string, status: Partial<BotStatus>)
  {
    if (this.isDisposed) return;
    if (!selfId)
    {
      logInfo('updateStatus: selfId为空，无法更新状态');
      return;
    }

    logInfo(`更新状态前: ${JSON.stringify(this.status[selfId]?.status)}, 更新为: ${JSON.stringify(status.status)}`);

    this.status[selfId] = {
      ...(this.status[selfId] || { status: 'init', selfId }),
      ...status,
      selfId,
    };

    if (this.launcher && typeof this.launcher.updateStatus === 'function')
    {
      logInfo('直接调用 launcher.updateStatus 更新前端');
      this.launcher.updateStatus(this.status[selfId]);
    } else
    {
      logInfo('launcher 未设置或不可用，跳过前端更新');
    }
  }

  async saveCookie(selfId: string, cookieData: BilibiliCookie)
  {
    if (this.isDisposed) return;
    try
    {
      const sessionFile = getDataFilePath(this.ctx, selfId, `${selfId}.cookie.json`);
      const renmuCookie = {
        cookie_info: {
          cookies: Object.entries(cookieData)
            .filter(([key, value]) => value !== undefined && value !== null && !key.startsWith('wbi_'))
            .map(([name, value]) => ({ name, value: String(value) })),
        },
        token_info: {
          mid: Number(cookieData.DedeUserID || selfId),
        },
      } satisfies RenmuCookieFile;

      await writeFile(sessionFile, JSON.stringify(renmuCookie, null, 2), 'utf8');
      logInfo(`Cookie data for ${selfId} saved to ${sessionFile}`);
    } catch (error)
    {
      loggerError(`Failed to save cookie for ${selfId}:`, error);
    }
  }

  private parseCookieFile(content: string): BilibiliCookie | null
  {
    const parsed = JSON.parse(content) as RenmuCookieFile | BilibiliCookie;
    if ('cookie_info' in parsed)
    {
      const cookieData = parsed.cookie_info.cookies.reduce<Record<string, string>>((acc, item) =>
      {
        acc[item.name] = item.value;
        return acc;
      }, {});

      if (parsed.token_info?.mid)
      {
        cookieData.DedeUserID = String(parsed.token_info.mid);
      }

      return cookieData as unknown as BilibiliCookie;
    }

    return parsed as BilibiliCookie;
  }

  async startLogin(bot: BilibiliDmBot, sessionFile: string): Promise<boolean>
  {
    const selfId = bot.selfId;

    try
    {
      if (!this.status[selfId])
      {
        this.status[selfId] = {
          status: 'init',
          selfId,
          message: '正在初始化登录...'
        };
      }

      this.updateStatus(selfId, {
        status: 'init',
        selfId,
        message: '正在初始化登录...'
      });

      const fileExists = existsSync(sessionFile);
      if (fileExists)
      {
        try
        {
          const cookieData = this.parseCookieFile(await readFile(sessionFile, 'utf8'));
          if (!cookieData)
          {
            throw new Error('cookie 文件格式无效');
          }

          bot.http.setCookies(cookieData);
          const userInfo = await bot.http.getMyInfo();
          if (userInfo.isValid)
          {
            this.updateStatus(selfId, {
              status: 'success',
              selfId,
              message: `已使用缓存登录，欢迎回来，${userInfo.nickname}`,
            });
            bot.user.name = userInfo.nickname;
            bot.user.username = userInfo.nickname;
            bot.user.nick = userInfo.nickname;
            bot.user.avatar = userInfo.avatar;

            loggerInfo(`已使用缓存登录，欢迎回来，${userInfo.nickname}`);
            bot.http.setCookieVerified(true);

            await bot.start();
            bot.online();
            return true;
          }

          this.updateStatus(selfId, {
            status: 'continue',
            selfId,
            message: '缓存的登录信息已失效，需要重新登录',
          });
        } catch (error)
        {
          loggerError('无法加载缓存的登录信息，错误详情: ', error);
          this.updateStatus(selfId, {
            status: 'continue',
            message: '无法加载缓存的登录信息，需要重新登录',
          });
        }
      } else
      {
        this.updateStatus(selfId, {
          status: 'init',
          selfId,
          message: '正在获取登录状态...',
        });
      }

      const qrData = await bot.http.getQrCodeData();
      if (!qrData)
      {
        this.updateStatus(selfId, {
          status: 'error',
          message: '获取二维码失败，请稍后重试',
        });
        return false;
      }

      const qrImageBase64 = await QRCode.toDataURL(qrData.url, {
        margin: 1,
        scale: 8,
        errorCorrectionLevel: 'H'
      });

      this.updateStatus(selfId, {
        status: 'qrcode',
        message: '请使用手机扫描二维码',
        image: qrImageBase64,
      });

      let retryCount = 0;
      const maxRetries = 60;

      while (retryCount < maxRetries && !this.isDisposed)
      {
        const pollResult = await bot.http.pollQrCodeStatus(qrData.qrcode_key);

        if (pollResult.status === 'success' && pollResult.cookies)
        {
          const newCookie: BilibiliCookie = {
            SESSDATA: pollResult.cookies.SESSDATA,
            bili_jct: pollResult.cookies.bili_jct,
            DedeUserID: pollResult.cookies.DedeUserID,
          };
          bot.http.setCookies(newCookie);
          await this.saveCookie(selfId, newCookie);
          bot.http.setCookieVerified(true);

          const userInfo = await bot.http.getMyInfo();
          this.updateStatus(selfId, {
            status: 'success',
            selfId,
            message: `登录成功，欢迎 ${userInfo.nickname}`,
          });

          bot.user.name = userInfo.nickname;
          bot.user.username = userInfo.nickname;
          bot.user.nick = userInfo.nickname;
          bot.user.avatar = userInfo.avatar;

          loggerInfo(`已使用扫码登录，欢迎回来，${userInfo.nickname}`);

          await bot.start();
          bot.online();
          return true;
        }

        if (pollResult.status === 'scanned')
        {
          // 扫码后仍保留二维码，等待手机确认登录完成。
          this.updateStatus(selfId, {
            status: 'qrcode',
            message: '二维码已扫描，请在手机上完成登录',
            image: qrImageBase64,
          });
        } else if (pollResult.status === 'expired')
        {
          this.updateStatus(selfId, {
            status: 'error',
            message: '二维码已过期，请刷新页面重试',
          });
          return false;
        }

        await this.ctx.sleep(2000);
        retryCount++;
      }

      this.updateStatus(selfId, {
        status: 'error',
        message: '登录超时，请刷新页面重试',
      });
      return false;
    } catch (error)
    {
      loggerError('登录过程中发生错误: ', error);
      this.updateStatus(selfId, {
        status: 'error',
        message: `登录失败: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  }
}
