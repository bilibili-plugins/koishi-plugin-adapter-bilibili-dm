// src\bilibiliAPI\apis\live.ts
import { loginfolive, loggerError } from '../../index';
import { BilibiliDmBot } from '../../bot/bot';
import { Context } from 'koishi';
import
{
  BilibiliResponse,
  LiveEventData,
  LiveUser,
  LivePortalResponse,
  LiveSummary
} from './types';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataFilePath } from '../../bot/utils';

export class LiveAPI
{
  private bot: BilibiliDmBot;
  private ctx: Context;
  private pollIntervalId: (() => void) | null = null;
  private isPolling: boolean = false;
  private pollInterval: number = 30000; // 默认30秒轮询一次

  // 存储当前直播状态
  private currentLiveUsers: LiveSummary[] = [];

  // 数据持久化路径
  private dataFilePath: string;

  constructor(bot: BilibiliDmBot, ctx: Context)
  {
    this.bot = bot;
    this.ctx = ctx;

    // 设置数据文件路径
    this.dataFilePath = getDataFilePath(ctx, this.bot.selfId, 'bilibili-live', 'current-live-users.json');

    // 加载持久化数据
    this.loadCurrentLiveUsers();
  }

  /**
   * 确保数据目录存在
   */
  private ensureDataDir(): void
  {
    const dir = path.dirname(this.dataFilePath);
    if (!fs.existsSync(dir))
    {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 加载当前直播用户数据
   */
  private loadCurrentLiveUsers(): void
  {
    try
    {
      this.ensureDataDir();
      if (fs.existsSync(this.dataFilePath))
      {
        const data = fs.readFileSync(this.dataFilePath, 'utf-8');
        const parsed = JSON.parse(data);
        this.currentLiveUsers = parsed.currentLiveUsers || [];
        loginfolive(`加载了 ${this.currentLiveUsers.length} 个当前直播用户记录`);
      }
    } catch (error)
    {
      loggerError('加载当前直播用户数据失败:', error);
      this.currentLiveUsers = [];
    }
  }

  /**
   * 保存当前直播用户数据
   */
  private saveCurrentLiveUsers(): void
  {
    try
    {
      this.ensureDataDir();
      const data = {
        currentLiveUsers: this.currentLiveUsers,
        updateTime: Date.now()
      };
      fs.writeFileSync(this.dataFilePath, JSON.stringify(data, null, 2));
    } catch (error)
    {
      loggerError('保存当前直播用户数据失败:', error);
    }
  }

  /**
   * 生成直播用户的hash
   */
  private generateLiveUserHash(liveUser: LiveUser): string
  {
    // 组合关键信息生成hash
    const keyInfo = {
      mid: liveUser.mid,
      room_id: liveUser.room_id,
      title: liveUser.title,
      uname: liveUser.uname
    };

    return crypto.createHash('md5').update(JSON.stringify(keyInfo)).digest('hex');
  }

  /**
   * 将直播用户转换为摘要信息
   */
  private liveUserToSummary(liveUser: LiveUser): LiveSummary
  {
    return {
      mid: liveUser.mid,
      uname: liveUser.uname,
      room_id: liveUser.room_id,
      title: liveUser.title,
      hash: this.generateLiveUserHash(liveUser),
      timestamp: Date.now()
    };
  }

  /**
   * 获取当前正在直播的UP主列表
   * @returns Promise<LiveUser[] | null> 正在直播的UP主列表，网络错误时返回null
   */
  async getLiveUsers(): Promise<LiveUser[] | null>
  {
    loginfolive('尝试获取当前正在直播的UP主列表');
    try
    {
      // 检查上下文和HTTP客户端是否仍然活跃
      if (!this.ctx.scope.isActive || this.bot.http.isDisposed)
      {
        loginfolive('上下文或HTTP客户端已停用，跳过获取直播列表');
        return [];
      }

      const res: BilibiliResponse<LivePortalResponse> = await this.bot.http.http.get(
        'https://api.bilibili.com/x/polymer/web-dynamic/v1/portal',
        {
          params: {
            up_list_more: 1,
            web_location: '333.1365'
          },
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          }
        }
      );

      if (res.code === 0)
      {
        const liveUsers = res.data?.live_users?.items || [];
        if (liveUsers.length > 0)
        {
          loginfolive(`成功获取 ${liveUsers.length} 个正在直播的UP主`);
        } else
        {
          loginfolive(`当前没有UP主在直播 (Code: ${res.code})`);
        }
        return liveUsers;
      } else
      {
        loggerError(`获取直播列表失败: ${res.message} (Code: ${res.code})`);
        return [];
      }
    } catch (error)
    {
      // 如果是上下文停用错误，不记录错误
      if (error.code === 'INACTIVE_EFFECT')
      {
        loginfolive('上下文已停用，跳过获取直播列表');
        return [];
      }
      loggerError('获取直播列表时发生错误: ', error);
      // 网络错误时返回null，表示无法确定当前状态
      return null;
    }
  }

  /**
   * 开始监听直播状态更新
   * @param interval 轮询间隔（毫秒），默认30秒
   */
  startLivePolling(interval: number = 30000): void
  {
    if (this.isPolling)
    {
      loginfolive('直播监听已在运行中');
      return;
    }

    // 检查上下文是否仍然活跃
    if (!this.ctx.scope.isActive || this.bot.http.isDisposed)
    {
      loginfolive('上下文已停用，无法启动直播监听');
      return;
    }

    this.pollInterval = interval;
    this.isPolling = true;

    loginfolive(`开始监听直播状态更新，轮询间隔: ${interval}ms`);

    // 异步初始化当前直播列表，但不等待完成
    this.initializeCurrentLiveUsers().catch(error =>
    {
      if (error.code !== 'INACTIVE_EFFECT')
      {
        loggerError('初始化当前直播列表失败: ', error);
      }
    });

    // 再次检查上下文是否仍然活跃（初始化过程中可能已停用）
    if (!this.ctx.scope.isActive || this.bot.http.isDisposed)
    {
      loginfolive('初始化过程中上下文已停用，停止启动直播监听');
      this.isPolling = false;
      return;
    }

    try
    {
      // 设置定时轮询，使用 Koishi 的定时器管理
      this.pollIntervalId = this.ctx.setInterval(async () =>
      {
        // 检查上下文是否仍然活跃
        if (this.ctx.scope.isActive)
        {
          await this.checkForLiveStatusChanges();
        } else
        {
          loginfolive('上下文已停用，停止直播监听');
          this.stopLivePolling();
        }
      }, this.pollInterval);
    } catch (error)
    {
      if (error.message?.includes('inactive context'))
      {
        loginfolive('上下文已停用，无法创建定时器');
        this.isPolling = false;
        return;
      }
      loggerError('创建直播监听定时器时发生错误: ', error);
      this.isPolling = false;
    }
  }

  /**
   * 停止监听直播状态更新
   */
  stopLivePolling(): void
  {
    if (!this.isPolling)
    {
      return;
    }

    if (this.pollIntervalId)
    {
      this.pollIntervalId();
      this.pollIntervalId = null;
    }

    this.isPolling = false;

    // 清理数据以释放内存
    this.currentLiveUsers = [];

    loginfolive('已停止直播监听并清理缓存');
  }

  /**
   * 初始化当前直播列表
   */
  private async initializeCurrentLiveUsers(): Promise<void>
  {
    try
    {
      // 检查上下文是否仍然活跃
      if (!this.ctx.scope.isActive || this.bot.http.isDisposed)
      {
        loginfolive('上下文已停用，跳过初始化');
        return;
      }

      loginfolive('正在初始化当前直播列表...');

      // 获取当前直播列表
      const liveUsers = await this.getLiveUsers();

      // 如果获取失败，不进行初始化
      if (liveUsers === null)
      {
        loginfolive('由于网络错误无法获取直播列表，跳过初始化');
        return;
      }

      if (liveUsers.length === 0)
      {
        loginfolive('初始化完成：当前没有UP主在直播');
        this.currentLiveUsers = [];
        this.saveCurrentLiveUsers();
        return;
      }

      // 转换为摘要信息
      this.currentLiveUsers = liveUsers.map(user => this.liveUserToSummary(user));

      // 保存到文件
      this.saveCurrentLiveUsers();

      loginfolive(`初始化当前直播列表完成，共 ${this.currentLiveUsers.length} 个UP主正在直播，即将打印前5个进行视检：`);

      // 输出当前直播的UP主信息用于调试
      this.currentLiveUsers.slice(0, 5).forEach((summary, index) =>
      {
        loginfolive(`  ${index + 1}. ${summary.uname} (${summary.mid}) - 房间号: ${summary.room_id} - ${summary.title}`);
      });

    } catch (error)
    {
      // 如果是上下文停用错误，不记录错误
      if (error.code === 'INACTIVE_EFFECT')
      {
        loginfolive('上下文已停用，跳过初始化');
        return;
      }
      loggerError('初始化当前直播列表时发生错误: ', error);
    }
  }

  /**
   * 检查直播状态变化
   */
  private async checkForLiveStatusChanges(): Promise<void>
  {
    try
    {
      // 检查上下文是否仍然活跃
      if (!this.ctx.scope.isActive || this.bot.http.isDisposed)
      {
        loginfolive('上下文已停用，跳过直播状态检查');
        return;
      }

      loginfolive('开始检查直播状态变化...');

      // 获取当前直播列表
      const currentLiveUsers = await this.getLiveUsers();

      // 如果获取失败，跳过本次检查
      if (currentLiveUsers === null)
      {
        loginfolive('由于网络错误无法获取直播列表，跳过本次状态检查');
        return;
      }

      const currentSummaries = currentLiveUsers.map(user => this.liveUserToSummary(user));

      loginfolive(`获取到 ${currentSummaries.length} 个正在直播的UP主，开始比对...`);

      // 检查新开播的UP主
      const newLiveUsers: LiveUser[] = [];
      for (let i = 0; i < currentSummaries.length; i++)
      {
        const currentSummary = currentSummaries[i];
        const existingIndex = this.currentLiveUsers.findIndex(existing => existing.mid === currentSummary.mid);

        if (existingIndex === -1)
        {
          // 这是一个新开播的UP主
          newLiveUsers.push(currentLiveUsers[i]);
          loginfolive(`发现新开播: ${currentSummary.uname} (${currentSummary.mid}) - ${currentSummary.title}`);
        } else
        {
          // 检查直播内容是否有变化（标题等）
          const existingSummary = this.currentLiveUsers[existingIndex];
          if (existingSummary.hash !== currentSummary.hash)
          {
            // 直播信息有更新（比如标题变了）
            loginfolive(`发现直播信息更新: ${currentSummary.uname} (${currentSummary.mid}) - ${currentSummary.title}`);
            // 触发直播更新事件
            await this.emitLiveUpdateEvent(currentLiveUsers[i]);
          }
        }
      }

      // 检查下播的UP主
      const endedLiveUsers: LiveSummary[] = [];
      for (const existingSummary of this.currentLiveUsers)
      {
        const stillLive = currentSummaries.find(current => current.mid === existingSummary.mid);
        if (!stillLive)
        {
          // 这个UP主已经下播了
          endedLiveUsers.push(existingSummary);
          loginfolive(`发现下播: ${existingSummary.uname} (${existingSummary.mid})`);
        }
      }

      // 触发新开播事件
      if (newLiveUsers.length > 0)
      {
        loginfolive(`总共发现 ${newLiveUsers.length} 个新开播的UP主`);
        for (const liveUser of newLiveUsers)
        {
          await this.emitLiveStartEvent(liveUser);
          // 添加小延迟避免事件处理过快
          await this.ctx.sleep(100);
        }
      }

      // 触发下播事件
      if (endedLiveUsers.length > 0)
      {
        loginfolive(`总共发现 ${endedLiveUsers.length} 个下播的UP主`);
        for (const endedUser of endedLiveUsers)
        {
          await this.emitLiveEndEvent(endedUser);
          // 添加小延迟避免事件处理过快
          await this.ctx.sleep(100);
        }
      }

      if (newLiveUsers.length === 0 && endedLiveUsers.length === 0)
      {
        loginfolive('未发现直播状态变化');
      }

      // 更新当前直播列表
      this.currentLiveUsers = currentSummaries;
      this.saveCurrentLiveUsers();

    } catch (error)
    {
      // 如果是上下文停用错误，停止轮询
      if (error.code === 'INACTIVE_EFFECT')
      {
        loginfolive('上下文已停用，停止直播监听');
        this.stopLivePolling();
        return;
      }
      loggerError('检查直播状态变化时发生错误: ', error);
    }
  }

  /**
   * 触发开播事件
   */
  private async emitLiveStartEvent(liveUser: LiveUser): Promise<void>
  {
    try
    {
      // 检查上下文是否仍然活跃
      if (!this.ctx.scope.isActive || this.bot.http.isDisposed)
      {
        loginfolive('上下文已停用，跳过事件触发');
        return;
      }

      // 构建事件数据
      const eventData: LiveEventData = {
        type: 'live_start',
        user: {
          mid: liveUser.mid,
          uname: liveUser.uname,
          face: liveUser.face
        },
        room: {
          room_id: liveUser.room_id,
          title: liveUser.title,
          jump_url: liveUser.jump_url
        },
        timestamp: Date.now(),
        rawData: liveUser
      };

      loginfolive(`触发开播事件: UP主 ${liveUser.uname} (${liveUser.mid}) 开始直播 - ${liveUser.title}`);

      // 触发通用直播事件
      this.ctx.emit('bilibili/live-update' as keyof import('koishi').Events, eventData);

      // 触发开播事件
      this.ctx.emit('bilibili/live-start' as keyof import('koishi').Events, eventData);

    } catch (error)
    {
      // 如果是上下文停用错误，不记录错误
      if (error.code === 'INACTIVE_EFFECT')
      {
        loginfolive('上下文已停用，跳过事件触发');
        return;
      }
      loggerError('触发开播事件时发生错误: ', error);
    }
  }

  /**
   * 触发下播事件
   */
  private async emitLiveEndEvent(endedUser: LiveSummary): Promise<void>
  {
    try
    {
      // 检查上下文是否仍然活跃
      if (!this.ctx.scope.isActive || this.bot.http.isDisposed)
      {
        loginfolive('上下文已停用，跳过事件触发');
        return;
      }

      // 构建事件数据
      const eventData: LiveEventData = {
        type: 'live_end',
        user: {
          mid: endedUser.mid,
          uname: endedUser.uname,
          face: '' // 下播时没有头像信息
        },
        room: {
          room_id: endedUser.room_id,
          title: endedUser.title,
          jump_url: `https://live.bilibili.com/${endedUser.room_id}`
        },
        timestamp: Date.now(),
        rawData: endedUser
      };

      loginfolive(`触发下播事件: UP主 ${endedUser.uname} (${endedUser.mid}) 结束直播`);

      // 触发通用直播事件
      this.ctx.emit('bilibili/live-update' as keyof import('koishi').Events, eventData);

      // 触发下播事件
      this.ctx.emit('bilibili/live-end' as keyof import('koishi').Events, eventData);

    } catch (error)
    {
      // 如果是上下文停用错误，不记录错误
      if (error.code === 'INACTIVE_EFFECT')
      {
        loginfolive('上下文已停用，跳过事件触发');
        return;
      }
      loggerError('触发下播事件时发生错误: ', error);
    }
  }

  /**
   * 触发直播信息更新事件
   */
  private async emitLiveUpdateEvent(liveUser: LiveUser): Promise<void>
  {
    try
    {
      // 检查上下文是否仍然活跃
      if (!this.ctx.scope.isActive || this.bot.http.isDisposed)
      {
        loginfolive('上下文已停用，跳过事件触发');
        return;
      }

      // 构建事件数据
      const eventData: LiveEventData = {
        type: 'live_update',
        user: {
          mid: liveUser.mid,
          uname: liveUser.uname,
          face: liveUser.face
        },
        room: {
          room_id: liveUser.room_id,
          title: liveUser.title,
          jump_url: liveUser.jump_url
        },
        timestamp: Date.now(),
        rawData: liveUser
      };

      loginfolive(`触发直播更新事件: UP主 ${liveUser.uname} (${liveUser.mid}) 更新直播信息`);

      // 触发通用直播事件
      this.ctx.emit('bilibili/live-update' as keyof import('koishi').Events, eventData);

      // 触发直播信息更新事件
      this.ctx.emit('bilibili/live-info-update' as keyof import('koishi').Events, eventData);

    } catch (error)
    {
      // 如果是上下文停用错误，不记录错误
      if (error.code === 'INACTIVE_EFFECT')
      {
        loginfolive('上下文已停用，跳过事件触发');
        return;
      }
      loggerError('触发直播更新事件时发生错误: ', error);
    }
  }

  /**
   * 获取监听状态
   */
  isPollingActive(): boolean
  {
    return this.isPolling;
  }

  /**
   * 设置轮询间隔
   */
  setPollInterval(interval: number): void
  {
    this.pollInterval = interval;

    if (this.isPolling)
    {
      // 重启轮询以应用新间隔
      this.stopLivePolling();
      this.startLivePolling(interval);
    }
  }

  /**
   * 获取当前直播用户摘要（用于调试）
   */
  getCurrentLiveUsersSummary(): LiveSummary[]
  {
    return this.currentLiveUsers.slice();
  }

  /**
   * 手动触发一次检查
   */
  async manualCheck(): Promise<void>
  {
    if (!this.ctx.scope.isActive || this.bot.http.isDisposed)
    {
      loginfolive('上下文已停用，无法执行手动检查');
      return;
    }

    if (!this.isPolling)
    {
      loginfolive('直播监听未启动，无法执行手动检查');
      return;
    }

    loginfolive('执行手动直播状态检查...');
    await this.checkForLiveStatusChanges();
  }

  /**
   * 获取指定UP主的直播状态
   */
  async getUserLiveStatus(mid: number): Promise<LiveUser | null>
  {
    const liveUsers = await this.getLiveUsers();
    if (liveUsers === null)
    {
      // 网络错误时无法确定状态
      return null;
    }
    return liveUsers.find(user => user.mid === mid) || null;
  }

  /**
   * 检查指定UP主是否正在直播
   */
  async isUserLive(mid: number): Promise<boolean | null>
  {
    const liveUsers = await this.getLiveUsers();
    if (liveUsers === null)
    {
      // 网络错误时无法确定状态
      return null;
    }
    return liveUsers.some(user => user.mid === mid);
  }
}
