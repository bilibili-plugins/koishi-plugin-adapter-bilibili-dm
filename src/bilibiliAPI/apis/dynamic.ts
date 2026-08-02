// src\bilibiliAPI\apis\dynamic.ts
import { loginfolive, loggerError } from '../../index';
import { BilibiliDmBot } from '../../bot/bot';
import { Context } from 'koishi';
import
{
  DynamicItem,
  DynamicFeedResponse,
  DynamicDetailResponse,
  BilibiliResponse,
  DynamicEventData,
  DynamicSummary
} from './types';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataFilePath } from '../../bot/utils';

export class DynamicAPI
{
  private bot: BilibiliDmBot;
  private ctx: Context;
  private pollIntervalId: (() => void) | null = null;
  private isPolling: boolean = false;
  private pollInterval: number = 60000; // 默认1分钟轮询一次
  private lastDynamicBaseline: string = '0';

  // 存储最近的动态摘要信息
  private recentDynamics: DynamicSummary[] = [];
  private maxRecentCount: number = 15; // 存储最近15条动态的摘要

  // 数据持久化路径
  private dataFilePath: string;

  constructor(bot: BilibiliDmBot, ctx: Context)
  {
    this.bot = bot;
    this.ctx = ctx;

    // 设置数据文件路径
    this.dataFilePath = getDataFilePath(ctx, this.bot.selfId, 'bilibili-dynamic', 'recent-dynamics.json');

    // 加载持久化数据
    this.loadRecentDynamics();
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
   * 加载最近动态数据
   */
  private loadRecentDynamics(): void
  {
    try
    {
      this.ensureDataDir();
      if (fs.existsSync(this.dataFilePath))
      {
        const data = fs.readFileSync(this.dataFilePath, 'utf-8');
        const parsed = JSON.parse(data);
        this.recentDynamics = parsed.recentDynamics || [];
        this.lastDynamicBaseline = parsed.lastBaseline || '0';
        loginfolive(`加载了 ${this.recentDynamics.length} 条最近动态记录`);
      }
    } catch (error)
    {
      loggerError('加载最近动态数据失败:', error);
      this.recentDynamics = [];
    }
  }

  /**
   * 保存最近动态数据
   */
  private saveRecentDynamics(): void
  {
    try
    {
      this.ensureDataDir();
      const data = {
        recentDynamics: this.recentDynamics,
        lastBaseline: this.lastDynamicBaseline,
        updateTime: Date.now()
      };
      fs.writeFileSync(this.dataFilePath, JSON.stringify(data, null, 2));
    } catch (error)
    {
      loggerError('保存最近动态数据失败:', error);
    }
  }

  /**
   * 生成动态内容的hash
   */
  private generateDynamicHash(dynamic: DynamicItem): string
  {
    const author = dynamic.modules.module_author;
    const content = dynamic.modules.module_dynamic;

    // 组合关键信息生成hash
    const keyInfo = {
      id: dynamic.id_str,
      authorUid: author.mid,
      authorName: author.name,
      type: dynamic.type,
      timestamp: author.pub_ts,
      text: content.desc?.text || '',
      majorType: content.major?.type || ''
    };

    return crypto.createHash('md5').update(JSON.stringify(keyInfo)).digest('hex');
  }

  /**
   * 将动态转换为摘要信息
   */
  private dynamicToSummary(dynamic: DynamicItem): DynamicSummary
  {
    const author = dynamic.modules.module_author;

    return {
      id: dynamic.id_str,
      authorUid: author.mid,
      authorName: author.name,
      type: dynamic.type,
      timestamp: author.pub_ts,
      hash: this.generateDynamicHash(dynamic)
    };
  }

  /**
   * 获取指定 UP 主的动态
   * @param uid UP 主的 UID
   * @param offset 分页偏移量
   * @returns Promise<DynamicItem[]> 指定 UP 主的动态列表
   */
  async getPersonalDynamics(uid: string, offset?: string): Promise<DynamicItem[]>
  {
    loginfolive(`尝试获取 UP 主 ${uid} 的个人动态`);
    try
    {
      // 检查上下文和HTTP客户端是否仍然活跃
      if (!this.ctx.scope.isActive || this.bot.http.isDisposed)
      {
        loginfolive('上下文或HTTP客户端已停用，跳过获取个人动态');
        return [];
      }
      try
      {
        const response = await (await this.bot.http.getRenmuClient()).user.space(Number(uid), offset ? Number(offset) : undefined, true);
        const feed = response as unknown as DynamicFeedResponse;
        if (feed?.items)
        {
          loginfolive(`成功获取 UP 主 ${uid} 的 ${feed.items.length} 条动态`);
          return feed.items;
        }
      }
      catch (error)
      {
        loginfolive(`新包获取 UP 主 ${uid} 动态失败，回退到原请求: ${String(error)}`);
      }

      const params: any = {
        host_mid: uid,
        timezone_offset: '-480',
        features: 'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,decorationCard,onlyfansAssetsV2,forwardListHidden,ugcDelete',
        web_location: '333.1365'
      };

      if (offset)
      {
        params.offset = offset;
      }

      const res: BilibiliResponse<DynamicFeedResponse> = await this.bot.http.http.get(
        'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space',
        {
          params,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          }
        }
      );

      if (res.code === 0 && res.data?.items)
      {
        loginfolive(`成功获取 UP 主 ${uid} 的 ${res.data.items.length} 条动态`);
        return res.data.items;
      } else
      {
        loggerError(`获取 UP 主 ${uid} 动态失败: ${res.message} (Code: ${res.code})`);
        return [];
      }
    } catch (error)
    {
      // 如果是上下文停用错误，不记录错误
      if (error.code === 'INACTIVE_EFFECT')
      {
        loginfolive('上下文已停用，跳过获取个人动态');
        return [];
      }
      loggerError(`获取 UP 主 ${uid} 动态时发生错误: `, error);
      return [];
    }
  }

  /**
   * 获取动态详情
   * @param dynamicId 动态 ID
   * @returns Promise<DynamicItem | null> 动态详情
   */
  async getDynamicDetail(dynamicId: string): Promise<DynamicItem | null>
  {
    try
    {
      // 检查上下文和HTTP客户端是否仍然活跃
      if (!this.ctx.scope.isActive || this.bot.http.isDisposed)
      {
        loginfolive('上下文或HTTP客户端已停用，跳过获取动态详情');
        return null;
      }

      const res: BilibiliResponse<DynamicDetailResponse> = await this.bot.http.http.get(
        'https://api.bilibili.com/x/polymer/web-dynamic/v1/detail',
        {
          params: {
            id: dynamicId,
            timezone_offset: '-480',
            platform: 'web',
            gaia_source: 'main_web',
            features: 'itemOpusStyle,opusBigCover,onlyfansVote,endFooterHidden,decorationCard,onlyfansAssetsV2,ugcDelete,onlyfansQaCard,commentsNewVersion',
            web_location: '333.1368'
          },
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          }
        }
      );

      if (res.code === 0 && res.data?.item)
      {
        loginfolive(`成功获取动态 ${dynamicId} 的详情`);
        return res.data.item;
      } else
      {
        loggerError(`获取动态 ${dynamicId} 详情失败: ${res.message} (Code: ${res.code})`);
        return null;
      }
    } catch (error)
    {
      // 如果是上下文停用错误，不记录错误
      if (error.code === 'INACTIVE_EFFECT')
      {
        loginfolive('上下文已停用，跳过获取动态详情');
        return null;
      }
      loggerError(`获取动态 ${dynamicId} 详情时发生错误: `, error);
      return null;
    }
  }

  /**
   * 获取所有关注的 UP 主的动态
   * @param offset 分页偏移量
   * @param updateBaseline 更新基线
   * @returns Promise<DynamicItem[]> 所有关注的 UP 主的动态列表
   */
  async getAllFollowedDynamics(offset?: string, updateBaseline?: string): Promise<DynamicItem[]>
  {
    try
    {
      // 检查上下文和HTTP客户端是否仍然活跃
      if (!this.ctx.scope.isActive || this.bot.http.isDisposed)
      {
        loginfolive('上下文或HTTP客户端已停用，跳过获取动态');
        return [];
      }

      const params: any = {
        timezone_offset: '-480',
        type: 'all',
        platform: 'web',
        features: 'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,decorationCard,onlyfansAssetsV2,forwardListHidden,ugcDelete',
        web_location: '333.1365'
      };

      if (offset)
      {
        params.offset = offset;
      }

      if (updateBaseline && updateBaseline !== '0')
      {
        params.update_baseline = updateBaseline;
      }

      const res: BilibiliResponse<DynamicFeedResponse> = await this.bot.http.http.get(
        'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all',
        {
          params,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          }
        }
      );

      if (res.code === 0 && res.data?.items)
      {
        loginfolive(`成功获取所有关注 UP 主的 ${res.data.items.length} 条动态`);

        // 更新 baseline
        if (res.data.update_baseline)
        {
          this.lastDynamicBaseline = res.data.update_baseline;
        }

        return res.data.items;
      } else
      {
        loggerError(`获取所有关注 UP 主动态失败: ${res.message} (Code: ${res.code})`);
        return [];
      }
    } catch (error)
    {
      // 如果是上下文停用错误，不记录错误
      if (error.code === 'INACTIVE_EFFECT')
      {
        loginfolive('上下文已停用，跳过获取动态');
        return [];
      }
      loggerError('获取所有关注 UP 主动态时发生错误: ', error);
      return [];
    }
  }

  /**
   * 开始监听动态更新
   * @param interval 轮询间隔（毫秒），默认60秒
   */
  startDynamicPolling(interval: number = 60000): void
  {
    if (this.isPolling)
    {
      loginfolive('动态监听已在运行中');
      return;
    }

    // 检查上下文是否仍然活跃
    if (!this.ctx.scope.isActive || this.bot.http.isDisposed)
    {
      loginfolive('上下文已停用，无法启动动态监听');
      return;
    }

    this.pollInterval = interval;
    this.isPolling = true;

    loginfolive(`开始监听动态更新，轮询间隔: ${interval}ms`);

    // 异步初始化最近动态列表，但不等待完成
    this.initializeRecentDynamics().catch(error =>
    {
      if (error.code !== 'INACTIVE_EFFECT')
      {
        loggerError('初始化最近动态列表失败: ', error);
      }
    });

    // 再次检查上下文是否仍然活跃（初始化过程中可能已停用）
    if (!this.ctx.scope.isActive || this.bot.http.isDisposed)
    {
      loginfolive('初始化过程中上下文已停用，停止启动动态监听');
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
          await this.checkForNewDynamics();
        } else
        {
          loginfolive('上下文已停用，停止动态监听');
          this.stopDynamicPolling();
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
      loggerError('创建动态监听定时器时发生错误: ', error);
      this.isPolling = false;
    }
  }

  /**
   * 停止监听动态更新
   */
  stopDynamicPolling(): void
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
    this.recentDynamics = [];

    loginfolive('已停止动态监听并清理缓存');
  }

  /**
   * 初始化最近动态列表
   */
  private async initializeRecentDynamics(): Promise<void>
  {
    try
    {
      // 检查上下文是否仍然活跃
      if (!this.ctx.scope.isActive || this.bot.http.isDisposed)
      {
        loginfolive('上下文已停用，跳过初始化');
        return;
      }

      loginfolive('正在初始化最近动态列表...');

      // 获取最新的动态列表
      const dynamics = await this.getAllFollowedDynamics();

      if (dynamics.length === 0)
      {
        loginfolive('未获取到任何动态，跳过初始化');
        return;
      }

      // 取前15条动态作为初始状态
      const recentDynamics = dynamics.slice(0, this.maxRecentCount);
      this.recentDynamics = recentDynamics.map(dynamic => this.dynamicToSummary(dynamic));

      // 保存到文件
      this.saveRecentDynamics();

      loginfolive(`初始化最近动态列表完成，共 ${this.recentDynamics.length} 条动态，即将打印前5条视检：`);

      // 输出最新几条动态的信息用于调试
      this.recentDynamics.slice(0, 5).forEach((summary, index) =>
      {
        loginfolive(`  ${index + 1}. ${summary.authorName} (${summary.authorUid}) - ${summary.type} - ${new Date(summary.timestamp * 1000).toLocaleString()}`);
      });

    } catch (error)
    {
      // 如果是上下文停用错误，不记录错误
      if (error.code === 'INACTIVE_EFFECT')
      {
        loginfolive('上下文已停用，跳过初始化');
        return;
      }
      loggerError('初始化最近动态列表时发生错误: ', error);
    }
  }

  /**
   * 检查新动态
   */
  private async checkForNewDynamics(): Promise<void>
  {
    try
    {
      // 检查上下文是否仍然活跃
      if (!this.ctx.scope.isActive || this.bot.http.isDisposed)
      {
        loginfolive('上下文已停用，跳过动态检查');
        return;
      }

      loginfolive('开始检查新动态...');

      // 获取最新的前5条动态
      const dynamics = await this.getAllFollowedDynamics();

      if (dynamics.length === 0)
      {
        loginfolive('未获取到任何动态，跳过检查');
        return;
      }

      const latestDynamics = dynamics.slice(0, 5);
      const latestSummaries = latestDynamics.map(dynamic => this.dynamicToSummary(dynamic));

      loginfolive(`获取到 ${latestSummaries.length} 条最新动态，开始比对...`);

      // 检查是否有新动态
      const newDynamics: DynamicItem[] = [];

      for (let i = 0; i < latestSummaries.length; i++)
      {
        const latestSummary = latestSummaries[i];

        // 检查这条动态是否在已知列表中
        const existingIndex = this.recentDynamics.findIndex(recent => recent.id === latestSummary.id);

        if (existingIndex === -1)
        {
          // 这是一条新动态
          newDynamics.push(latestDynamics[i]);
          loginfolive(`发现新动态: ${latestSummary.authorName} (${latestSummary.authorUid}) - ${latestSummary.type}`);
        } else
        {
          // 检查内容是否有变化（通过hash比较）
          const existingSummary = this.recentDynamics[existingIndex];
          if (existingSummary.hash !== latestSummary.hash)
          {
            // 动态内容有更新
            newDynamics.push(latestDynamics[i]);
            loginfolive(`发现动态更新: ${latestSummary.authorName} (${latestSummary.authorUid}) - ${latestSummary.type}`);
          }
        }
      }

      if (newDynamics.length > 0)
      {
        loginfolive(`总共发现 ${newDynamics.length} 条新动态或更新`);

        // 更新最近动态列表
        // 将新动态添加到列表前面，并保持最大数量限制
        const allSummaries = [...latestSummaries, ...this.recentDynamics];
        const uniqueSummaries = new Map<string, DynamicSummary>();

        // 去重，保留最新的
        allSummaries.forEach(summary =>
        {
          if (!uniqueSummaries.has(summary.id) || uniqueSummaries.get(summary.id)!.timestamp < summary.timestamp)
          {
            uniqueSummaries.set(summary.id, summary);
          }
        });

        // 按时间戳排序，取最新的
        this.recentDynamics = Array.from(uniqueSummaries.values())
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, this.maxRecentCount);

        // 清理 Map 以释放内存
        uniqueSummaries.clear();

        // 保存更新后的数据
        this.saveRecentDynamics();

        // 触发事件（按时间顺序，从旧到新）
        const sortedNewDynamics = newDynamics.sort((a, b) => a.modules.module_author.pub_ts - b.modules.module_author.pub_ts);

        for (const dynamic of sortedNewDynamics)
        {
          await this.emitDynamicEvent(dynamic);
          // 添加小延迟避免事件处理过快
          await this.ctx.sleep(100);
        }
      } else
      {
        loginfolive('未发现新动态');
      }

    } catch (error)
    {
      // 如果是上下文停用错误，停止轮询
      if (error.code === 'INACTIVE_EFFECT')
      {
        loginfolive('上下文已停用，停止动态监听');
        this.stopDynamicPolling();
        return;
      }
      loggerError('检查新动态时发生错误: ', error);
    }
  }

  /**
   * 触发动态事件
   */
  private async emitDynamicEvent(dynamic: DynamicItem): Promise<void>
  {
    try
    {
      // 检查上下文是否仍然活跃
      if (!this.ctx.scope.isActive || this.bot.http.isDisposed)
      {
        loginfolive('上下文已停用，跳过事件触发');
        return;
      }

      const author = dynamic.modules.module_author;
      const dynamicContent = dynamic.modules.module_dynamic;

      // 构建事件数据
      const eventData: DynamicEventData = {
        dynamicId: dynamic.id_str,
        type: dynamic.type,
        author: {
          uid: author.mid,
          name: author.name,
          face: author.face,
          action: author.pub_action,
          timestamp: author.pub_ts
        },
        content: this.parseDynamicContent(dynamicContent),
        rawData: dynamic
      };

      // 根据动态类型触发不同的事件
      const eventName = this.getDynamicEventName(dynamic.type);

      loginfolive(`触发动态事件: ${eventName}, UP主: ${author.name} (${author.mid})`);

      // 触发通用动态更新事件
      this.ctx.emit('bilibili/dynamic-update' as keyof import('koishi').Events, eventData);

      // 触发特定类型的动态事件
      this.ctx.emit(eventName as keyof import('koishi').Events, eventData);

    } catch (error)
    {
      // 如果是上下文停用错误，不记录错误
      if (error.code === 'INACTIVE_EFFECT')
      {
        loginfolive('上下文已停用，跳过事件触发');
        return;
      }
      loggerError('触发动态事件时发生错误: ', error);
    }
  }

  /**
   * 解析动态内容
   */
  private parseDynamicContent(dynamicContent: DynamicItem['modules']['module_dynamic']): DynamicEventData['content']
  {
    const content: DynamicEventData['content'] = {
      text: dynamicContent.desc?.text || '',
      type: dynamicContent.major?.type || 'unknown'
    };

    if (dynamicContent.major)
    {
      const major = dynamicContent.major;

      switch (major.type)
      {
        case 'MAJOR_TYPE_ARCHIVE': // 视频
          if (major.archive)
          {
            content.video = {
              aid: major.archive.aid,
              bvid: major.archive.bvid,
              title: major.archive.title,
              desc: major.archive.desc,
              cover: major.archive.cover,
              url: major.archive.jump_url
            };
          }
          break;

        case 'MAJOR_TYPE_DRAW': // 图片动态
          if (major.draw)
          {
            content.images = major.draw.items.map(item => item.src);
          }
          break;

        case 'MAJOR_TYPE_ARTICLE': // 专栏
          if (major.article)
          {
            content.article = {
              id: major.article.id,
              title: major.article.title,
              desc: major.article.desc,
              covers: major.article.covers,
              url: major.article.jump_url
            };
          }
          break;

        case 'MAJOR_TYPE_LIVE': // 直播
          if (major.live)
          {
            content.live = {
              id: major.live.id,
              title: major.live.title,
              cover: major.live.cover,
              url: major.live.jump_url,
              isLive: major.live.live_state === 1
            };
          }
          break;
      }
    }

    return content;
  }

  /**
   * 根据动态类型获取事件名称
   */
  private getDynamicEventName(dynamicType: string): string
  {
    const typeMap: Record<string, string> = {
      'DYNAMIC_TYPE_AV': 'bilibili/dynamic-video-update',
      'DYNAMIC_TYPE_DRAW': 'bilibili/dynamic-image-update',
      'DYNAMIC_TYPE_WORD': 'bilibili/dynamic-text-update',
      'DYNAMIC_TYPE_ARTICLE': 'bilibili/dynamic-article-update',
      'DYNAMIC_TYPE_LIVE_RCMD': 'bilibili/dynamic-live-update',
      'DYNAMIC_TYPE_FORWARD': 'bilibili/dynamic-forward-update',
      'DYNAMIC_TYPE_PGC': 'bilibili/dynamic-pgc-update',
      'DYNAMIC_TYPE_UGC_SEASON': 'bilibili/dynamic-ugc-season-update'
    };

    return typeMap[dynamicType] || 'bilibili/dynamic-unknown-update';
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
      this.stopDynamicPolling();
      this.startDynamicPolling(interval);
    }
  }

  /**
   * 获取当前基线
   */
  getCurrentBaseline(): string
  {
    return this.lastDynamicBaseline;
  }

  /**
   * 设置基线
   */
  setBaseline(baseline: string): void
  {
    this.lastDynamicBaseline = baseline;
  }

  /**
   * 获取最近动态摘要（用于调试）
   */
  getRecentDynamicsSummary(): DynamicSummary[]
  {
    return this.recentDynamics.slice();
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
      loginfolive('动态监听未启动，无法执行手动检查');
      return;
    }

    loginfolive('执行手动动态检查...');
    await this.checkForNewDynamics();
  }
}
