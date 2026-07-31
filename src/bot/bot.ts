//  src\bot.ts
import { } from '@koishijs/plugin-notifier';

import { Bot, Context, h, Fragment, Universal } from 'koishi';
import { BilibiliMessageEncoder } from './messageEncoder';
import { Internal } from '../bilibiliAPI/internal';
import { logInfo, loggerError } from '../index';
import { BilibiliCookie, PrivateMessage } from './types';
import { BilibiliCommentNotification, BilibiliCommentTarget } from '../bilibiliAPI/apis/comment';
import { PluginConfig } from './types';
import { HttpClient } from './http';
import { shouldBlockMessage } from './utils';

declare module 'koishi' {
  interface Context
  {
    internal: Internal;
  }

  interface Events
  {
    'bilibili/live'(data: {
      id: string;
      uid: string;
      name: string;
      avatar: string;
      timestamp: number;
      action: string;
      type: string;
      room_id: string;
      title: string;
      cover: string;
      jump_url: string;
    }): void;
    'bilibili/dynamic'(data: {
      id: string;
      uid: string;
      name: string;
      avatar: string;
      timestamp: number;
      action: string;
      type: string;
      text: string;
      jump_url: string;
      cover: string;
      title?: string;
      description?: string;
      bvid?: string;
      aid?: string;
      images?: string[];
      cvid?: number;
    }): void;
    'bilibili/live-chat'(data: {
      roomId: number;
      roomInfo: {
        title: string;
        uname: string;
        face: string;
        area_name: string;
        online: number;
      };
      message: {
        type: 'danmaku' | 'gift' | 'welcome' | 'guard_buy' | 'super_chat' | 'other' | 'interact' | 'entry_effect' | 'watched_change';
        data: any;
        timestamp: number;
        raw: any;
      };
    }): void;
  }
}

export class BilibiliDmBot extends Bot<Context, PluginConfig>
{
  static inject = ['notifier'];
  static MessageEncoder = BilibiliMessageEncoder;

  private lastPollTs: number = 0; // 毫秒
  private processedMsgIds: Map<string, number> = new Map(); // 改用 Map 存储消息ID和时间戳
  private readonly _maxCacheSize: number;
  private cleanupFunctions: Array<() => void> = [];
  private isStopping: boolean = false;
  private botOnlineTimestamp: number = 0;
  private consecutiveFailures: number = 0;
  private currentPollInterval: number;
  private readonly _msgIdExpireTime: number = 3600000; // 消息ID过期时间：1小时
  private startTask: Promise<void> | null = null;
  private loginReady = false;
  private loginCancelled = false;
  private readonly loginReadyPromise: Promise<void>;
  private resolveLoginReady!: () => void;
  private readonly commentTargets = new Map<string, BilibiliCommentTarget>();

  public readonly http: HttpClient;
  public readonly pluginConfig: PluginConfig;
  public readonly internal: Internal;

  constructor(public ctx: Context, config: PluginConfig)
  {
    super(ctx, config, 'bilibili');
    this.platform = 'bilibili';
    this.selfId = config.selfId;
    this.pluginConfig = config;

    this.user = {
      id: config.selfId,
      name: '',
      userId: config.selfId,
      avatar: '',
      username: ''
    };

    this.http = new HttpClient(this.ctx, this.pluginConfig, this);
    this.lastPollTs = Date.now() - 20 * 1000; // 获取过去20秒的消息 (毫秒)
    this._maxCacheSize = this.pluginConfig.maxCacheSize || 1000;
    this.consecutiveFailures = 0;
    this.currentPollInterval = this.pluginConfig.pollInterval;
    this.loginReadyPromise = new Promise(resolve =>
    {
      this.resolveLoginReady = resolve;
    });

    this.internal = new Internal(this, this.ctx);

    logInfo(`BilibiliDmBot实例创建完成，准备启动`);
  }

  addCleanup(fn: () => void)
  {
    this.cleanupFunctions.push(fn);
  }

  markLoginReady(): void
  {
    if (this.loginReady) return;
    this.loginReady = true;
    this.resolveLoginReady();
  }

  cancelLogin(): void
  {
    this.loginCancelled = true;
    this.markLoginReady();
  }

  private handlePollSuccess()
  {
    if (this.consecutiveFailures > 0)
    {
      logInfo(`轮询恢复正常，重置失败计数 (之前连续失败 ${this.consecutiveFailures} 次)`);
      this.consecutiveFailures = 0;
      this.currentPollInterval = this.pluginConfig.pollInterval;
    }
  }

  private handlePollFailure()
  {
    this.consecutiveFailures++;

    if (this.consecutiveFailures >= this.pluginConfig.pollAutoShutdownThreshold)
    {
      loggerError(`连续轮询失败 ${this.consecutiveFailures} 次，达到自动关闭阈值 (${this.pluginConfig.pollAutoShutdownThreshold})，即将关闭插件`);
      this.autoShutdown();
      return;
    }

    if (this.consecutiveFailures >= this.pluginConfig.pollFailureThreshold)
    {
      // 增加轮询间隔，最大不超过原间隔的5倍
      const multiplier = Math.min(Math.floor(this.consecutiveFailures / this.pluginConfig.pollFailureThreshold) + 1, 5);
      this.currentPollInterval = this.pluginConfig.pollInterval * multiplier;
      loggerError(`连续轮询失败 ${this.consecutiveFailures} 次，已增加轮询间隔至 ${this.currentPollInterval}ms (原间隔: ${this.pluginConfig.pollInterval}ms)`);
    } else
    {
      loggerError(`连续轮询失败 ${this.consecutiveFailures} 次`);
    }
  }

  private async autoShutdown()
  {
    try
    {
      // 创建通知器
      const notifier = this.ctx.notifier?.create();
      if (notifier)
      {
        let countdown = 6;

        const notify = () => notifier.update(`<p>插件 adapter-bilibili-dm (ID: ${this.selfId}) 因连续轮询失败将在 ${countdown} 秒后关闭……</p><p>失败原因可能是 Cookie 失效或网络问题</p>`);

        while (--countdown > 0)
        {
          notify();
          try
          {
            await this.ctx.sleep(1000);
          } catch
          {
            return; // 如果上下文已停用，直接返回
          }
        }
      } else
      {
        // 如果没有通知器，直接等待3秒
        try
        {
          await this.ctx.sleep(3000);
        } catch
        {
          return;
        }
      }

      // 关闭插件
      loggerError(`正在关闭插件...`);
      this.ctx.scope.dispose();

    } catch (error)
    {
      loggerError(`自动关闭插件过程中发生错误: `, error);
      // 即使出错也要尝试关闭
      try
      {
        this.ctx.scope.dispose();
      } catch (disposeError)
      {
        loggerError(`强制关闭插件失败: `, disposeError);
      }
    }
  }
  // #region basic API
  private startPolling(): void
  {
    logInfo(`开始设置轮询定时器...`);

    if (!this.http.hasCookies())
    {
      logInfo(`警告：启动轮询时cookie未验证，将延迟启动轮询`);
      try
      {
        this.ctx.setTimeout(() =>
        {
          if (!this.http.isDisposed && !this.isStopping)
          {
            logInfo(`延迟后再次尝试启动轮询...`);
            this.startPolling();
          } else
          {
            logInfo(`插件已停用或正在停止，跳过延迟后的轮询启动`);
          }
        }, 5000);
      } catch (err)
      {
        if (err.code === 'INACTIVE_EFFECT')
        {
          logInfo(`上下文已不活跃，跳过设置延迟轮询定时器`);
          this.http.isDisposed = true;
        } else
        {
          loggerError(`设置延迟轮询定时器时出错: `, err);
        }
      }
      return;
    }

    logInfo(`cookie已验证，开始设置轮询定时器`);
    this.startContinuousPolling();
  }

  private startDynamicPolling(): void
  {
    if (!this.pluginConfig.enableDynamicPolling)
    {
      logInfo(`动态监听已禁用`);
      return;
    }

    logInfo(`开始设置动态监听定时器...`);

    if (!this.http.hasCookies())
    {
      logInfo(`警告：启动动态监听时cookie未验证，将延迟启动动态监听`);
      try
      {
        this.ctx.setTimeout(() =>
        {
          if (!this.http.isDisposed && !this.isStopping)
          {
            logInfo(`延迟后再次尝试启动动态监听...`);
            this.startDynamicPolling();
          } else
          {
            logInfo(`插件已停用或正在停止，跳过延迟后的动态监听启动`);
          }
        }, 5000);
      } catch (err)
      {
        if (err.code === 'INACTIVE_EFFECT')
        {
          logInfo(`上下文已不活跃，跳过设置延迟动态监听定时器`);
        } else
        {
          loggerError(`设置延迟动态监听定时器时出错: `, err);
        }
      }
      return;
    }

    // 将秒转换为毫秒
    const dynamicIntervalSeconds = this.pluginConfig.dynamicPollInterval || 60;
    const dynamicInterval = dynamicIntervalSeconds * 1000;

    logInfo(`cookie已验证，启动动态监听，轮询间隔: ${dynamicIntervalSeconds}秒 (${dynamicInterval}ms)`);
    this.internal.startDynamicPolling(dynamicInterval);
  }

  private startLivePolling(): void
  {
    if (!this.pluginConfig.enableLivePolling)
    {
      logInfo(`直播监听已禁用`);
      return;
    }

    logInfo(`开始设置直播监听定时器...`);

    if (!this.http.hasCookies())
    {
      logInfo(`警告：启动直播监听时cookie未验证，将延迟启动直播监听`);
      try
      {
        this.ctx.setTimeout(() =>
        {
          if (!this.http.isDisposed && !this.isStopping)
          {
            logInfo(`延迟后再次尝试启动直播监听...`);
            this.startLivePolling();
          } else
          {
            logInfo(`插件已停用或正在停止，跳过延迟后的直播监听启动`);
          }
        }, 5000);
      } catch (err)
      {
        if (err.code === 'INACTIVE_EFFECT')
        {
          logInfo(`上下文已不活跃，跳过设置延迟直播监听定时器`);
        } else
        {
          loggerError(`设置延迟直播监听定时器时出错: `, err);
        }
      }
      return;
    }

    // 将秒转换为毫秒
    const liveIntervalSeconds = this.pluginConfig.livePollInterval || 30;
    const liveInterval = liveIntervalSeconds * 1000;

    logInfo(`cookie已验证，启动直播监听，轮询间隔: ${liveIntervalSeconds}秒 (${liveInterval}ms)`);
    this.internal.startLivePolling(liveInterval);
  }

  private startCommentPolling(): void
  {
    if (this.pluginConfig.enableCommentPolling === false)
    {
      logInfo('评论通知监听已禁用');
      return;
    }
    if (!this.http.hasCookies())
    {
      logInfo('启动评论通知监听时 cookie 尚未验证，跳过本次启动');
      return;
    }

    const interval = (this.pluginConfig.commentPollInterval || 30) * 1000;
    this.internal.startCommentPolling(interval);
  }

  private startContinuousPolling(): void
  {
    if (!this.online || this.isStopping || this.http.isDisposed)
    {
      return;
    }

    try
    {
      const intervalId = this.ctx.setInterval(async () =>
      {
        if (!this.online || this.isStopping || this.http.isDisposed)
        {
          return;
        }

        try
        {
          await this.poll();
        } catch (err)
        {
          if (err.code === 'INACTIVE_EFFECT')
          {
            logInfo(`关闭过程中，跳过轮询。`);
            return;
          }
          loggerError(`轮询过程中发生错误: `, err);
        }
      }, this.currentPollInterval);

      // 一次清理函数
      this.addCleanup(() =>
      {
        try
        {
          intervalId();
          logInfo(`轮询定时器已清除`);
        } catch (err)
        {
          loggerError(`清除轮询定时器时出错: `, err);
        }
      });
    } catch (err)
    {
      loggerError(`设置轮询定时器时出错: `, err);
    }
  }

  private async poll()
  {
    if (!this.online || this.isStopping)
    {
      logInfo(`机器人不在线或正在停止，跳过轮询`);
      return;
    }

    try
    {
      const pollTs = Date.now(); // 毫秒
      const newSessionsData = await this.http.getNewSessions(this.lastPollTs);

      if (this.isStopping)
      {
        logInfo(`机器人正在停止，在获取会话数据后跳过后续轮询处理。`);
        return;
      }

      if (!newSessionsData)
      {
        // 轮询失败，增加失败计数
        this.handlePollFailure();
        return;
      }

      // 轮询成功，重置失败计数和轮询间隔
      this.handlePollSuccess();

      if (!newSessionsData.session_list?.length)
      {
        // 如果会话列表为空，也更新 lastPollTs，确保下次从当前时间开始轮询
        this.lastPollTs = pollTs;
        return;
      }

      for (const session of newSessionsData.session_list)
      {
        if (session.unread_count > 0)
        {
          logInfo(`发现用户 ${session.talker_id} 的新消息(未读数: ${session.unread_count})`);
          const messageData = await this.http.fetchSessionMessages(
            session.talker_id,
            session.session_type,
            session.ack_seqno,
          );

          if (this.isStopping)
          {
            logInfo(`机器人正在停止，在获取消息数据后跳过后续轮询处理。`);
            return;
          }

          if (messageData?.messages)
          {
            logInfo(`获取到 ${messageData.messages.length} 条消息`);
            for (const msg of messageData.messages.reverse())
            {
              // 如果开启了忽略离线消息，并且消息时间戳早于机器人上线时间，则跳过
              if (this.pluginConfig.ignoreOfflineMessages && msg.timestamp * 1000 < this.botOnlineTimestamp)
              {
                logInfo(`跳过离线期间的消息(UID: ${msg.sender_uid}, MsgKey: ${msg.msg_key})`);
                continue;
              }
              try
              {
                await this.adaptMessage(msg, session.session_type, session.talker_id);
              } catch (error)
              {
                loggerError(`处理消息 ${msg.msg_key} 失败: `, error);
              }
            }
          }
          await this.http.updateAck(session.talker_id, session.session_type, session.max_seqno);
        }
      }
      // 在处理完所有会话后，更新 lastPollTs 为当前轮询时间
      this.lastPollTs = pollTs;
    } catch (error)
    {
      if (error.code === 'INACTIVE_EFFECT')
      {
        logInfo(`关闭过程中，跳过轮询。`);
        return;
      }
      loggerError(`轮询过程中发生错误: % o`, error);
      // 轮询异常，也算作失败
      this.handlePollFailure();
    }
  }

  /**
   * 根据消息来源获取消息前缀
   */
  private getMessagePrefix(msgSource?: number): string | null
  {
    if (!msgSource) return null;

    switch (msgSource)
    {
      case 5:
        return '[官方推送消息]';
      case 6:
        return '[推送/通知消息]';
      case 8:
        return '[此条消息为自动回复]'; // 自动回复 - 被关注回复
      case 9:
        return '[此条消息为自动回复]'; // 自动回复 - 收到消息回复
      case 10:
        return '[此条消息为自动回复]'; // 自动回复 - 关键词回复
      case 11:
        return '[此条消息为自动回复]'; // 自动回复 - 大航海上船回复
      case 12:
        return '[UP主赠言]'; // 自动推送 - UP主赠言
      case 13:
        return '[粉丝团系统提示]';
      case 16:
        return '[系统消息]';
      case 17:
        return '[系统消息]'; // 互相关注
      case 18:
        return '[系统提示]';
      case 19:
        return '[AI回复]';
      default:
        return null;
    }
  }

  private async adaptMessage(msg: PrivateMessage, sessionType: number, talkerId: number)
  {
    if (String(msg.sender_uid) === this.selfId) return;

    logInfo(`收到私信，消息ID: ${msg.msg_key}，发送者: ${msg.sender_uid}，原始内容: ${msg.content}`);

    // 屏蔽的UID检查
    const senderUid = msg.sender_uid;
    if (this.pluginConfig.nestedblocked.blockedUids &&
      shouldBlockMessage(senderUid, this.pluginConfig.nestedblocked.blockedUids))
    {
      return;
    }

    const msgId = msg.msg_key;
    if (this.processedMsgIds.has(msgId))
    {
      logInfo(`跳过已处理的消息: ${msgId} `);
      return;
    }

    // 使用 Map 存储消息ID和时间戳，便于按时间清理
    this.processedMsgIds.set(msgId, Date.now());

    // 当缓存超过限制时，删除最旧的条目
    if (this.processedMsgIds.size > this._maxCacheSize)
    {
      // 找到最旧的条目并删除
      let oldestId: string | null = null;
      let oldestTime = Infinity;

      for (const [id, timestamp] of this.processedMsgIds.entries())
      {
        if (timestamp < oldestTime)
        {
          oldestTime = timestamp;
          oldestId = id;
        }
      }

      if (oldestId)
      {
        this.processedMsgIds.delete(oldestId);
        logInfo(`清理旧消息ID: ${oldestId}, 当前缓存大小: ${this.processedMsgIds.size}`);
      }
    }

    let contentFragment: Fragment;
    try
    {
      const parsedContent = JSON.parse(msg.content);
      switch (msg.msg_type)
      {
        case 1:
          let textContent = parsedContent.content;
          // 根据消息来源添加标识
          const messagePrefix = this.getMessagePrefix(msg.msg_source);
          if (messagePrefix)
          {
            textContent = `${messagePrefix} ${textContent}`;
          }
          contentFragment = h.parse(textContent);
          break;
        case 2:
          contentFragment = h('image', { url: parsedContent.url });
          break;
        case 5:
          contentFragment = h('text', { content: `[消息已撤回]` });
          break;
        default:
          logInfo(`不支持的消息类型: ${msg.msg_type}, 内容: ${msg.content} `);
          contentFragment = `[Unsupported message type: ${msg.msg_type}]`;
          break;
      }
    } catch (e)
    {
      loggerError(`解析消息内容失败: ${msg.content}, 错误: `, e);
      contentFragment = '[消息解析失败]';
    }

    if (!contentFragment) return;

    // 获取用户信息 - 确保 userId 为字符串类型
    const user = await this.getUser(String(msg.sender_uid));

    const session = this.session({
      type: 'message',
      timestamp: msg.timestamp * 1000, // 毫秒
      channel: {
        id: sessionType === 1 ? `private:${talkerId}` : `${talkerId}`,
        type: sessionType === 1 ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT,
      },
      user,
      message: {
        id: msg.msg_key,
        elements: h.normalize(contentFragment),
        content: h.normalize(contentFragment).join(''),
        timestamp: msg.timestamp * 1000, // 毫秒
        quote: msg.msg_status === 1 ? {
          id: msg.msg_key,
          content: '该消息已被发送者撤回',
          timestamp: msg.timestamp * 1000, // 毫秒
          user: { id: String(msg.sender_uid) }
        } : undefined,
      },
    });

    if (msg.msg_status === 1)
    {
      logInfo(`准备向 Koishi 下发消息撤回 Session，消息ID: ${msg.msg_key}`);
      this.dispatch(this.session({
        type: 'message-deleted',
        timestamp: Date.now(),
        channel: {
          id: sessionType === 1 ? `private:${talkerId}` : `${talkerId}`,
          type: sessionType === 1 ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT
        },
        user: { id: String(msg.sender_uid) },
        message: { id: msg.msg_key }
      }));
    } else
    {
      logInfo(`准备向 Koishi 下发消息 Session，消息ID: ${msg.msg_key}，内容: ${session.content || ''}`);
      this.dispatch(session);
      logInfo(`消息 Session 已下发到 Koishi，消息ID: ${msg.msg_key}`);
    }
  }

  async start()
  {
    if (this.startTask)
    {
      logInfo(`机器人 ${this.selfId} 已在启动，复用现有启动任务`);
      return this.startTask;
    }

    this.startTask = this.startInternal();
    return this.startTask;
  }

  private async startInternal()
  {
    if (!this.loginReady)
    {
      await this.loginReadyPromise;
    }
    if (this.loginCancelled || this.isStopping)
    {
      return;
    }

    logInfo(`开始启动机器人...`);
    await super.start();

    if (this.pluginConfig.ignoreOfflineMessages)
    {
      this.botOnlineTimestamp = Date.now(); // 记录机器人上线时间 (毫秒)
      logInfo(`已开启“不响应机器人离线的未读消息”功能，机器人上线时间戳已记录。`);
    }
    // 无论是否忽略离线消息，首次轮询都从当前时间开始，避免处理启动前的旧会话
    this.lastPollTs = Date.now(); // 毫秒
    logInfo(`lastPollTs 已设置为当前时间，确保从最新会话开始轮询。`);

    if (!this.http.hasCookies())
    {
      logInfo(`警告：启动机器人时cookie未设置，可能导致轮询失败`);
      this.status = Universal.Status.DISCONNECT;
    } else
    {
      logInfo(`cookie已设置，准备开始轮询`);
      this.status = Universal.Status.ONLINE;
    }

    this.ctx.setTimeout(() =>
    {
      if (this.isStopping || this.http.isDisposed)
      {
        return;
      }

      this.startPolling();
      this.startDynamicPolling();
      this.startLivePolling();
      this.startCommentPolling();
      this.startMessageIdCleanup(); // 启动消息ID清理定时器

      logInfo(`轮询已启动，机器人状态: ${this.status}`);
    }, 2000);

    logInfo(`机器人启动完成，状态: ${this.status}`);
  }

  async stop()
  {
    this.cancelLogin();
    this.isStopping = true;
    this.status = Universal.Status.DISCONNECT;
    logInfo(`正在停止机器人...`);

    // 停止动态监听
    if (this.internal.isPollingActive())
    {
      logInfo(`停止动态监听`);
      this.internal.stopDynamicPolling();
    }

    // 停止直播监听
    if (this.internal.isLivePollingActive())
    {
      logInfo(`停止直播监听`);
      this.internal.stopLivePolling();
    }

    if (this.internal.isCommentPollingActive())
    {
      logInfo('停止评论通知监听');
      this.internal.stopCommentPolling();
    }

    logInfo(`执行清理函数，数量: ${this.cleanupFunctions.length} `);
    for (const cleanup of this.cleanupFunctions)
    {
      try
      {
        cleanup();
      } catch (err)
      {
        loggerError(`执行清理函数时出错: `, err);
      }
    }
    this.cleanupFunctions = [];

    // 清空消息ID缓存
    this.processedMsgIds.clear();
    this.commentTargets.clear();
    logInfo(`已清空消息ID缓存`);

    await super.stop();
    this.startTask = null;
  }

  /**
   * 启动消息ID定期清理
   */
  private startMessageIdCleanup(): void
  {
    try
    {
      // 每10分钟清理一次过期的消息ID
      const cleanupIntervalId = this.ctx.setInterval(() =>
      {
        if (!this.online || this.isStopping)
        {
          return;
        }

        const now = Date.now();
        let cleanedCount = 0;

        // 删除超过1小时的消息ID
        for (const [id, timestamp] of this.processedMsgIds.entries())
        {
          if (now - timestamp > this._msgIdExpireTime)
          {
            this.processedMsgIds.delete(id);
            cleanedCount++;
          }
        }

        if (cleanedCount > 0)
        {
          logInfo(`定期清理: 删除了 ${cleanedCount} 个过期消息ID，当前缓存大小: ${this.processedMsgIds.size}`);
        }
      }, 600000); // 10分钟

      this.addCleanup(() =>
      {
        try
        {
          cleanupIntervalId();
          logInfo(`消息ID清理定时器已清除`);
        } catch (err)
        {
          loggerError(`清除消息ID清理定时器时出错: `, err);
        }
      });
    } catch (err)
    {
      loggerError(`设置消息ID清理定时器时出错: `, err);
    }
  }

  async saveCookie(cookie: BilibiliCookie)
  {
    if (this.ctx.bilibili_dm_service)
    {
      await this.ctx.bilibili_dm_service.saveCookie(this.selfId, cookie);
    }
  }

  async getSelf(): Promise<Universal.User>
  {
    return {
      id: this.selfId,
      name: this.user.name || '',
      avatar: this.user.avatar || '',
      username: this.user.username || ''
    };
  }

  async getUser(userId: string): Promise<Universal.User>
  {
    try
    {
      const userInfo = await this.http.getUser(userId);
      return {
        id: userId,
        name: userInfo?.nickname || '',
        avatar: userInfo?.avatar || '',
        username: userInfo?.nickname || ''
      };
    } catch (error)
    {
      loggerError(`获取用户信息失败: ${userId}`, error);
      return {
        id: userId,
        name: '未知用户',
        avatar: '',
        username: '未知用户'
      };
    }
  }

  /**
   * 创建私聊频道
   * @param userId 用户ID
   * @returns 频道信息
   */
  async createDirectChannel(userId: string)
  {
    return { id: `private:${userId}`, type: Universal.Channel.Type.DIRECT };
  }

  /**
   * 获取登录信息
   * @returns 登录信息
   */
  toJSON(): Universal.Login
  {
    const login = super.toJSON();
    const avatarUrl = this.http.getMyAvatarUrl();
    return {
      ...login,
      user: {
        ...login.user,
        avatar: avatarUrl || login.user.avatar,
      },
    };
  }

  async getLogin()
  {
    return this.toJSON();
  }

  /**
   * 获取好友列表
   * @returns 好友列表
   */
  async getFriendList()
  {
    // Bilibili 私信没有传统意义上的好友列表，这里返回空列表
    return { data: [] };
  }

  async sendMessage(channelId: string, content: Fragment): Promise<string[]>
  {
    const [type, talkerId] = channelId.split(':');
    if (!talkerId || !['private', 'video', 'opus'].includes(type)) return [];

    logInfo(content);

    const processedContent = this.preprocessContent(content);

    const encoder = new BilibiliMessageEncoder(this, channelId, undefined, {});
    const messages = await encoder.send(processedContent);

    return messages.map(message => message.id).filter(id => id !== undefined) as string[];
  }

  async sendComment(channelId: string, content: string): Promise<string | null>
  {
    const target = this.commentTargets.get(channelId);
    return this.internal.sendComment(channelId, content, target);
  }

  async receiveComment(notification: BilibiliCommentNotification): Promise<void>
  {
    if (String(notification.userId) === this.selfId) return;
    if (!notification.content)
    {
      logInfo(`忽略空评论通知: ${notification.id}`);
      return;
    }

    this.commentTargets.set(notification.channelId, {
      oid: notification.oid,
      type: notification.type,
      rpid: notification.rpid,
      root: notification.root,
      parent: notification.parent,
    });

    const user = {
      id: notification.userId,
      name: notification.userName,
      username: notification.userName,
      avatar: notification.userAvatar,
    };
    const session = this.session({
      type: 'message',
      timestamp: notification.timestamp,
      channel: {
        id: notification.channelId,
        type: Universal.Channel.Type.TEXT,
      },
      user,
      message: {
        id: notification.id,
        content: notification.content,
        elements: this.parseCommentContent(notification.content, notification.mentions),
        timestamp: notification.timestamp,
        quote: notification.parent !== notification.rpid ? {
          id: String(notification.parent),
          content: '',
          timestamp: notification.timestamp,
          user: { id: this.selfId },
        } : undefined,
      },
    });

    logInfo(`收到评论通知，频道: ${notification.channelId}，用户: ${notification.userId}，内容: ${notification.content}`);
    this.dispatch(session);
    logInfo(`评论 Session 已下发到 Koishi，消息ID: ${notification.id}`);
  }

  private parseCommentContent(content: string, mentions: BilibiliCommentNotification['mentions']): h[]
  {
    const candidates = [...mentions];
    const botName = this.user.name?.trim();
    if (botName && !candidates.some(mention => mention.name === botName))
    {
      candidates.push({ id: this.selfId, name: botName });
    }
    if (!candidates.length) return h.normalize(content);

    candidates.sort((left, right) => right.name.length - left.name.length);
    const escapedNames = candidates.map(mention => mention.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const mentionPattern = new RegExp(`@(${escapedNames.join('|')})(?:[ \\t]+|$)`, 'g');
    const elements: h[] = [];
    let cursor = 0;
    for (const match of content.matchAll(mentionPattern))
    {
      const name = match[1];
      const mention = candidates.find(item => item.name === name);
      if (!mention || match.index === undefined) continue;

      if (match.index > cursor) elements.push(h.text(content.slice(cursor, match.index)));
      elements.push(h.at(mention.id, { name: mention.name }));
      cursor = match.index + match[0].length;
    }

    if (!elements.length) return h.normalize(content);
    if (cursor < content.length) elements.push(h.text(content.slice(cursor)));
    return elements;
  }

  private preprocessContent(content: Fragment): Fragment
  {
    if (typeof content === 'string')
    {
      return content;
    }

    if (Array.isArray(content))
    {
      return content.map(item => this.preprocessContent(item)).filter(item => item !== null) as Fragment;
    }

    if (content && typeof content === 'object' && 'type' in content)
    {
      const element = content as h;

      // 如果是 i18n 元素，尝试手动渲染它
      if (element.type === 'i18n')
      {
        try
        {
          const path = element.attrs?.path;
          if (path && this.ctx.i18n)
          {
            const locales = this.ctx.i18n.fallback([]);
            try
            {
              const text = this.ctx.i18n.text(locales, [path], element.attrs || {});
              if (text && typeof text === 'string')
              {
                return h('text', { content: text });
              }
            } catch (e)
            {
            }
          }
          return h('text', { content: `[${element.attrs?.path || 'i18n'}]` });
        } catch (error)
        {
          // 渲染失败时返回占位符
          return h('text', { content: `[${element.attrs?.path || 'i18n'}]` });
        }
      }

      // 递归处理子元素
      if (element.children && element.children.length > 0)
      {
        const processedChildren = element.children
          .map(child => this.preprocessContent(child))
          .filter(child => child !== null) as Fragment[];

        return h(element.type, element.attrs, ...processedChildren);
      }

      return element;
    }

    return content;
  }

  async sendPrivateMessage(userId: string, content: Fragment): Promise<string[]>
  {
    return this.sendMessage(`private:${userId}`, content);
  }

  async getMessage(channelId: string, messageId: string): Promise<Universal.Message | undefined>
  {
    logInfo(`尝试获取 ${channelId} 中的消息 ${messageId}`);
    const [type, talkerIdStr] = channelId.split(':');
    const talkerId = Number(talkerIdStr);
    const sessionType = type === 'private' ? 1 : 0;

    const newSessionsData = await this.http.getNewSessions(0);
    if (!newSessionsData || !newSessionsData.session_list)
    {
      loggerError(`获取会话列表失败，无法获取消息 ${messageId}`);
      return undefined;
    }

    const sessionInfo = newSessionsData.session_list.find(s => s.talker_id === talkerId && s.session_type === sessionType);
    if (!sessionInfo)
    {
      loggerError(`未找到与 ${channelId} 匹配的会话信息，无法获取消息 ${messageId}`);
      return undefined;
    }

    const messageData = await this.http.fetchSessionMessages(talkerId, sessionType, 0);
    if (!messageData || !messageData.messages)
    {
      loggerError(`获取会话 ${talkerId} 的消息失败，无法获取消息 ${messageId}`);
      return undefined;
    }

    const targetMsg = messageData.messages.find(msg => msg.msg_key === messageId);
    if (!targetMsg)
    {
      loggerError(`在会话 ${talkerId} 消息中未找到消息 ${messageId}`);
      return undefined;
    }

    let contentFragment: Fragment;
    try
    {
      const parsedContent = JSON.parse(targetMsg.content);
      switch (targetMsg.msg_type)
      {
        case 1:
          contentFragment = h.parse(parsedContent.content);
          break;
        case 2:
          contentFragment = h('image', { url: parsedContent.url });
          break;
        case 5:
          contentFragment = h('text', { content: `[消息已撤回]` });
          break;
        default:
          loggerError(`不支持的消息类型: ${targetMsg.msg_type}, 内容: ${targetMsg.content}`);
          contentFragment = `[Unsupported message type: ${targetMsg.msg_type}]`;
          break;
      }
    } catch (e)
    {
      loggerError(`解析消息内容失败: ${targetMsg.content}, 错误: `, e);
      contentFragment = '[消息解析失败]';
    }

    const user = await this.getUser(String(targetMsg.sender_uid));

    const message: Universal.Message = {
      id: targetMsg.msg_key,
      elements: h.normalize(contentFragment),
      content: h.normalize(contentFragment).join(''),
      user,
      timestamp: targetMsg.timestamp * 1000,
      channel: {
        id: channelId,
        type: sessionType === 1 ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT,
      }
    };

    logInfo(`成功获取消息 ${messageId}`);
    return message;
  }

  /**
   * 获取消息列表
   * @param channelId 频道ID
   * @param next 分页参数
   * @param direction 方向
   * @param limit 限制数量
   * @param order 排序
   * @returns 消息列表
   */
  async getMessageList(channelId: string, next?: string, direction: Universal.Direction = 'before', limit?: number, order?: Universal.Order)
  {
    logInfo(`尝试获取 ${channelId} 中的消息列表`);
    const [type, talkerIdStr] = channelId.split(':');
    const talkerId = Number(talkerIdStr);
    const sessionType = type === 'private' ? 1 : 0;

    // 获取消息列表，这里简化实现，只获取最新的消息
    const newSessionsData = await this.http.getNewSessions(0);
    if (!newSessionsData || !newSessionsData.session_list)
    {
      loggerError(`获取会话列表失败，无法获取消息列表`);
      return { data: [] };
    }

    const sessionInfo = newSessionsData.session_list.find(s => s.talker_id === talkerId && s.session_type === sessionType);
    if (!sessionInfo)
    {
      loggerError(`未找到与 ${channelId} 匹配的会话信息，无法获取消息列表`);
      return { data: [] };
    }

    const messageData = await this.http.fetchSessionMessages(talkerId, sessionType, 0);
    if (!messageData || !messageData.messages)
    {
      loggerError(`获取会话 ${talkerId} 的消息失败，无法获取消息列表`);
      return { data: [] };
    }

    // 处理消息列表
    const messages: Universal.Message[] = [];
    for (const msg of messageData.messages)
    {
      let contentFragment: Fragment;
      try
      {
        const parsedContent = JSON.parse(msg.content);
        switch (msg.msg_type)
        {
          case 1:
            contentFragment = h.parse(parsedContent.content);
            break;
          case 2:
            contentFragment = h('image', { url: parsedContent.url });
            break;
          case 5:
            contentFragment = h('text', { content: `[消息已撤回]` });
            break;
          default:
            loggerError(`不支持的消息类型: ${msg.msg_type}, 内容: ${msg.content}`);
            contentFragment = `[Unsupported message type: ${msg.msg_type}]`;
            break;
        }
      } catch (e)
      {
        loggerError(`解析消息内容失败: ${msg.content}, 错误: `, e);
        contentFragment = '[消息解析失败]';
      }

      const user = await this.getUser(String(msg.sender_uid));

      messages.push({
        id: msg.msg_key,
        elements: h.normalize(contentFragment),
        content: h.normalize(contentFragment).join(''),
        user,
        timestamp: msg.timestamp * 1000,
        channel: {
          id: channelId,
          type: sessionType === 1 ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT,
        }
      });
    }

    // 根据方向和排序参数处理消息列表
    if (order === 'asc')
    {
      messages.reverse();
    }

    // 限制返回数量
    if (limit && messages.length > limit)
    {
      if (direction === 'before')
      {
        messages.splice(limit);
      } else
      {
        messages.splice(0, messages.length - limit);
      }
    }

    logInfo(`成功获取消息列表，共 ${messages.length} 条消息`);
    return { data: messages };
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void>
  {
    logInfo(`尝试在 ${channelId} 撤回 ${messageId} `);
    const [type, talkerIdStr] = channelId.split(':');
    const talkerId = Number(talkerIdStr);
    const msgContent = messageId;
    logInfo(`deleteMessage: msgContent = ${msgContent} `);
    const msgKey = await this.http.sendMessage(this.selfId, talkerId, msgContent, 5);
    if (msgKey)
    {
      logInfo(`成功发送撤回消息指令给 ${talkerId}，msg_key: ${msgKey} `);
    } else
    {
      loggerError(`发送撤回消息指令失败给 ${talkerId}，msg_key: ${messageId} `);
    }
  }

  // #region 直播间相关方法

  /**
   * 进入指定直播间
   * @param roomId 直播间ID
   */
  async enterLiveRoom(roomId: number): Promise<void>
  {
    // 如果已经在其他直播间，先退出
    const currentRoomId = this.internal.getCurrentLiveRoomId();
    if (currentRoomId && currentRoomId !== roomId)
    {
      logInfo(`已在直播间 ${currentRoomId} 中，先退出`);
      await this.leaveLiveRoom();
    }

    logInfo(`尝试进入直播间 ${roomId}`);
    try
    {
      await this.internal.enterLiveRoom(roomId);
      logInfo(`成功进入直播间 ${roomId}`);
    } catch (error)
    {
      loggerError(`进入直播间 ${roomId} 失败:`, error);
      throw error;
    }
  }

  /**
   * 退出当前直播间
   */
  async leaveLiveRoom(): Promise<void>
  {
    const currentRoomId = this.internal.getCurrentLiveRoomId();
    if (currentRoomId)
    {
      logInfo(`尝试退出直播间 ${currentRoomId}`);
      try
      {
        await this.internal.leaveLiveRoom();
        logInfo(`成功退出直播间 ${currentRoomId}`);
      } catch (error)
      {
        loggerError(`退出直播间 ${currentRoomId} 失败:`, error);
        throw error;
      }
    } else
    {
      logInfo(`当前未在任何直播间中`);
    }
  }

  /**
   * 获取当前所在的直播间ID
   */
  getCurrentLiveRoomId(): number | null
  {
    return this.internal.getCurrentLiveRoomId();
  }

  /**
   * 检查是否已连接到直播间
   */
  isConnectedToLiveRoom(): boolean
  {
    return this.internal.isConnectedToLiveRoom();
  }
}
