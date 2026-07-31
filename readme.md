# Bilibili Adapter for Koishi

[![npm version](https://img.shields.io/npm/v/koishi-plugin-adapter-bilibili-dm?color=blue)](https://www.npmjs.com/package/koishi-plugin-adapter-bilibili-dm) [![npm downloads](https://img.shields.io/npm/dm/koishi-plugin-adapter-bilibili-dm)](https://www.npmjs.com/package/koishi-plugin-adapter-bilibili-dm) [![platform](https://img.shields.io/badge/platform-Koishi-blueviolet)](https://koishi.chat/) [![license](https://img.shields.io/github/license/bilibili-plugins/koishi-plugin-adapter-bilibili-dm)](https://github.com/bilibili-plugins/koishi-plugin-adapter-bilibili-dm?tab=MIT-1-ov-file)

## 哔哩哔哩适配器

![preview.gif](https://raw.githubusercontent.com/bilibili-plugins/koishi-plugin-adapter-bilibili-dm/refs/heads/docs/screenshot/preview.gif)

## 快速开始

1. 安装插件
2. 获取你的 Bilibili UID
3. 在 Koishi 控制台中配置插件并启用
4. 使用 APP 扫码登录获取认证信息

## 支持状态

| 功能     | 状态 | 说明                    |
| -------- | ---- | ----------------------- |
| 收发私信 | ✅    | 收发消息支持            |
| 收发评论 | ✅    | 收发消息支持            |
| 消息撤回 | ✅    | 撤回已发送的私信        |
| 用户信息 | ✅    | 获取公开资料            |
| 关注管理 | ✅    | 关注/取关操作           |
| 动态监听 | ✅    | 监听动态、事件下发      |
| 直播监听 | ✅    | 监听开播/下播、事件下发 |
| 直播弹幕 | ✅    | 进入直播间、监听弹幕    |
| 搜索功能 | ✅    | 搜索用户/视频/综合      |

## 文档

详细使用说明请查看

-> <https://bilibili-plugins.github.io/koishi-plugin-adapter-bilibili-dm/>

## 开发

```bash
# 在koishi项目模板 克隆项目
yarn clone bilibili-plugins/koishi-plugin-adapter-bilibili-dm

# 开发模式
yarn dev
```

## 许可证

[MIT License](LICENSE)

## 项目鸣谢

- <https://github.com/SocialSisterYi/bilibili-API-collect>
- <https://github.com/renmu123/biliAPI>
- <https://github.com/xiaopeng12138/adapter-whatsapp-web/blob/master/client/settings.vue>
