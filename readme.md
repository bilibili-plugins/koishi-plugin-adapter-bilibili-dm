# Bilibili Adapter for Koishi

[![npm version](https://img.shields.io/npm/v/koishi-plugin-adapter-bilibili-dm?color=blue)](https://www.npmjs.com/package/koishi-plugin-adapter-bilibili-dm)
[![npm downloads](https://img.shields.io/npm/dm/koishi-plugin-adapter-bilibili-dm)](https://www.npmjs.com/package/koishi-plugin-adapter-bilibili-dm)
[![platform](https://img.shields.io/badge/platform-Koishi-blueviolet)](https://koishi.chat/)
[![license](https://img.shields.io/github/license/roberta001/koishi-plugin-adapter-bilibili-dm)](https://github.com/roberta001/koishi-plugin-adapter-bilibili-dm?tab=MIT-1-ov-file)

> 哔哩哔哩适配器

![preview.gif](https://raw.githubusercontent.com/Roberta001/koishi-plugin-adapter-bilibili-dm/refs/heads/docs/screenshot/preview.gif)

## 快速开始

1. 安装插件
2. 获取你的 Bilibili UID
3. 在 Koishi 控制台中配置插件并启用
4. 使用 APP 扫码登录获取认证信息

## 支持状态

| 功能     | 状态 | 说明                 |
| -------- | ---- | -------------------- |
| 接收私信 | ✅    | 实时接收消息         |
| 发送私信 | ✅    | 发送文本/图片        |
| 用户信息 | ✅    | 获取公开资料         |
| 关注管理 | ✅    | 关注/取关操作        |
| 动态监听 | ✅    | 实时监听关注UP主动态 |
| 直播监听 | ✅    | 监听开播/下播事件    |
| 直播弹幕 | ✅    | 进入直播间监听弹幕   |
| 搜索功能 | ✅    | 搜索用户/视频/综合   |
| 消息撤回 | ✅    | 撤回已发消息         |
| 语音消息 | ❌    | 不支持               |
| 视频消息 | ❌    | 不支持               |

## 文档

详细使用说明请查看

-> <https://roberta001.github.io/koishi-plugin-adapter-bilibili-dm/>

## 开发

```bash
# 在koishi项目模板 克隆项目
yarn clone Roberta001/koishi-plugin-adapter-bilibili-dm

# 开发模式
yarn dev
```

## 许可证

[MIT License](LICENSE)

## 项目鸣谢

- <https://github.com/SocialSisterYi/bilibili-API-collect>
