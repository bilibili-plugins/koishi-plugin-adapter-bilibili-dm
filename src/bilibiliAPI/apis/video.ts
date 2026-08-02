import { BilibiliDmBot } from '../../bot/bot';
import { logInfo, loggerError } from '../../index';
import { BilibiliResponse, ExternalParseResponse, VideoConclusionData, VideoData } from './types';

export class VideoAPI
{
  constructor(private bot: BilibiliDmBot)
  {
  }

  async getVideoInfo(bvid: string): Promise<VideoData | null>
  {
    try
    {
      if (!bvid.startsWith('BV') || bvid.length < 10)
      {
        loggerError(`无效的视频 BV 号: ${bvid}`);
        return null;
      }

      // 视频详情由新包统一请求，保持旧接口返回的数据结构。
      const response = await (await this.bot.http.getRenmuClient()).video.info({ bvid });
      if (!response || typeof response !== 'object' || !('bvid' in response))
      {
        loggerError(`获取视频信息失败: ${bvid}`);
        return null;
      }

      const data = response as unknown as VideoData;
      logInfo(`成功获取视频信息: ${bvid}, 标题: ${data.title}`);
      return data;
    } catch (error)
    {
      loggerError(`解析视频信息时发生错误: ${bvid}`, error);
      return null;
    }
  }

  async parseExternalUrl(url: string, accessKey?: string): Promise<ExternalParseResponse | null>
  {
    try
    {
      if (!url || typeof url !== 'string')
      {
        loggerError(`无效的 URL: ${url}`);
        return null;
      }

      const params: Record<string, string> = { url };
      if (accessKey)
      {
        params.access_key = accessKey;
      }

      const response = await this.bot.http.http.get<ExternalParseResponse>(
        'http://api.xingzhige.com/API/b_parse/',
        { params, timeout: 30 * 1000 }
      );

      if (response.code === 0)
      {
        logInfo(`成功使用外部 API 解析链接: ${url}`);
      } else
      {
        loggerError(`解析链接失败: ${url}, 错误码: ${response.code}, 消息: ${response.message}`);
      }
      return response;
    } catch (error)
    {
      loggerError(`解析链接时发生错误: ${url}`, error);
      return null;
    }
  }

  async getVideoConclusion(bvid: string, cid: number, up_mid: number): Promise<VideoConclusionData | null>
  {
    try
    {
      const baseParams = { bvid, cid, up_mid };
      const signedParams = await this.bot.http.getWbiSignature(baseParams);
      const response = await this.bot.http.http.get<BilibiliResponse<VideoConclusionData>>(
        'https://api.bilibili.com/x/web-interface/view/conclusion/get',
        {
          params: { ...baseParams, ...signedParams },
          headers: {
            Referer: `https://www.bilibili.com/video/${bvid}`,
            Origin: 'https://www.bilibili.com',
          },
        }
      );

      if (response.code === 0 && response.data)
      {
        logInfo(`成功获取视频 AI 总结: ${bvid}`);
        return response.data;
      }

      loggerError(`获取视频 AI 总结失败: ${bvid}, 错误码: ${response.code}, 消息: ${response.message}`);
      return null;
    } catch (error)
    {
      loggerError(`获取视频 AI 总结时发生错误: ${bvid}`, error);
      return null;
    }
  }
}
