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
    logInfo('Bilibili 私信适配器启动中...');
    const dataDir = getDataFilePath(this.ctx, this.config.selfId);
    await fs.mkdir(dataDir, { recursive: true });
    logInfo(`数据目录已确保存在: ${dataDir}`);

    const selfId = this.config.selfId;
    logInfo(`正在启动机器人: ${selfId}`);

    const bot = new BilibiliDmBot(this.ctx, this.config);
    this.bots.push(bot);

    const sessionFile = getDataFilePath(this.ctx, selfId, `${selfId}.cookie.json`);
    logInfo(`机器人 ${selfId} 的会话文件路径: ${sessionFile}`);

    // 启动登录流程
    const loginSuccess = await this.service.startLogin(bot, sessionFile);
    if (loginSuccess)
    {
      logInfo(`机器人 ${selfId} 登录成功。`);
    } else
    {
      logInfo(`机器人 ${selfId} 登录失败。`);
    }
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

    const hasCacheFile = await fs.access(sessionFile).then(() => true).catch(() => false);

    if (hasCacheFile)
    {
      try
      {
        const cookieData = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
        logInfo(`从缓存文件加载cookie，数据长度: ${JSON.stringify(cookieData).length}`);
        bot.http.setCookies(cookieData);

        const userInfo = await bot.http.getMyInfo();
        if (userInfo.isValid)
        {
          logInfo(`缓存cookie有效，用户名: ${userInfo.nickname}`);
          bot.http.setCookieVerified(true);
          logInfo(`已设置cookie验证标志为true`);
        } else
        {
          logInfo(`缓存cookie无效，需要重新登录`);
          bot.http.setCookieVerified(false);
        }
      } catch (error)
      {
        loggerError(`读取缓存cookie失败: `, error);
      }
    }

    try
    {
      const loginSuccess = await this.service.startLogin(bot, sessionFile);

      if (loginSuccess)
      {
        logInfo(`登录成功，添加到机器人列表`);
        this.bots.push(bot);
      } else
      {
        logInfo(`登录失败`);
        this.service.updateStatus(pluginConfig.selfId, {
          status: 'error',
          message: '登录失败，请重试'
        });
        bot.offline();
      }
    } catch (error)
    {
      loggerError(`机器人启动失败，错误详情: `, error);
      this.service.updateStatus(pluginConfig.selfId, {
        status: 'error',
        message: `启动失败: ${error.message || '未知错误'}`
      });
      bot.offline();
    }
  }
}
