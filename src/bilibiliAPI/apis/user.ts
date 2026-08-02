// src\bilibiliAPI\apis\user.ts
import { BilibiliDmBot } from '../../bot/bot';
import { logInfo, loggerError } from '../../index';
import
{
  FollowingUser,
  FollowingListResponse,
  BilibiliResponse,
  BilibiliError
} from './types';

import { existsSync, readFileSync } from 'node:fs';
import { getDataFilePath } from '../../bot/utils';

export class UserAPI
{
  private bot: BilibiliDmBot;

  constructor(bot: BilibiliDmBot)
  {
    this.bot = bot;
  }

  /**
   * 关注指定 UP 主
   * @param uid UP 主的 UID
   * @returns Promise<boolean> 是否成功关注
   */
  async followUser(uid: string): Promise<boolean>
  {
    try
    {
      const res: BilibiliResponse = await this.bot.http.http.post(
        'https://api.bilibili.com/x/relation/modify',
        new URLSearchParams({
          fid: uid,
          act: '1', // 1: 关注
          re_src: '11', // 个人空间
          csrf: this.bot.http['biliJct'], // 从 HttpClient 获取 biliJct
          csrf_token: this.bot.http['biliJct']
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Referer': `https://space.bilibili.com/${uid}/`
          }
        }
      );

      if (res.code === 0)
      {
        logInfo(`成功关注 UP 主: ${uid}`);
        return true;
      } else
      {
        loggerError(`关注 UP 主 ${uid} 失败: ${res.message} (Code: ${res.code})`);
        // 抛出包含错误码和消息的错误，以便上层处理
        throw new BilibiliError(res.message, res.code);
      }
    } catch (error)
    {
      // 如果是我们抛出的BilibiliError，直接重新抛出
      if (error instanceof BilibiliError)
      {
        throw error;
      }
      loggerError(`关注 UP 主 ${uid} 时发生错误: `, error);
      throw error;
    }
  }

  /**
   * 取消关注指定 UP 主
   * @param uid UP 主的 UID
   * @returns Promise<boolean> 是否成功取消关注
   */
  async unfollowUser(uid: string): Promise<boolean>
  {
    try
    {
      const res: BilibiliResponse = await this.bot.http.http.post(
        'https://api.bilibili.com/x/relation/modify',
        new URLSearchParams({
          fid: uid,
          act: '2', // 2: 取关
          re_src: '11', // 个人空间
          csrf: this.bot.http['biliJct'], // 从 HttpClient 获取 biliJct
          csrf_token: this.bot.http['biliJct']
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Referer': `https://space.bilibili.com/${uid}/`
          }
        }
      );

      if (res.code === 0)
      {
        logInfo(`成功取消关注 UP 主: ${uid}`);
        return true;
      } else
      {
        loggerError(`取消关注 UP 主 ${uid} 失败: ${res.message} (Code: ${res.code})`);
        // 抛出包含错误码和消息的错误，以便上层处理
        throw new BilibiliError(res.message, res.code);
      }
    } catch (error)
    {
      // 如果是我们抛出的BilibiliError，直接重新抛出
      if (error instanceof BilibiliError)
      {
        throw error;
      }
      loggerError(`取消关注 UP 主 ${uid} 时发生错误: `, error);
      throw error;
    }
  }

  /**
   * 获取关注的用户列表
   * @param maxPages 最大页数，默认10页
   * @returns Promise<FollowingUser[]> 关注的用户列表
   */
  async getFollowedUsers(maxPages: number = 10): Promise<FollowingUser[]>
  {
    try
    {
      let page = 1;
      let hasMore = true;
      const allFollowings: FollowingUser[] = [];

      while (hasMore && page <= maxPages)
      {
        const res: BilibiliResponse<FollowingListResponse> = await this.bot.http.http.get(
          'https://api.bilibili.com/x/relation/followings',
          {
            params: {
              vmid: this.bot.selfId, // 自己的UID
              pn: page, // 页码
              ps: 50, // 每页数量
              order: 'desc', // 排序方式
              order_type: 'attention' // 排序类型
            },
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
              'Referer': `https://space.bilibili.com/${this.bot.selfId}/fans/follow`
            }
          }
        );

        if (res.code === 0 && res.data?.list)
        {
          allFollowings.push(...res.data.list);
          hasMore = res.data.has_more;
          page++;

          // 添加延迟避免请求过快
          if (hasMore && page <= maxPages)
          {
            await this.bot.ctx.sleep(1000);
          }
        } else
        {
          loggerError(`获取关注列表失败: ${res.message} (Code: ${res.code})`);
          hasMore = false;
        }
      }

      logInfo(`成功获取 ${allFollowings.length} 个关注的用户`);
      return allFollowings;
    } catch (error)
    {
      loggerError('获取关注的用户列表时发生错误: ', error);
      return [];
    }
  }

  /**
   * 获取用户信息
   * @param uid 用户UID
   * @returns Promise<any> 用户信息
   */
  async getUserInfo(uid: string): Promise<any>
  {
    try
    {
      try
      {
        const userInfo = await (await this.bot.http.getRenmuClient()).user.getUserInfo(Number(uid), true);
        if (userInfo)
        {
          logInfo(`成功获取用户 ${uid} 的信息`);
          return userInfo;
        }
      }
      catch (error)
      {
        loggerError(`新包获取用户 ${uid} 信息失败，回退到原请求: `, error);
      }

      const res: BilibiliResponse = await this.bot.http.http.get(
        'https://api.bilibili.com/x/space/acc/info',
        {
          params: {
            mid: uid
          },
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Referer': `https://space.bilibili.com/${uid}/`
          }
        }
      );

      if (res.code === 0 && res.data)
      {
        logInfo(`成功获取用户 ${uid} 的信息`);
        return res.data;
      } else
      {
        loggerError(`获取用户 ${uid} 信息失败: ${res.message} (Code: ${res.code})`);
        throw new BilibiliError(res.message, res.code);
      }
    } catch (error)
    {
      // 如果是我们抛出的BilibiliError，直接重新抛出
      if (error instanceof BilibiliError)
      {
        throw error;
      }
      loggerError(`获取用户 ${uid} 信息时发生错误: `, error);
      throw error;
    }
  }

  /**
   * 检查是否关注了指定用户
   * @param uid 用户UID
   * @returns Promise<boolean> 是否已关注
   */
  async isFollowing(uid: string): Promise<boolean>
  {
    try
    {
      const res: BilibiliResponse = await this.bot.http.http.get(
        'https://api.bilibili.com/x/relation',
        {
          params: {
            fid: uid
          },
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Referer': `https://space.bilibili.com/${uid}/`
          }
        }
      );

      if (res.code === 0 && res.data)
      {
        // attribute 为 2 表示已关注
        return res.data.attribute === 2;
      } else
      {
        loggerError(`检查关注状态失败: ${res.message} (Code: ${res.code})`);
        throw new BilibiliError(res.message, res.code);
      }
    } catch (error)
    {
      // 如果是我们抛出的BilibiliError，直接重新抛出
      if (error instanceof BilibiliError)
      {
        throw error;
      }
      loggerError(`检查关注状态时发生错误: `, error);
      throw error;
    }
  }

  /**
   * 批量检查关注状态
   * @param uids 用户UID列表
   * @returns Promise<Record<string, boolean>> UID到关注状态的映射
   */
  async batchCheckFollowing(uids: string[]): Promise<Record<string, boolean>>
  {
    const result: Record<string, boolean> = {};

    // 分批处理，避免请求过多
    const batchSize = 10;
    for (let i = 0; i < uids.length; i += batchSize)
    {
      const batch = uids.slice(i, i + batchSize);

      const promises = batch.map(async (uid) =>
      {
        const isFollowing = await this.isFollowing(uid);
        result[uid] = isFollowing;
        return { uid, isFollowing };
      });

      await Promise.all(promises);

      // 添加延迟避免请求过快
      if (i + batchSize < uids.length)
      {
        await this.bot.ctx.sleep(1000);
      }
    }

    return result;
  }

  /**
   * 获取指定UID的登录cookie数据
   * @param uid 登录bot的UID
   * @returns Promise<any | null> 返回cookie数据，如果文件不存在则返回null
   */
  async getTokenByUid(uid: string): Promise<any | null>
  {
    try
    {
      const cookieFile = getDataFilePath(this.bot.ctx, uid, `${uid}.cookie.json`);

      logInfo(`检查cookie文件: ${cookieFile}`);

      if (!existsSync(cookieFile))
      {
        logInfo(`UID ${uid} 的cookie文件不存在: ${cookieFile}`);
        return null;
      }

      const cookieData = readFileSync(cookieFile, 'utf8');
      const parsedData = JSON.parse(cookieData);

      logInfo(`成功读取UID ${uid} 的cookie数据，数据长度: ${cookieData.length}`);
      return parsedData;
    } catch (error)
    {
      loggerError(`读取UID ${uid} 的cookie数据时发生错误: `, error);
      return null;
    }
  }
}
