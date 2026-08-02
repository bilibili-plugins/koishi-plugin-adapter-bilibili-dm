// src\bilibiliAPI\apis\liveRoom.ts
import { LiveRoomInfo } from './types';
import { BilibiliDmBot } from '../../bot/bot';
import { logInfo, loggerError } from '../../index';
import { getBilibiliErrorMessage } from '../temp_error_codes';

export class LiveRoomAPI
{
  constructor(private bot: BilibiliDmBot) { }

  // 获取直播间信息
  async getRoomInfo(roomId: number): Promise<LiveRoomInfo>
  {
    try
    {
      const response = await (await this.bot.http.getRenmuClient()).live.getRoomInfo(roomId, true);
      return response as unknown as LiveRoomInfo;
    }
    catch (error)
    {
      loggerError('新包获取直播间信息失败，回退到原请求: ', error);
    }

    const response = await this.bot.http.http.get('https://api.live.bilibili.com/room/v1/Room/get_info', {
      params: { room_id: roomId },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': `https://live.bilibili.com/${roomId}`,
        'Origin': 'https://live.bilibili.com'
      }
    });

    if (response.code !== 0)
    {
      const errorMessage = getBilibiliErrorMessage(response.code);
      throw new Error(`获取直播间信息失败: code=${response.code}, ${errorMessage}`);
    }

    return response.data;
  }

  // 进入直播间
  async enterRoom(roomId: number): Promise<void>
  {
    // 获取CSRF token
    const csrf = this.bot.http.getBiliJct();
    if (!csrf)
    {
      throw new Error('进入直播间失败: 未找到CSRF token');
    }

    // 使用WBI签名
    const baseParams = { csrf };
    const signedParams = await this.bot.http.getWbiSignature(baseParams);

    const response = await this.bot.http.http.post('https://api.live.bilibili.com/xlive/web-room/v1/index/roomEntryAction', {
      room_id: roomId,
      platform: 'pc'
    }, {
      params: {
        csrf,
        ...signedParams
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': `https://live.bilibili.com/${roomId}`,
        'Origin': 'https://live.bilibili.com',
        'Content-Type': 'application/json'
      }
    });

    if (response.code !== 0)
    {
      const errorMessage = getBilibiliErrorMessage(response.code);
      throw new Error(`进入直播间失败: code=${response.code}, ${errorMessage}`);
    }
  }

  // 心跳上报
  async heartbeat(roomId: number): Promise<void>
  {
    const heartbeatData = `60|${roomId}|1|0`;
    const hb = Buffer.from(heartbeatData).toString('base64');

    const response = await this.bot.http.http.get('https://live-trace.bilibili.com/xlive/rdata-interface/v1/heartbeat/webHeartBeat', {
      params: {
        hb: hb,
        pf: 'web'
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': `https://live.bilibili.com/${roomId}`,
        'Origin': 'https://live.bilibili.com'
      }
    });

    if (response.code !== 0)
    {
      const errorMessage = getBilibiliErrorMessage(response.code);
      throw new Error(`心跳上报失败: code=${response.code}, ${errorMessage}`);
    }
  }

  // 获取弹幕服务器配置
  async getDanmakuInfo(roomId: number): Promise<any>
  {
    try
    {
      logInfo(`[LiveRoomAPI] 请求弹幕服务器配置, roomId: ${roomId}`);

      // 使用WBI签名
      const baseParams = { id: roomId, type: 0 };
      const signedParams = await this.bot.http.getWbiSignature(baseParams);

      const response = await this.bot.http.http.get('https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo', {
        params: {
          ...baseParams,
          ...signedParams
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0',
          'Referer': `https://live.bilibili.com/${roomId}`,
          'Origin': 'https://live.bilibili.com'
        }
      });

      logInfo(`[LiveRoomAPI] getDanmakuInfo 完整响应: ${JSON.stringify(response, null, 2)}`);

      // 检查响应数据结构 - 修复这里的逻辑
      if (!response || typeof response !== 'object')
      {
        throw new Error(`获取弹幕服务器配置失败: 响应格式错误`);
      }

      // 直接检查响应中的code字段
      if (response.code !== undefined && response.code !== 0)
      {
        const errorMessage = getBilibiliErrorMessage(response.code);
        throw new Error(`B站API返回错误: code=${response.code}, ${errorMessage}`);
      }

      // 检查data字段
      if (!response.data)
      {
        throw new Error(`获取弹幕服务器配置失败: data字段为空`);
      }

      const danmakuData = response.data;
      logInfo(`[LiveRoomAPI] danmakuData: ${JSON.stringify(danmakuData, null, 2)}`);

      // 检查必要的字段
      if (!danmakuData.host_list || !Array.isArray(danmakuData.host_list) || danmakuData.host_list.length === 0)
      {
        throw new Error(`获取弹幕服务器配置失败: host_list为空或无效`);
      }

      if (!danmakuData.token)
      {
        throw new Error(`获取弹幕服务器配置失败: token为空`);
      }

      logInfo(`[LiveRoomAPI] 弹幕服务器配置获取成功, host数量: ${danmakuData.host_list.length}`);
      return danmakuData;
    } catch (error)
    {
      loggerError(`[LiveRoomAPI] getDanmakuInfo 失败: ${error}`);
      throw error;
    }
  }
}
