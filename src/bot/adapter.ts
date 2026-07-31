//  src\adapter.ts
import { logInfo, loggerError, loggerInfo } from './../index';
import { BilibiliService } from './service';
import { Adapter, Context } from 'koishi';
import { PluginConfig } from './types';
import { BilibiliDmBot } from './bot';

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getDataFilePath } from './utils';

export class BilibiliDmAdapter extends Adapter<Context, BilibiliDmBot>
{
  static immediate = true;
  private service: BilibiliService;
  constructor(ctx: Context, public config: PluginConfig)
  {
    super(ctx);

    this.service = ctx.bilibili_dm_service;

    logInfo(`适配器初始化，selfId: ${this.config.selfId}`);
    ctx.server.get('/bilibili-dm/status', async (ctx) =>
    {
      const status = this.service.getStatus();

      const requestedSelfId = ctx.query.selfId as string;
      if (requestedSelfId && status[requestedSelfId])
      {
        ctx.body = { [requestedSelfId]: status[requestedSelfId] };
        return;
      }
      ctx.body = status;
    });
  }

  async start()
  {
    // 登录统一由 fork 流程处理，避免重复创建二维码轮询任务。
  }

  async fork(parent?: Context, config?: any, error?: any)
  {
    const actualConfig = config || this.config;
    const selfId = actualConfig.selfId || this.config.selfId;

    logInfo(`开始fork过程，当前机器人ID: ${selfId}`);

    const sessionFile = getDataFilePath(this.ctx, selfId, `${selfId}.cookie.json`);
    const hasCacheFile = await fs.access(sessionFile).then(() => true).catch(() => false);

    logInfo(`开始fork过程，缓存文件存在: ${hasCacheFile}`);

    this.service.updateStatus(selfId, {
      status: 'init',
      selfId: selfId,
      message: '正在获取登录状态...'
    });
    logInfo(`登录状态检查已开始，缓存文件存在: ${hasCacheFile}`);

    logInfo(`直接启动机器人...`);
    await this.startBot(actualConfig);

    return this;
  }

  async dispose()
  {
    logInfo('正在停止 Bilibili 私信适配器...');

    try
    {
      if (this.service)
      {
        // 先同步当前实例的离线状态，再阻止后续业务更新。
        const selfIds = new Set<string>([this.config.selfId]);
        for (const bot of this.bots) selfIds.add(bot.selfId);
        for (const selfId of selfIds) this.service.setBotOffline(selfId);
        this.service.markAsDisposed();
        logInfo('适配器正在停止，已标记服务为已停用状态');
      }

      logInfo(`准备停止 ${this.bots.length} 个机器人实例`);
      await Promise.all(this.bots.map(async (bot) =>
      {
        try
        {
          logInfo(`正在停止机器人 ${bot.selfId}...`);
          await bot.stop();
          logInfo(`机器人 ${bot.selfId} 已停止`);
        } catch (err)
        {
          loggerError(`停止机器人 ${bot.selfId} 时出错:`, err);
        }
      }));

      logInfo('所有机器人已停止，适配器停止完成');
    } catch (err)
    {
      loggerError(`停止适配器时发生错误: `, err);
    }
  }

  async startBot(pluginConfig: PluginConfig)
  {
    const bot = new BilibiliDmBot(this.ctx, pluginConfig);

    logInfo(`正在启动机器人...`);

    const sessionFile = getDataFilePath(this.ctx, pluginConfig.selfId, `${pluginConfig.selfId}.cookie.json`);
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });

    try
    {
      const loginSuccess = await this.service.startLogin(bot, sessionFile);

      if (loginSuccess)
      {
        logInfo(`登录成功，添加到机器人列表`);
        this.bots.push(bot);
      } else
      {
        logInfo(`登录流程未完成，保留现有错误状态`);
        const loginStatus = this.service.getStatus()[pluginConfig.selfId];
        if (loginStatus?.status !== 'error')
        {
          loggerError(`登录流程未完成，但未返回具体错误状态`);
          this.service.updateStatus(pluginConfig.selfId, {
            status: 'error',
            message: '登录失败，请查看后端日志'
          });
        }
        await bot.dispose();
      }
    } catch (error)
    {
      loggerError(`机器人启动失败，错误详情: `, error);
      this.service.updateStatus(pluginConfig.selfId, {
        status: 'error',
        message: `启动失败: ${error.message || '未知错误'}`
      });
      await bot.dispose();
    }
  }
}
