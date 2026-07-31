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
      // 销毁前先通知前端离线，避免保留旧的在线状态。
      this.setBotOffline(this.config.selfId);
      this.isDisposed = true;
      loggerInfo('正在关闭连接 Bilibili ...');
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
    // 所有销毁路径都先同步离线状态。
    this.setBotOffline(this.config.selfId);
    this.isDisposed = true;
    logInfo('服务已标记为已停用状态');
  }

  setBotOffline(selfId: string, message = '机器人已离线'): void
  {
    if (!selfId) return;

    const status: BotStatus = {
      ...(this.status[selfId] || { status: 'offline', selfId }),
      status: 'offline',
      selfId,
      message,
    };
    this.status[selfId] = status;
    this.launcher?.updateStatus?.(status);
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

  private isCookieAccountMatched(cookieData: BilibiliCookie, selfId: string): boolean
  {
    const cookieId = String(cookieData.DedeUserID || '').trim();
    const configId = String(selfId).trim();
    return !!cookieId && cookieId === configId;
  }

  private rejectMismatchedAccount(selfId: string, cookieId: string): void
  {
    loggerError(`扫码账号与配置项账号不一致，配置项 selfId: ${selfId}，Cookie DedeUserID: ${cookieId}`);
    this.updateStatus(selfId, {
      status: 'error',
      selfId,
      message: '扫码账号和配置项账号不一致，请更换账号',
    });
  }

  async startLogin(bot: BilibiliDmBot, sessionFile: string): Promise<boolean>
  {
    const selfId = bot.selfId;
    let loginSucceeded = false;

    try
    {
      if (this.isDisposed)
      {
        return false;
      }

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

          if (!this.isCookieAccountMatched(cookieData, selfId))
          {
            const cookieId = String(cookieData.DedeUserID || '未知');
            this.rejectMismatchedAccount(selfId, cookieId);
            bot.http.setCookieVerified(false);
            return false;
          }

          bot.http.setCookies(cookieData);
          const userInfo = await bot.http.getMyInfo();
          if (this.isDisposed)
          {
            return false;
          }
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
            bot.markLoginReady();

            await bot.start();
            if (this.isDisposed)
            {
              return false;
            }
            bot.online();
            loginSucceeded = true;
            return true;
          }

          this.updateStatus(selfId, {
            status: 'continue',
            selfId,
            message: '缓存的登录信息已失效，需要重新登录',
          });
        } catch (error)
        {
          if (this.isDisposed)
          {
            return false;
          }

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
      if (this.isDisposed)
      {
        return false;
      }

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
      if (this.isDisposed)
      {
        return false;
      }

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
        if (this.isDisposed)
        {
          return false;
        }

        if (pollResult.status === 'success')
        {
          const cookies = pollResult.cookies ||
            (pollResult.loginUrl ? await bot.http.exchangeQrCodeLogin(pollResult.loginUrl) : null);
          if (!cookies)
          {
            this.updateStatus(selfId, {
              status: 'error',
              message: '扫码成功，但获取登录 Cookie 失败，请查看后端日志',
            });
            return false;
          }

          const newCookie: BilibiliCookie = {
            SESSDATA: cookies.SESSDATA,
            bili_jct: cookies.bili_jct,
            DedeUserID: cookies.DedeUserID,
          };

          await this.saveCookie(selfId, newCookie);
          if (this.isDisposed)
          {
            return false;
          }

          if (!this.isCookieAccountMatched(newCookie, selfId))
          {
            this.rejectMismatchedAccount(selfId, String(newCookie.DedeUserID || '未知'));
            bot.http.setCookieVerified(false);
            return false;
          }

          bot.http.setCookies(newCookie);
          bot.http.setCookieVerified(true);

          const userInfo = await bot.http.getMyInfo();
          if (this.isDisposed)
          {
            return false;
          }
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

          bot.markLoginReady();
          await bot.start();
          if (this.isDisposed)
          {
            return false;
          }
          bot.online();
          loginSucceeded = true;
          return true;
        }

        if (pollResult.status === 'scanned')
        {
          // 扫码后仍保留二维码，等待手机确认登录完成。
          this.updateStatus(selfId, {
            status: 'qrcode',
            message: '二维码已扫描，请在手机上确认登录',
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
        else if (pollResult.status === 'error')
        {
          this.updateStatus(selfId, {
            status: 'error',
            message: pollResult.message,
          });
          return false;
        }

        try
        {
          await this.ctx.sleep(2000);
        }
        catch (error)
        {
          if (this.isDisposed)
          {
            return false;
          }
          throw error;
        }
        retryCount++;
      }

      if (this.isDisposed)
      {
        return false;
      }

      this.updateStatus(selfId, {
        status: 'error',
        message: '登录超时，请刷新页面重试',
      });
      return false;
    } catch (error)
    {
      if (this.isDisposed)
      {
        return false;
      }

      loggerError('登录过程中发生错误: ', error);
      this.updateStatus(selfId, {
        status: 'error',
        message: `登录失败: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
    finally
    {
      if (!loginSucceeded)
      {
        bot.cancelLogin();
      }
    }
  }
}
