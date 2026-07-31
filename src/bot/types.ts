//  src\types.ts
export interface BiliApiResponse<T>
{
  code: number;
  message: string;
  msg?: string;
  ttl: number;
  data?: T;
}

// 扩展 BiliApiResponse 的 data 字段，使其可以包含 msg_key
// 这样可以避免在 JSON 解析时将大数字转换为浮点数
export interface BiliSendMessageResponseData
{
  msg_key: string; // 将 msg_key 定义为 string
  msg_content?: string;
  key_hit_infos?: Record<string, any>;
}

// from private_msg.md -> 私信主体对象
// 私信消息对象
export interface PrivateMessage
{
  sender_uid: string; // 发送者UID
  receiver_type: number; // 接收者类型：1: 用户, 2: 群组
  receiver_id: number; // 接收者ID
  msg_type: number; // 消息类型
  content: string; // 消息内容 (JSON字符串)
  msg_seqno: number; // 消息序列号
  timestamp: number; // 消息时间戳
  at_uids: number[] | null; // @的用户UID列表
  msg_key: string; // 消息唯一键
  msg_status: number; // 消息状态：0: 正常, 1: 撤回
  notify_code: string;
  new_face_version: number;
  msg_source?: number; // 消息来源：5=官方推送, 6=推送通知, 8-11=自动回复, 12=UP主赠言, 13=粉丝团提示, 16=系统, 17=互相关注, 18=系统提示, 19=AI回复
}

// from private_msg.md -> 会话对象
// 会话信息对象
export interface SessionInfo
{
  talker_id: number; // 会话对象ID (用户UID)
  session_type: number; // 会话类型
  ack_seqno: number; // 已确认的序列号
  ack_ts: number; // 已确认的时间戳
  session_ts: number; // 会话时间戳
  unread_count: number; // 未读消息数量
  last_msg: PrivateMessage | null; // 最后一条消息
  max_seqno: number; // 最大序列号
  is_follow: number; // 是否关注
  is_dnd: number; // 是否免打扰
}

// /new_sessions 接口的响应数据
export interface NewSessionsData
{
  session_list?: SessionInfo[]; // 会话列表
  has_more: number; // 是否有更多会话：0: 没有，1: 有
}

// /fetch_session_msgs 接口的响应数据
export interface SessionMessagesData
{
  messages?: PrivateMessage[]; // 消息列表
  has_more: number; // 是否有更多消息：0: 没有，1: 有
  min_seqno: number; // 最小序列号
  max_seqno: number; // 最大序列号
}

export interface QrCodeData
{
  url: string; // 二维码图片URL
  qrcode_key: string; // 二维码唯一键
}
export interface QrCodePollResult
{
  status: 'waiting' | 'scanned' | 'success' | 'expired' | 'error';
  message: string; // 状态消息
  cookies?: Record<string, string>;
}
export interface MyInfoData
{
  name: string;
  mid: number;
  face: string;
}

// 从 /nav 接口获取的WBI密钥图片信息
export interface NavWbiImg
{
  img_url: string; // WBI密钥图片URL
  sub_url: string; // WBI密钥子图片URL
}
// WBI密钥
export interface WbiKeys
{
  img_key: string; // 图片密钥
  sub_key: string; // 子密钥
}

// 上传图片响应数据
export interface UploadImageData
{
  image_url: string; // 图片URL
  image_width: number; // 图片宽度
  image_height: number; // 图片高度
  img_size?: number; // 图片大小 (字节)
}

// 机器人登录保存的cookie
export interface BilibiliCookie
{
  SESSDATA: string;
  bili_jct: string;
  DedeUserID: string;
  wbi_img_key?: string;
  wbi_sub_key?: string;
  wbi_mixin_key?: string;
  wbi_timestamp?: number;
}

// 机器人登录状态
export type BotLoginStatus = {
  status: 'init' | 'qrcode' | 'continue' | 'success' | 'error' | 'offline';
  selfId: string;
  image?: string;
  message?: string;
};

// 插件配置接口
export interface PluginConfig
{
  selfId: string;
  loggerinfo: boolean;
  loggerLiveInfo: boolean;
  avatarBase64: boolean;
  pollInterval: number;
  maxCacheSize: number;
  nestedblocked: {
    blockedUids: { name: string; uid: string; }[];
  };
  ignoreOfflineMessages: boolean;
  pollFailureThreshold: number;
  pollAutoShutdownThreshold: number;
  enableDynamicPolling: boolean;
  dynamicPollInterval: number;
  enableLivePolling: boolean;
  livePollInterval: number;
}
