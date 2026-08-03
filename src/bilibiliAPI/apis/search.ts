// src\bilibiliAPI\apis\search.ts
import { BilibiliDmBot } from '../../bot/bot';
import { logInfo, loggerError } from '../../index';
import { ComprehensiveSearchResponse, SearchArticle, SearchLiveRoom, SearchLiveUser, SearchOptions, SearchUser, SearchVideo, TypeSearchResponse } from './types';

const orderSortValues = ['0', '1'] as const;
const userTypeValues = ['0', '1', '2', '3'] as const;
const durationValues = ['0', '1', '2', '3', '4'] as const;

// 将旧接口的数字筛选项转换为新包要求的字符串。
function toOrderSort(value: 0 | 1 | undefined): typeof orderSortValues[number] | undefined
{
  return value === undefined ? undefined : orderSortValues[value];
}

function toUserType(value: 0 | 1 | 2 | 3 | undefined): typeof userTypeValues[number] | undefined
{
  return value === undefined ? undefined : userTypeValues[value];
}

function toDuration(value: 0 | 1 | 2 | 3 | 4 | undefined): typeof durationValues[number] | undefined
{
  return value === undefined ? undefined : durationValues[value];
}

function toCategoryId(value: number | undefined): '0' | '1' | '2' | '3' | '16' | '17' | '28' | '29' | undefined
{
  switch (value)
  {
    case 0: return '0';
    case 1: return '1';
    case 2: return '2';
    case 3: return '3';
    case 16: return '16';
    case 17: return '17';
    case 28: return '28';
    case 29: return '29';
    default: return undefined;
  }
}

export class SearchAPI
{
  constructor(private bot: BilibiliDmBot)
  {
  }

  async comprehensiveSearch(keyword: string): Promise<ComprehensiveSearchResponse | null>
  {
    try
    {
      logInfo(`开始综合搜索: ${keyword}`);
      const res = await this.bot.http.getRenmuClient().search.all({ keyword, page: 1, page_size: 20 }, true);
      return res as unknown as ComprehensiveSearchResponse;
    } catch (error)
    {
      loggerError('综合搜索时发生错误: ', error);
      return null;
    }
  }

  async searchUsers(keyword: string, options: SearchOptions = {}): Promise<SearchUser[]>
  {
    try
    {
      logInfo(`开始搜索用户: ${keyword}`);
      const res = await this.bot.http.getRenmuClient().search.type({
        search_type: 'bili_user',
        keyword,
        page: options.page || 1,
        order: options.userOrder,
        order_sort: toOrderSort(options.orderSort),
        user_type: toUserType(options.userType),
      }, true);

      const users = (res.result || []) as SearchUser[];
      logInfo(`用户搜索成功，找到 ${users.length} 个用户`);
      return users;
    } catch (error)
    {
      loggerError('搜索用户时发生错误: ', error);
      return [];
    }
  }

  async searchVideos(keyword: string, options: SearchOptions = {}): Promise<SearchVideo[]>
  {
    try
    {
      logInfo(`开始搜索视频: ${keyword}`);
      const res = await this.bot.http.getRenmuClient().search.type({
        search_type: 'video',
        keyword,
        page: options.page || 1,
        order: options.order,
        duration: toDuration(options.duration),
        tids: options.tids,
      }, true);

      const videos = (res.result || []) as SearchVideo[];
      logInfo(`视频搜索成功，找到 ${videos.length} 个视频`);
      return videos;
    } catch (error)
    {
      loggerError('搜索视频时发生错误: ', error);
      return [];
    }
  }

  async searchLive(keyword: string, options: SearchOptions = {}): Promise<{ liveRooms: SearchLiveRoom[]; liveUsers: SearchLiveUser[]; }>
  {
    try
    {
      logInfo(`开始搜索直播: ${keyword}`);
      const res = await this.bot.http.getRenmuClient().search.type({
        search_type: 'live',
        keyword,
        page: options.page || 1,
      }, true);

      const result = (res.result || {}) as { live_room?: SearchLiveRoom[]; live_user?: SearchLiveUser[]; };
      const liveRooms = result.live_room || [];
      const liveUsers = result.live_user || [];
      logInfo(`直播搜索成功，找到 ${liveRooms.length} 个直播间，${liveUsers.length} 个主播`);
      return { liveRooms, liveUsers };
    } catch (error)
    {
      loggerError('搜索直播时发生错误: ', error);
      return { liveRooms: [], liveUsers: [] };
    }
  }

  async searchArticles(keyword: string, options: SearchOptions = {}): Promise<SearchArticle[]>
  {
    try
    {
      logInfo(`开始搜索专栏: ${keyword}`);
      const res = await this.bot.http.getRenmuClient().search.type({
        search_type: 'article',
        keyword,
        page: options.page || 1,
        order: options.order,
        category_id: toCategoryId(options.categoryId),
      }, true);

      const articles = (res.result || []) as SearchArticle[];
      logInfo(`专栏搜索成功，找到 ${articles.length} 篇专栏`);
      return articles;
    } catch (error)
    {
      loggerError('搜索专栏时发生错误: ', error);
      return [];
    }
  }

  async searchUsersByName(username: string, exactMatch = false): Promise<SearchUser[]>
  {
    const users = await this.searchUsers(username, {
      userOrder: 'fans',
      orderSort: 0,
    });

    if (exactMatch)
    {
      return users.filter(user => user.uname.toLowerCase() === username.toLowerCase());
    }

    return users;
  }

  async searchUpUsers(keyword: string, options: SearchOptions = {}): Promise<SearchUser[]>
  {
    return this.searchUsers(keyword, {
      ...options,
      userType: 1,
    });
  }
}
