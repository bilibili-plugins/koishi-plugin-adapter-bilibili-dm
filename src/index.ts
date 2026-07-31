//  src\index.ts
import { getBilibiliErrorMessage } from './bilibiliAPI/temp_error_codes';
import { DataService } from '@koishijs/plugin-console';
import { BilibiliDmAdapter } from './bot/adapter';
import { BilibiliService } from './bot/service';
import { PluginConfig } from './bot/types';
import { BilibiliDmBot } from './bot/bot';
import { Context, Logger } from 'koishi';
import { Config } from './bot/schema';

import { promises as fs, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDataFilePath } from './bot/utils';
import { registerBilibiliMediaProxyRoute } from './utils/media-proxy';

export let loggerError: (message: any, ...args: any[]) => void;
export let loggerInfo: (message: any, ...args: any[]) => void;
export let logInfo: (message: any, ...args: any[]) => void;
export let loginfolive: (message: any, ...args: any[]) => void;

export const name = "adapter-bilibili-dm";
export const inject = {
  required: ["http", "i18n", "server", "logger", "console"],
  optional: ["notifier"]
};
export const reusable = true;
export const filter = false;
export { Config };

const devlogger = new Logger(`DEV:${name}`);
const logger = new Logger(name);

export const usage = `
---

<p>Bilibili Direct Message Adapter for Koishi</p>
<p>➣ <a href="https://bilibili-plugins.github.io/koishi-plugin-adapter-bilibili-dm/" target="_blank">点我查看使用说明</a></p>

---

需要注意：
- 如果不希望bot响应消息，请配置 nestedblocked 配置项
- B站API有调用频率限制，请合理控制调用频率
- 返回的数据格式可能随B站API更新而变化

B站私信只推送至最后打开私信页面的客户端，

为避免机器人无法接收消息，请尽量不要在客户端使用机器人账号查看私信。

如遇此情况，请关闭其他客户端并重启本插件即可恢复。

---
`;

export * from './test/test';
export * from './bot/types';
export * from './bilibiliAPI';

export interface BotStatus
{
  status: 'init' | 'qrcode' | 'continue' | 'success' | 'error' | 'offline';
  selfId: string;
  image?: string;
  message?: string;
  pluginName?: string;
}

// 自定义事件
declare module 'koishi' {
  interface Context
  {
  }

  interface Events
  {
    'bilibili-dm/status-update': (status: BotStatus) => void;
    [key: `bilibili-dm-${string}/status-update`]: (status: BotStatus) => void;

    // 动态相关事件
    'bilibili/dynamic-update': (data: import('./bilibiliAPI/apis/types').DynamicEventData) => void;
    'bilibili/dynamic-video-update': (data: import('./bilibiliAPI/apis/types').DynamicEventData) => void;
    'bilibili/dynamic-image-update': (data: import('./bilibiliAPI/apis/types').DynamicEventData) => void;
    'bilibili/dynamic-text-update': (data: import('./bilibiliAPI/apis/types').DynamicEventData) => void;
    'bilibili/dynamic-article-update': (data: import('./bilibiliAPI/apis/types').DynamicEventData) => void;
    'bilibili/dynamic-live-update': (data: import('./bilibiliAPI/apis/types').DynamicEventData) => void;
    'bilibili/dynamic-forward-update': (data: import('./bilibiliAPI/apis/types').DynamicEventData) => void;
    'bilibili/dynamic-pgc-update': (data: import('./bilibiliAPI/apis/types').DynamicEventData) => void;
    'bilibili/dynamic-ugc-season-update': (data: import('./bilibiliAPI/apis/types').DynamicEventData) => void;
    'bilibili/dynamic-unknown-update': (data: import('./bilibiliAPI/apis/types').DynamicEventData) => void;

    // 直播相关事件
    'bilibili/live-update': (data: import('./bilibiliAPI/apis/types').LiveEventData) => void;
    'bilibili/live-start': (data: import('./bilibiliAPI/apis/types').LiveEventData) => void;
    'bilibili/live-end': (data: import('./bilibiliAPI/apis/types').LiveEventData) => void;
    'bilibili/live-info-update': (data: import('./bilibiliAPI/apis/types').LiveEventData) => void;
  }
}

declare module '@koishijs/plugin-console' {
  namespace Console
  {
    interface Services
    {
      [key: `bilibili-dm-${string}`]: BilibiliLauncher;
    }
  }

  interface Events
  {
    [key: `bilibili-dm-${string}/start-login`]: (data: { selfId: string; }) => Promise<{ selfId: string; }>;
  }
}


// 创建数据服务
export class BilibiliLauncher extends DataService<BotStatus>
{
  private currentBot: string;
  private readonly selfId: string;
  private consoleMessages: Record<string, BotStatus> = {};
  readonly serviceId: string;

  constructor(ctx: Context, private service: BilibiliService, config: PluginConfig)
  {
    const serviceId = `bilibili-dm-${config.selfId}`;
    super(ctx, serviceId as keyof import('@koishijs/plugin-console').Console.Services, { immediate: true });
    this.serviceId = serviceId;
    this.currentBot = config.selfId;
    this.selfId = config.selfId;

    logInfo(`BilibiliLauncher构造函数，serviceId: ${serviceId}, currentBot: ${this.currentBot}`);

    const sessionFile = getDataFilePath(ctx, config.selfId, `${config.selfId}.cookie.json`);
    const hasCacheFile = existsSync(sessionFile);

    logInfo(`BilibiliLauncher初始化，缓存文件存在: ${hasCacheFile}`);

    // 启动时先显示统一的登录状态检查，避免无缓存时短暂显示离线。
    this.consoleMessages[config.selfId] = {
      status: 'init',
      selfId: config.selfId,
      message: '正在获取登录状态...'
    };
    logInfo(`初始化登录状态，缓存文件存在: ${hasCacheFile}`);

    // 立即刷新前端
    this.refresh();

    const loginEventName = `bilibili-dm-${config.selfId}/start-login` as const;

    const loginListener = async (data: { selfId: string; }) =>
    {
      // 登录账号始终以配置项为准，不能使用前端传入的其他账号。
      const selfId = config.selfId;
      this.currentBot = selfId;

      logInfo(`收到前端登录请求，selfId: ${selfId}`);
      logInfo(`当前机器人列表: ${ctx.bots.map(bot => `${bot.platform}:${bot.selfId}`).join(', ')}`);

      // 更新状态
      this.updateStatus({
        status: 'init',
        selfId: selfId,
        message: '正在初始化...'
      });

      // 创建新机器人实例
      logInfo(`创建新机器人实例，使用selfId: ${selfId}`);
      const bot = new BilibiliDmBot(ctx, config, this.service);
      const sessionFile = getDataFilePath(ctx, selfId, `${selfId}.cookie.json`);

      // 检查是否存在cookie文件，如果存在则删除
      try
      {
        if (existsSync(sessionFile))
        {
          logInfo(`删除旧的cookie文件: ${sessionFile}`);
          await fs.unlink(sessionFile);
        }
      } catch (error)
      {
        loggerError(`删除cookie文件失败: `, error);
      }

      // 启动登录流程
      logInfo(`开始启动登录流程...`);
      const loginSuccess = await this.service.startLogin(bot, sessionFile);
      if (!loginSuccess)
      {
        // 登录失败时只清理临时机器人，保留插件和前端错误状态。
        await bot.dispose();
      }

      return { selfId };
    };
    ctx.console.addListener(loginEventName, loginListener);
    ctx.on('dispose', () =>
    {
      // console 监听器不属于插件作用域，需要手动移除。
      if (ctx.console.listeners[loginEventName]?.callback === loginListener)
      {
        delete ctx.console.listeners[loginEventName];
      }
    });
  }

  // 更新状态并刷新前端
  getService(): BilibiliService
  {
    return this.service;
  }

  updateStatus(status: BotStatus): void
  {
    if (!status.selfId)
    {
      logInfo('updateStatus: selfId为空，无法更新状态');
      return;
    }

    // 每个 launcher 只接受自己账号的状态，防止多开实例串线。
    if (String(status.selfId) !== String(this.selfId))
    {
      logInfo(`忽略其他实例状态: ${status.selfId}，当前实例: ${this.selfId}`);
      return;
    }

    logInfo(`BilibiliLauncher更新状态: ${status.selfId} -> ${status.status}`);

    this.consoleMessages[status.selfId] = {
      ...status,
      selfId: status.selfId
    };

    // 刷新前端
    this.refresh();
  }

  // 获取控制台消息
  async get()
  {
    const currentStatus = this.consoleMessages[this.selfId];
    const statusData: BotStatus = currentStatus || {
      status: 'init',
      selfId: this.selfId,
      message: '正在获取登录状态...'
    };

    // 记录当前获取的状态
    logInfo(`前端请求状态数据，当前状态: ${statusData.status}, 消息: ${statusData.message}`);

    // 如果有二维码，记录日志
    /*
    if (statusData.status === 'qrcode' && statusData.image)
    {
      if (statusData.status === 'qrcode' && statusData.image)
      {
        logInfo(`返回二维码数据给前端，图片数据长度: ${status.image.length} 字节`);
      }
    });
    */

    /*
    Object.keys(statusData).forEach(selfId =>
    {
      if (statusData[selfId])
      {
        if (!statusData[selfId].selfId)
        {
          statusData[selfId].selfId = selfId;
        }
        // 确保状态对象包含所有必要的字段
        if (!statusData[selfId].status)
        {
          logInfo(`状态对象缺少status字段，设置为init`);
          statusData[selfId].status = 'init';
        }
        if (!statusData[selfId].message)
        {
          statusData[selfId].message = '正在初始化...';
        }
      }
    });
    */

    return statusData;
  }
}

export function apply(ctx: Context, config: PluginConfig)
{
  registerBilibiliMediaProxyRoute(ctx);
  const serviceId = `console.services.bilibili-dm-${config.selfId}`;
  const existingLauncher = ctx.get(serviceId) as BilibiliLauncher | undefined;
  if (existingLauncher)
  {
    // 同一个 selfId 已有前端服务时，避免重复注册和重复启动机器人。
    logger.info(`Bilibili ${config.selfId} 已存在前端服务，跳过重复初始化。`);
    return;
  }

  // 初始化全局函数
  logInfo = (message: any, ...args: any[]) =>
  {
    if (config.loggerinfo)
    {
      devlogger.info(message, ...args);
    }
  };
  loggerInfo = (message: any, ...args: any[]) =>
  {
    logger.info(message, ...args);
  };
  loggerError = (message: any, ...args: any[]) =>
  {
    // 如果传入的是数字，认为是B站错误码
    if (typeof message === 'number')
    {
      const errorMessage = getBilibiliErrorMessage(message);
      logger.error(`错误码 [${message}]: ${errorMessage}`, ...args);
    } else
    {
      logger.error(message, ...args);
    }
  };
  loginfolive = (message: any, ...args: any[]) =>
  {
    if (config.loggerLiveInfo)
    {
      devlogger.info(`[直播间] ${message}`, ...args);
    }
  };

  // 创建服务
  const service = new BilibiliService(ctx, config);

  // Entry 绑定当前作用域，卸载插件时自动移除。
  ctx.console.addEntry({
    dev: resolve(__dirname, '../client/index.ts'),
    prod: resolve(__dirname, '../dist'),
  });

  // 直接绑定当前作用域，避免 ready 回调延迟创建重复服务。
  logInfo(`创建BilibiliLauncher实例，selfId: ${config.selfId}`);
  const launcher = new BilibiliLauncher(ctx, service, config);
  service.setLauncher(launcher);

  ctx.plugin(BilibiliDmAdapter, {
    ...config,
    selfId: config.selfId,
    service,
  });

  ctx.on('dispose', () =>
  {
    logInfo(`插件正在停用，执行清理操作`);
    service.markAsDisposed();
    // 机器人由适配器的 dispose 统一停止，避免重复调用。
    logInfo(`插件停用完成，机器人交由适配器清理`);
  });
  logger.info(`Bilibili 私信适配器启动。`);
}
