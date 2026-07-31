//  src\index.ts
import { getBilibiliErrorMessage } from './bilibiliAPI/temp_error_codes';
import { DataService } from '@koishijs/plugin-console';
import { BilibiliDmAdapter } from './bot/adapter';
import { BilibiliTestPlugin } from './test/test';
import { BilibiliService } from './bot/service';
import { PluginConfig } from './bot/types';
import { BilibiliDmBot } from './bot/bot';
import { Context, Logger, sleep } from 'koishi';
import { Config } from './bot/schema';

import { promises as fs, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDataFilePath } from './bot/utils';

export let loggerError: (message: any, ...args: any[]) => void;
export let loggerInfo: (message: any, ...args: any[]) => void;
export let logInfo: (message: any, ...args: any[]) => void;
export let loginfolive: (message: any, ...args: any[]) => void;

let isConsoleEntryAdded = false;

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
    bilibili_dm_service: BilibiliService;
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
export class BilibiliLauncher extends DataService<Record<string, BotStatus>>
{
  private currentBot: string;
  private consoleMessages: Record<string, BotStatus> = {};
  readonly serviceId: string;

  constructor(ctx: Context, private service: BilibiliService, config: PluginConfig)
  {
    const serviceId = `bilibili-dm-${config.selfId}`;
    super(ctx, serviceId as keyof import('@koishijs/plugin-console').Console.Services);
    this.serviceId = serviceId;
    this.currentBot = config.selfId;

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

    // 前端发来的登录请求
    const loginEventName = `bilibili-dm-${config.selfId}/start-login` as const;

    ctx.console.addListener(loginEventName, async (data: { selfId: string; }) =>
    {
      const selfId = data.selfId || config.selfId;
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
      const bot = new BilibiliDmBot(ctx, config);
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
      await this.service.startLogin(bot, sessionFile);

      return { selfId };
    });
  }

  // 更新状态并刷新前端
  updateStatus(status: BotStatus): void
  {
    if (!status.selfId)
    {
      logInfo('updateStatus: selfId为空，无法更新状态');
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
    const statusData = this.consoleMessages;

    // 记录当前获取的状态
    logInfo(`前端请求状态数据，当前状态: ${JSON.stringify(statusData[this.currentBot]?.status)}, 消息: ${statusData[this.currentBot]?.message}`);

    // 如果有二维码，记录日志
    Object.values(statusData).forEach(status =>
    {
      if (status.status === 'qrcode' && status.image)
      {
        logInfo(`返回二维码数据给前端，图片数据长度: ${status.image.length} 字节`);
      }
    });

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

    return statusData;
  }
}

export function apply(ctx: Context, config: PluginConfig)
{

  ctx.on('ready', async () =>
  {

    if (process.env.NODE_ENV === 'development' && !__dirname.includes('node_modules'))
    {
      await sleep(1 * 1000);  // 神秘步骤，可以保佑dev模式
      // ctx.plugin(BilibiliTestPlugin)
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

    ctx.bilibili_dm_service = service;

    if (!isConsoleEntryAdded)
    {
      isConsoleEntryAdded = true;
      ctx.console.addEntry({
        dev: resolve(__dirname, '../client/index.ts'),
        prod: resolve(__dirname, '../dist'),
      });
    }

    // 创建 launcher 实例并保存引用
    let launcher: BilibiliLauncher;
    ctx.plugin({
      name: `bilibili-launcher-${config.selfId}`,
      apply: (ctx) =>
      {
        logInfo(`创建BilibiliLauncher实例，selfId: ${config.selfId}`);
        launcher = new BilibiliLauncher(ctx, service, config);
        // 将 launcher 引用传递给 service
        service.setLauncher(launcher);
        return launcher;
      }
    });

    ctx.plugin(BilibiliDmAdapter, {
      ...config,
      selfId: config.selfId
    });

    ctx.on('dispose', () =>
    {
      isConsoleEntryAdded = false;
      logInfo(`插件正在停用，执行清理操作`);

      try
      {
        // 标记服务为已停用状态
        service.markAsDisposed();

        // 找到当前插件实例对应的机器人并停止它
        const botToStop = ctx.bots.find(bot => bot.platform === 'bilibili' && bot.selfId === config.selfId);

        if (botToStop)
        {
          logInfo(`正在停止当前插件实例对应的机器人: ${botToStop.selfId}`);
          try
          {
            botToStop.stop();
            botToStop.offline(); // 确保机器人状态为离线
            logInfo(`机器人 ${botToStop.selfId} 已停止并设置为离线`);
            botToStop.dispose(); // 彻底移除机器人实例
            logInfo(`机器人 ${botToStop.selfId} 已被彻底移除`);
          } catch (err)
          {
            logger.error(`停止机器人 ${botToStop.selfId} 失败: ${err.message}`);
          }
        } else
        {
          logInfo(`未找到当前插件实例对应的机器人，无需停止。`);
        }

        logInfo(`插件停用完成`);
      } catch (err)
      {
        logger.error(`插件停用过程中发生错误: ${err.message}`);
      }
    });

  });

  logger.info(`Bilibili 私信适配器启动。`);
}
