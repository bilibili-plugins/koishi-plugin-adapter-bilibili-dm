# 适配器开发指南

本页面介绍如何参与 Bilibili Direct Message 适配器的开发和贡献。

## 环境准备

### 系统要求

- Node.js >= 22.0.0
- Yarn 或 npm
- Git
- TypeScript 基础知识
- Koishi 框架了解

### 开发环境搭建

1. **创建 Koishi 项目模板**

```bash
yarn create koishi
```

一路回车，直到弹出 Koishi 的 WebUI。

2. **进入项目目录**

先在 Koishi 终端按下 `Ctrl + C` 退出项目模板，然后进入目录：

```bash
cd koishi-app
```

3. **克隆本仓库**

```bash
yarn clone bilibili-plugins/koishi-plugin-adapter-bilibili-dm
```

4. **以开发模式启动**

```bash
yarn dev
```

## 项目结构

```bash
src/
├── bilibiliAPI/           # B站API封装
│   ├── index.ts          # API主入口
│   ├── internal.ts       # 内部API方法
│   ├── temp_error_codes.ts # 错误码定义
│   └── apis/             # 各类API实现
│       ├── dynamic.ts    # 动态相关API
│       ├── comment.ts    # 评论通知轮询与评论回复
│       ├── live.ts       # 直播相关API
│       ├── liveRoom.ts   # 直播间API
│       ├── liveWebSocket.ts # 直播WebSocket
│       ├── search.ts     # 搜索API
│       ├── types.ts      # 类型定义
│       └── user.ts       # 用户相关API
├── bot/                  # Bot实现
│   ├── adapter.ts        # 适配器主类
│   ├── bot.ts           # Bot实例
│   ├── http.ts          # HTTP客户端
│   ├── messageEncoder.ts # 消息编码器
│   ├── schema.ts        # 配置模式
│   ├── service.ts       # 服务类
│   └── types.ts         # 类型定义
├── demoplugin/          # 示例插件
└── test/                # 测试文件
```
