# 事件文档

本页面详细介绍了 Bilibili Direct Message 适配器提供的所有事件类型及其使用方法。

## 注意事项

1. **频率限制**: B站API有调用频率限制，请合理控制调用频率
2. **数据格式**: 返回的数据格式可能随B站API更新而变化
3. **错误处理**: 建议对所有API调用进行错误处理
4. **网络异常**: 处理网络超时和连接失败的情况
5. **事件重复**: 避免重复监听相同事件导致重复处理

## Koishi 通用事件

### before-send

消息发送前触发的事件。

```typescript
ctx.on('before-send', (session) => {
  console.log('即将发送消息:', session.content)
  // 可以在这里修改消息内容或阻止发送
})
```

**事件数据:** Koishi Session 对象

**使用场景:**

- 消息内容过滤
- 消息格式化
- 发送权限检查

### send

消息发送后触发的事件。

```typescript
ctx.on('send', (session) => {
  console.log('消息已发送:', session.messageId)
})
```

**事件数据:** Koishi Session 对象，包含已发送的消息ID

**使用场景:**

- 消息发送统计
- 发送日志记录
- 后续处理逻辑

### message

接收到消息时触发的事件。

```typescript
ctx.on('message', (session) => {
  console.log('收到消息:', session.content)
})
```

**事件数据:** Koishi Session 对象

**使用场景:**

- 消息处理
- 自动回复
- 消息统计

### message-deleted

消息被撤回时触发的事件。

```typescript
ctx.on('message-deleted', (session) => {
  console.log('消息被撤回:', session.messageId)
})
```

**事件数据:** Koishi Session 对象

## 平台特殊事件

可分为几大类事件（如动态、直播），每部分可分为`全局事件`和具体的`特定事件`。

> 例如，当一个UP主发布新的图片动态时，适配器会先判断动态类型为图片动态，
>
> 然后先下发一个全局的动态更新事件，再下发一个图片动态事件。

因此开发者一般只需要监听全局事件即可啦~

---

## 状态相关事件

### bilibili-dm/status-update

插件状态更新事件（全局）。

```typescript
ctx.on('bilibili-dm/status-update', (status) => {
  console.log('插件状态更新:', status.status)

  switch (status.status) {
    case 'success':
      console.log('登录成功或已使用缓存登录')
      break
    case 'qrcode':
      console.log('等待扫码或手机确认登录')
      break
    case 'continue':
      console.log('需要继续登录')
      break
    case 'offline':
      console.log('适配器已离线')
      break
    case 'error':
      console.log('登录或运行过程中发生错误')
      break
  }
})
```

### bilibili-dm-{selfId}/status-update

特定账号的状态更新事件。

```typescript
ctx.on('bilibili-dm-123456789/status-update', (status) => {
  console.log('账号 123456789 状态更新:', status.status)
})
```

**状态数据结构:**

```typescript
interface StatusUpdateData {
  status: 'init' | 'qrcode' | 'continue' | 'success' | 'error' | 'offline'
  selfId: string
  image?: string
  message?: string
}
```

## 评论消息

评论通知不会使用额外的自定义事件名，而是作为标准 Koishi `message` Session 下发，因此可以直接由命令和其他消息处理插件处理。

```typescript
ctx.on('message', (session) => {
  if (session.channelId?.startsWith('video:')) {
    console.log('收到视频评论:', session.channelId, session.content)
  }
  if (session.channelId?.startsWith('opus:')) {
    console.log('收到图文动态评论:', session.channelId, session.content)
  }
})
```

视频评论频道格式为 `video:BV号`，图文动态评论频道格式为 `opus:动态ID`。评论文本中的 @ 会转换成 Koishi `at` 元素；当 Koishi 发送回复时，适配器会使用通知记录的 `root` 和 `parent` 回复目标评论。

## 动态相关事件

### bilibili/dynamic-update

通用动态更新事件（全局）。

```typescript
ctx.on('bilibili/dynamic-update', (data) => {
  console.log('动态更新:', data.author.name, data.content.text)

  // 处理所有类型的动态
  if (data.content.images?.length > 0) {
    console.log('包含图片:', data.content.images.length, '张')
  }

  if (data.content.bvid) {
    console.log('视频BV号:', data.content.bvid)
  }
})
```

### bilibili/dynamic-video-update

视频动态更新事件。

```typescript
ctx.on('bilibili/dynamic-video-update', (data) => {
  console.log('视频动态:', data.content.title)
  console.log('视频链接:', data.content.jump_url)
  console.log('BV号:', data.content.bvid)
})
```

### bilibili/dynamic-image-update

图片动态更新事件。

```typescript
ctx.on('bilibili/dynamic-image-update', (data) => {
  console.log('图片动态:', data.content.images?.length, '张图片')

  // 处理图片
  data.content.images?.forEach((imageUrl, index) => {
    console.log(`图片 ${index + 1}:`, imageUrl)
  })
})
```

### bilibili/dynamic-text-update

文字动态更新事件。

```typescript
ctx.on('bilibili/dynamic-text-update', (data) => {
  console.log('文字动态:', data.content.text)
  console.log('发布者:', data.author.name)
})
```

### bilibili/dynamic-article-update

专栏动态更新事件。

```typescript
ctx.on('bilibili/dynamic-article-update', (data) => {
  console.log('专栏动态:', data.content.title)
  console.log('专栏链接:', data.content.jump_url)
  console.log('CV号:', data.content.cvid)
})
```

### bilibili/dynamic-live-update

直播动态更新事件。

```typescript
ctx.on('bilibili/dynamic-live-update', (data) => {
  console.log('直播动态:', data.content.title)
  console.log('直播间:', data.content.jump_url)
})
```

### bilibili/dynamic-forward-update

转发动态更新事件。

```typescript
ctx.on('bilibili/dynamic-forward-update', (data) => {
  console.log('转发动态:', data.content.text)
  console.log('原动态信息:', data.content.orig)
})
```

### bilibili/dynamic-pgc-update

PGC（番剧等）动态更新事件。

```typescript
ctx.on('bilibili/dynamic-pgc-update', (data) => {
  console.log('PGC动态:', data.content.title)
})
```

### bilibili/dynamic-ugc-season-update

UGC合集动态更新事件。

```typescript
ctx.on('bilibili/dynamic-ugc-season-update', (data) => {
  console.log('合集动态:', data.content.title)
})
```

### bilibili/dynamic-unknown-update

未知类型动态更新事件。

```typescript
ctx.on('bilibili/dynamic-unknown-update', (data) => {
  console.log('未知类型动态:', data.type)
  console.log('原始数据:', data.rawData)
})
```

**动态事件数据结构:**

```typescript
interface DynamicEventData {
  id: string                    // 动态ID
  type: string                  // 动态类型
  timestamp: number             // 发布时间戳
  author: {                     // 作者信息
    uid: string                 // 作者UID
    name: string                // 作者昵称
    avatar: string              // 作者头像
    jump_url: string            // 作者主页链接
  }
  content: {                    // 动态内容
    text?: string               // 文字内容
    title?: string              // 标题
    description?: string        // 描述
    images?: string[]           // 图片列表
    bvid?: string              // 视频BV号
    aid?: string               // 视频AV号
    cvid?: number              // 专栏CV号
    jump_url?: string          // 跳转链接
    cover?: string             // 封面图片
    orig?: any                 // 原动态信息（转发时）
  }
  rawData: any                  // 原始数据
}
```

## UP直播相关事件

### bilibili/live-update

通用直播状态更新事件（全局）。

```typescript
ctx.on('bilibili/live-update', (data) => {
  console.log('直播状态更新:', data.action)

  switch (data.action) {
    case 'start':
      console.log(`${data.author.name} 开始直播: ${data.content.title}`)
      break
    case 'end':
      console.log(`${data.author.name} 结束直播`)
      break
    case 'update':
      console.log(`${data.author.name} 更新直播信息`)
      break
  }
})
```

### bilibili/live-start

开播事件。

```typescript
ctx.on('bilibili/live-start', (data) => {
  console.log('开播了:', data.author.name, data.content.title)
  console.log('直播间ID:', data.content.room_id)
  console.log('直播分区:', data.content.area_name)
})
```

### bilibili/live-end

下播事件。

```typescript
ctx.on('bilibili/live-end', (data) => {
  console.log('下播了:', data.author.name)
  console.log('直播时长:', data.content.duration)
})
```

## 直播间相关事件

> 直播间相关事件 没有全局事件

### bilibili/live-info-update

直播信息更新事件（标题、封面等变化）。

```typescript
ctx.on('bilibili/live-info-update', (data) => {
  console.log('直播信息更新:', data.content.title)
  console.log('新封面:', data.content.cover)
})
```

### bilibili/live-chat

直播弹幕事件。

> 此事件 仅在加入直播间后 接收到弹幕后 才会触发

```typescript
ctx.on('bilibili/live-chat', (data) => {
  console.log('收到弹幕:', data.message.content)
  console.log('发送者:', data.message.sender.name)
  console.log('直播间:', data.room.room_id)
})
```
