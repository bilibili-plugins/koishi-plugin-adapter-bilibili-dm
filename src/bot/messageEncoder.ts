// src\bot\messageEncoder.ts
import { Context, MessageEncoder, h } from 'koishi';
import { loggerError } from '../index';
import { BilibiliDmBot } from './bot';
import { BilibiliCommentMention } from '../bilibiliAPI/apis/comment';

export class BilibiliMessageEncoder extends MessageEncoder<Context, BilibiliDmBot>
{
  private textBuffer = '';
  private readonly mentions = new Map<string, BilibiliCommentMention>();

  async flush(): Promise<void>
  {
    if (this.textBuffer)
    {
      await this.flushTextBuffer();
    }
  }

  /**
   * 计算字符串的字符数
   * @param text 要计算的字符串
   * @returns 字符数
   */
  private calculateCharCount(text: string): number
  {
    let count = 0;
    for (const char of text)
    {
      if (char === '\n')
      {
        count += 2;
      } else
      {
        count++;
      }
    }
    return count;
  }

  private async flushTextBuffer(): Promise<void>
  {
    if (!this.textBuffer) return;

    const [type, talkerId] = this.channelId.split(':');
    if (!['private', 'video', 'opus'].includes(type) || !talkerId) return;

    const MAX_LENGTH = 470; // B站限制500字符，这里留一些余地
    let textToSend = this.textBuffer.replace(/\n+/g, '\n').trim();
    this.textBuffer = '';
    const mentions = [...this.mentions.values()];
    this.mentions.clear();

    while (this.calculateCharCount(textToSend) > 0)
    {
      let currentChunk = '';
      // 如果剩余文本长度超过最大限制，则进行切分
      if (this.calculateCharCount(textToSend) > MAX_LENGTH)
      {
        let splitPoint = -1;
        // 寻找合适的切分点（优先在换行符处切分）
        for (let i = 0; i < textToSend.length; i++)
        {
          const substring = textToSend.substring(0, i + 1);
          if (this.calculateCharCount(substring) > MAX_LENGTH)
          {
            break;
          }
          if (textToSend[i] === '\n')
          {
            splitPoint = i;
          }
        }

        // 如果找到了换行符作为切分点
        if (splitPoint !== -1)
        {
          currentChunk = textToSend.substring(0, splitPoint);
          textToSend = textToSend.substring(splitPoint + 1);
        } else
        {
          // 如果没有找到换行符，则硬切分
          let endIndex = 0;
          let currentLength = 0;
          for (let i = 0; i < textToSend.length; i++)
          {
            const char = textToSend[i];
            const charLength = char === '\n' ? 2 : 1;
            if (currentLength + charLength > MAX_LENGTH)
            {
              break;
            }
            currentLength += charLength;
            endIndex = i + 1;
          }
          currentChunk = textToSend.substring(0, endIndex);
          textToSend = textToSend.substring(endIndex);
        }
      } else
      {
        currentChunk = textToSend;
        textToSend = '';
      }

      if (currentChunk.trim().length > 0)
      {
        const msgContent = { content: currentChunk };
        const msgKey = type === 'private'
          ? await this.bot.http.sendMessage(this.bot.selfId, Number(talkerId), JSON.stringify(msgContent), 1)
          : await this.bot.sendComment(this.channelId, currentChunk, mentions);
        if (msgKey)
        {
          this.results.push({ id: msgKey });
        }
        // 在发送多条消息之间添加一个小的延迟，以避免被B站API限速
        if (textToSend.length > 0)
        {
          await this.bot.ctx.sleep(200);
        }
      }
    }
  }

  async visit(element: h): Promise<void>
  {
    const { type, attrs, children } = element;

    switch (type)
    {
      case 'text':
        if (attrs.content)
        {
          this.textBuffer += attrs.content;
        }
        break;

      case 'p':
        this.textBuffer += '\n';
        if (children)
        {
          for (const child of children)
          {
            await this.visit(child);
          }
        }
        this.textBuffer += '\n';
        break;

      case 'br':
        this.textBuffer += '\n';
        break;

      case 'at':
      {
        const id = String(attrs.id || '');
        const name = String(attrs.name || id);
        if (name)
        {
          this.textBuffer += `@${name}`;
          if (id) this.mentions.set(`${id}:${name}`, { id, name });
        }
        break;
      }

      case 'image':
      case 'img':
        await this.flushTextBuffer();
        await this.sendImage(attrs.url || attrs.src);
        break;

      default:
        // 处理其他元素的子元素
        if (children)
        {
          for (const child of children)
          {
            await this.visit(child);
          }
        }
        break;
    }
  }

  private async sendImage(imageUrl: string): Promise<void>
  {
    if (!imageUrl) return;

    const [type, talkerId] = this.channelId.split(':');
    if (type !== 'private' || !talkerId) return;

    try
    {
      const imageData = await this.bot.http.safeFileRequest(imageUrl, `下载图片失败，URL: ${imageUrl}`);
      if (!imageData)
      {
        loggerError(`图片下载失败，URL: ${imageUrl}`);
        return;
      }

      const imageBuffer = imageData.data;
      const imageType = imageData.mime || imageData.type;

      const uploadResult = await this.bot.http.uploadImage(imageBuffer);
      if (!uploadResult)
      {
        loggerError(`图片上传失败，URL: ${imageUrl}`);
        return;
      }

      const msgContent = {
        url: uploadResult.image_url,
        width: uploadResult.image_width,
        height: uploadResult.image_height,
        imageType: imageType,
        size: uploadResult.img_size || 0,
        original: 1
      };

      const msgKey = await this.bot.http.sendMessage(this.bot.selfId, Number(talkerId), JSON.stringify(msgContent), 2);
      if (msgKey)
      {
        this.results.push({ id: msgKey });
      }
    } catch (error)
    {
      loggerError('发送图片时发生错误: %o', error);
    }
  }
}
