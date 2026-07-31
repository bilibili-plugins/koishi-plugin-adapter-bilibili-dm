import { Context } from 'koishi';
import { logInfo, loggerError } from '../../index';
import type { BilibiliDmBot } from '../../bot/bot';
import { BiliApiResponse } from '../../bot/types';

export interface BilibiliCommentNotification
{
  id: string;
  oid: number;
  type: 1 | 11;
  channelId: string;
  userId: string;
  userName: string;
  userAvatar: string;
  content: string;
  timestamp: number;
  rpid: number;
  root: number;
  parent: number;
}

export interface BilibiliCommentTarget
{
  oid: number;
  type: 1 | 11;
  rpid: number;
  root: number;
  parent: number;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null
{
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function readString(record: JsonRecord | null, ...keys: string[]): string
{
  if (!record) return '';
  for (const key of keys)
  {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function readNumber(record: JsonRecord | null, ...keys: string[]): number
{
  const value = readString(record, ...keys);
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function readFirstNumber(records: JsonRecord[], ...keys: string[]): number
{
  for (const record of records)
  {
    const value = readNumber(record, ...keys);
    if (value) return value;
  }
  return 0;
}

function extractOpusId(records: JsonRecord[]): string
{
  for (const record of records)
  {
    const uri = readString(record, 'uri', 'native_uri', 'jump_url', 'jumpUrl');
    const match = uri.match(/(?:\/opus\/|t\.bilibili\.com\/)(\d+)/i);
    if (match) return match[1];
  }

  const fieldId = readString(records[0], 'dynamic_id', 'dynamicId', 'opus_id', 'opusId');
  return /^\d{4,}$/.test(fieldId) ? fieldId : '';
}

function normalizeTimestamp(value: number): number
{
  if (!value) return Date.now();
  return value < 100000000000 ? value * 1000 : value;
}

function getText(records: JsonRecord[]): string
{
  const keys = [
    'source_content',
    'reply_content',
    'target_reply_content',
    'content',
    'desc',
    'message',
  ];

  for (const record of records)
  {
    const text = readString(record, ...keys);
    if (text) return text;

    const content = asRecord(record.content);
    const contentText = readString(content, 'message', 'text');
    if (contentText) return contentText;
  }
  return '';
}

function getUser(records: JsonRecord[]): { id: string; name: string; avatar: string; }
{
  for (const record of records)
  {
    const user = asRecord(record.user) || asRecord(record.member) || record;
    const id = readString(user, 'mid', 'uid', 'user_id', 'sender_uid');
    if (id)
    {
      return {
        id,
        name: readString(user, 'uname', 'name', 'username'),
        avatar: readString(user, 'face', 'avatar'),
      };
    }
  }
  return { id: '', name: '', avatar: '' };
}

export class CommentAPI
{
  private readonly bot: BilibiliDmBot;
  private readonly ctx: Context;
  private intervalId: (() => void) | null = null;
  private isPolling = false;
  private initialized = false;
  private requestActive = false;
  private readonly processedIds = new Set<string>();

  constructor(bot: BilibiliDmBot, ctx: Context)
  {
    this.bot = bot;
    this.ctx = ctx;
  }

  startPolling(interval: number): void
  {
    if (this.isPolling || !this.ctx.scope.isActive || this.bot.http.isDisposed)
    {
      return;
    }

    this.isPolling = true;
    logInfo(`开始监听评论通知，轮询间隔: ${interval}ms`);

    try
    {
      this.poll().catch(error => loggerError('首次轮询评论通知时发生错误: ', error));
      this.intervalId = this.ctx.setInterval(() =>
      {
        this.poll().catch(error =>
        {
          if (this.ctx.scope.isActive)
          {
            loggerError('轮询评论通知时发生错误: ', error);
          }
        });
      }, interval);
    } catch (error)
    {
      this.isPolling = false;
      loggerError('创建评论通知轮询定时器时发生错误: ', error);
    }
  }

  stopPolling(): void
  {
    if (this.intervalId)
    {
      this.intervalId();
      this.intervalId = null;
    }
    this.isPolling = false;
    this.initialized = false;
    this.requestActive = false;
    this.processedIds.clear();
    logInfo('评论通知轮询已停止');
  }

  isPollingActive(): boolean
  {
    return this.isPolling;
  }

  async sendComment(channelId: string, content: string, target?: BilibiliCommentTarget): Promise<string | null>
  {
    try
    {
      const [kind, value] = channelId.split(':');
      if (!value || (kind !== 'video' && kind !== 'opus')) return null;

      if (!target?.rpid)
      {
        loggerError(`无法确定 ${channelId} 的目标评论，已阻止发送一级评论`);
        return null;
      }

      const oid = target.oid;
      const type = target.type;

      if (!oid)
      {
        loggerError(`无法解析评论区 ${channelId} 的 oid`);
        return null;
      }

      logInfo(`准备回复评论，频道: ${channelId}，评论区 oid: ${oid}，评论类型: ${type}，目标评论 rpid: ${target.rpid}`);

      const reply = await this.bot.http.getRenmuClient().newReply(oid, type);
      const params: {
        message: string;
        plat: 1;
        root?: number;
        parent?: number;
      } = { message: content, plat: 1 };

      // 回复收到的评论本身，而不是给帖子发送一级评论。
      params.root = target.rpid;
      params.parent = target.rpid;

      const result = await reply.add(params);
      const resultRecord = asRecord(result);
      const replyRecord = asRecord(resultRecord?.reply);
      const rpid = readNumber(resultRecord, 'rpid') || readNumber(replyRecord, 'rpid');
      const returnedOid = readNumber(resultRecord, 'oid') || readNumber(replyRecord, 'oid');
      const returnedType = readNumber(resultRecord, 'type') || readNumber(replyRecord, 'type');
      const returnedRoot = readNumber(resultRecord, 'root') || readNumber(replyRecord, 'root');
      const returnedParent = readNumber(resultRecord, 'parent') || readNumber(replyRecord, 'parent');

      if (rpid && returnedOid === oid && returnedType === type
        && returnedRoot === target.rpid && returnedParent === target.rpid)
      {
        logInfo(`评论回复发送成功，频道: ${channelId}，目标评论: ${target.rpid}，评论ID: ${rpid}`);
        return String(rpid);
      }
      loggerError(`评论回复返回结果校验失败，频道: ${channelId}，目标评论: ${target.rpid}，返回数据: ${JSON.stringify(result)}`);
      return null;
    } catch (error)
    {
      loggerError(`发送评论失败，频道: ${channelId}: `, error);
      return null;
    }
  }

  private async poll(): Promise<void>
  {
    if (!this.isPolling || this.requestActive || !this.ctx.scope.isActive || this.bot.http.isDisposed) return;
    this.requestActive = true;

    try
    {
      const notifications = [
        ...(await this.fetchNotifications('at')),
        ...(await this.fetchNotifications('reply')),
      ];
      const unique = new Map<string, BilibiliCommentNotification>();
      for (const notification of notifications)
      {
        unique.set(notification.id, notification);
      }

      const ordered = [...unique.values()].sort((a, b) => a.timestamp - b.timestamp);
      if (!this.initialized)
      {
        ordered.forEach(item => this.processedIds.add(item.id));
        this.initialized = true;
        logInfo(`评论通知基线初始化完成，忽略 ${ordered.length} 条历史通知`);
        return;
      }

      for (const notification of ordered)
      {
        if (this.processedIds.has(notification.id)) continue;
        this.processedIds.add(notification.id);
        if (this.processedIds.size > 2000)
        {
          const first = this.processedIds.values().next().value;
          if (typeof first === 'string') this.processedIds.delete(first);
        }
        await this.bot.receiveComment(notification);
      }
    } finally
    {
      this.requestActive = false;
    }
  }

  private async fetchNotifications(kind: 'at' | 'reply'): Promise<BilibiliCommentNotification[]>
  {
    const response = await this.bot.http.http.get<BiliApiResponse<unknown>>(
      `https://api.bilibili.com/x/msgfeed/${kind}`,
      {
        params: {
          platform: 'web',
          build: 0,
          mobi_app: 'web',
          ps: 20,
          pn: 1,
          csrf: this.bot.http.getBiliJct(),
        },
        headers: {
          Referer: 'https://message.bilibili.com/',
        },
      }
    );

    if (response.code !== 0)
    {
      loggerError(`获取 ${kind} 评论通知失败: ${response.message} (Code: ${response.code})`);
      return [];
    }

    const data = asRecord(response.data);
    const rawItems = Array.isArray(response.data)
      ? response.data
      : data && Array.isArray(data.items) ? data.items : [];
    const result: BilibiliCommentNotification[] = [];
    for (const raw of rawItems)
    {
      const notification = await this.parseNotification(raw);
      if (notification) result.push(notification);
    }
    return result;
  }

  private async parseNotification(rawValue: unknown): Promise<BilibiliCommentNotification | null>
  {
    // 通知接口的字段会随通知类型嵌套在不同层级，统一从多个层级解析。
    const raw = asRecord(rawValue);
    const item = asRecord(raw?.item);
    const nestedItem = asRecord(item?.item);
    const targetReply = asRecord(item?.target_reply) || asRecord(item?.targetReply);
    const targetContent = asRecord(targetReply?.content);
    const targetMember = asRecord(targetReply?.member);
    const records = [raw, item, nestedItem, targetReply, targetContent, targetMember]
      .filter((record): record is JsonRecord => !!record);
    if (!raw || !item) return null;

    const id = readString(raw, 'id', 'reply_id', 'notify_id') || readString(item, 'id', 'reply_id');
    const uri = records.map(record => readString(record, 'uri', 'native_uri', 'jump_url')).find(Boolean) || '';
    const business = records.map(record => readString(record, 'business', 'business_name', 'type')).find(Boolean) || '';
    const bvid = records.map(record => readString(record, 'bvid')).find(value => /^BV\w+$/.test(value))
      || uri.match(/\/video\/(BV\w+)/i)?.[1]
      || '';
    const opusId = extractOpusId(records);
    let oid = readNumber(item, 'subject_id', 'oid') || readFirstNumber(records, 'oid');
    let type: 1 | 11;

    const isVideo = business.includes('video') || business.includes('archive') || /\/video\//i.test(uri) || !!bvid;
    const isOpus = business.includes('dynamic') || business.includes('opus') || /(?:t\.bilibili\.com|\/opus\/)/i.test(uri);
    if (isVideo)
    {
      type = 1;
      if (bvid)
      {
        const video = await this.bot.http.getRenmuClient().video.info({ bvid });
        const videoRecord = asRecord(video);
        const resolvedAid = readNumber(videoRecord, 'aid');
        if (resolvedAid) oid = resolvedAid;
      }
      if (!bvid || !oid) return null;
      return this.createNotification(raw, item, records, id, oid, type, bvid);
    }

    if (isOpus && opusId && oid)
    {
      type = 11;
      return this.createNotification(raw, item, records, id, oid, type, opusId);
    }

    logInfo(`忽略无法识别目标类型的评论通知: ${JSON.stringify(rawValue)}`);
    return null;
  }

  private createNotification(raw: JsonRecord, item: JsonRecord, records: JsonRecord[], id: string, oid: number, type: 1 | 11, channelValue: string): BilibiliCommentNotification | null
  {
    const targetReply = asRecord(item.target_reply) || asRecord(item.targetReply);
    const user = getUser(records);
    const rpid = readNumber(item, 'business_reply_id', 'reply_id', 'rpid', 'source_id')
      || readNumber(raw, 'business_reply_id', 'reply_id', 'rpid', 'source_id')
      || readNumber(targetReply, 'id', 'rpid', 'reply_id')
      || readNumber(item, 'target_id')
      || readNumber(raw, 'target_id');
    if (!oid || !user.id || !rpid) return null;

    const notificationId = id || `${type}:${oid}:${rpid}`;

    return {
      id: notificationId,
      oid,
      type,
      channelId: `${type === 1 ? 'video' : 'opus'}:${channelValue}`,
      userId: user.id,
      userName: user.name,
      userAvatar: user.avatar,
      content: getText(records),
      timestamp: normalizeTimestamp(
        readNumber(targetReply, 'ctime', 'reply_time', 'timestamp')
        || readNumber(raw, 'reply_time', 'ctime', 'timestamp')
        || readNumber(item, 'ctime', 'reply_time')
      ),
      rpid,
      root: readNumber(targetReply, 'root', 'root_id') || readNumber(item, 'root_id', 'root') || rpid,
      parent: readNumber(targetReply, 'parent', 'parent_id') || readNumber(item, 'parent_id', 'parent') || rpid,
    };
  }
}
