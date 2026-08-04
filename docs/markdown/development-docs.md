# 文档开发指南

本页面介绍如何参与本文档站点的开发和维护。

## 环境准备

### 系统要求

- Node.js >= 22.0.0
- Yarn 或 npm
- Git
- 基本的 Markdown 和 VitePress 知识

### 快速开始

1. **克隆文档仓库**

```bash
git clone https://github.com/bilibili-plugins/koishi-plugin-adapter-bilibili-dm.git
```

2. **切换到文档分支**

```bash
cd koishi-plugin-adapter-bilibili-dm
git checkout docs
```

3. **安装依赖**

```bash
yarn install
```

4. **启动开发服务器**

```bash
yarn dev
```

5. **构建文档**

```bash
yarn build
```

## 文档结构

```bash
docs/
├── .vitepress/           # VitePress 配置
│   ├── config/          # 配置文件
│   │   ├── config.json  # 主配置
│   │   └── sidebar.json # 侧边栏配置
│   └── config.ts        # VitePress 配置入口
├── index.md             # 首页
├── markdown/            # 文档页面
│   ├── apis.md         # API 文档
│   ├── events.md       # 事件文档
│   ├── config.md       # 配置指南
│   ├── quick-start.md  # 快速开始
│   ├── FAQ.md          # 常见问题
│   ├── errorcodes.md   # 错误码表
│   ├── development.md  # 适配器开发指南
│   └── development-docs.md # 文档开发指南
└── public/              # 静态资源
```
