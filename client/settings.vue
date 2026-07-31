<!-- external/adapter-bilibili-dm/client/settings.vue -->
<template>
  <div v-if="data" class="bilibili-dm-settings">
    <!-- 只有当 data 有值时才渲染 k-comment -->
    <k-comment v-if="data" :type="getCommentType(data.status)">
      <template v-if="data.status === 'offline'">
        <p>机器人离线</p>
        <k-button class="relogin-button" @click="startLogin(data.selfId)">重新登录</k-button>
      </template>

      <template v-else-if="data.status === 'error'">
        <p>{{ data.message }}</p>
        <k-button class="relogin-button" @click="startLogin(data.selfId)">重新登录</k-button>
      </template>

      <template v-else-if="data.status === 'init'">
        <p>{{ data.message || '正在获取登录状态...' }}</p>
        <k-progress indeterminate />
      </template>

      <template v-else-if="data.status === 'continue'">
        <p>{{ data.message }}</p>
        <k-progress indeterminate />
      </template>

      <template v-else-if="data.status === 'success'">
        <p>{{ data.message }}</p>
        <div class="status-icon success">
          <k-icon name="check-circle" />
        </div>
        <k-button class="relogin-button" @click="startLogin(data.selfId)">重新登录</k-button>
      </template>

      <template v-else-if="data.status === 'qrcode'">
        <div class="qrcode-instructions">
          <p v-if="data.message">{{ data.message }}</p>
          <p v-if="data.message === '请使用手机扫描二维码'">请在两分钟内使用手机端扫描并确认登录。</p>
        </div>
        <div class="qrcode-container">
          <img v-if="data.image" class="qrcode" :src="data.image" alt="Bilibili 登录二维码" />
          <div class="refresh-overlay" v-if="qrCodeExpired">
            <p>二维码已过期</p>
            <k-button @click="startLogin(data.selfId)">刷新二维码</k-button>
          </div>
        </div>
        <div class="qrcode-actions">
          <k-button @click="startLogin(data.selfId)" :disabled="qrCodeLoading">
            <template v-if="qrCodeLoading">
              <k-icon name="loader" class="rotating" />
              刷新中...
            </template>
            <template v-else>
              <k-icon name="refresh-cw" />
              刷新二维码
            </template>
          </k-button>
        </div>
      </template>
    </k-comment>
  </div>
</template>

<script lang="ts" setup>
import { computed, ref, watch, onMounted, onUnmounted, inject } from 'vue';
import { store, send } from "@koishijs/client";

// 二维码状态
const qrCodeExpired = ref(false);
const qrCodeLoading = ref(false);
const qrCodeTimer = ref<number | null>(null);
const qrCodeExpiryTime = ref<number | null>(null);

const local = inject('manager.settings.local', ref({ name: '' })) as any;
const config = inject('manager.settings.config', ref({})) as any;
const current = inject('manager.settings.current', ref({})) as any;

/*
// 调试时 要取消注释
console.group("==================== Bilibili DM Plugin Debug ====================")
// 确保 local.value 存在，再访问 name 属性
console.log("local.value?.name", local.value?.name)
console.log("config", config) // 打印整个 store 对象
console.log("current",current)
console.groupEnd()
*/

// 插件的预期名称 包名
const PLUGIN_NAME = 'koishi-plugin-adapter-bilibili-dm';

const data = computed(() =>
{
  // 名称不匹配，返回 null，阻止组件渲染
  if (!local.value || local.value.name !== PLUGIN_NAME)
  {
    return null;
  }

  // 未启用的配置实例不显示适配器状态面板。
  if (current.value?.disabled === true)
  {
    return null;
  }

  const currentSelfId = config.value?.selfId;
  if (!currentSelfId)
  {
    console.warn('[Bilibili DM] 无法获取当前配置的selfId');
    return null;
  }

  const serviceId = `bilibili-dm-${currentSelfId}`;
  console.log(`[Bilibili DM] 尝试从服务 "${serviceId}" 获取数据，当前selfId: ${currentSelfId}`);

  // 从 store 中获取对应服务ID的数据
  const serviceData = (store as any)[serviceId];
  if (!serviceData)
  {
    console.warn(`[Bilibili DM] 未找到服务 "${serviceId}" 的数据`);
    return null;
  }

  const instanceData = serviceData[currentSelfId];
  if (!instanceData)
  {
    console.log('[Bilibili DM] 未找到selfId为', currentSelfId, '的状态数据，创建初始状态');
     return {
       status: 'init',
       selfId: currentSelfId,
       message: '正在获取登录状态...'
     };
  }

  if (instanceData && (!instanceData.selfId || instanceData.selfId !== currentSelfId))
  {
    console.log('[Bilibili DM] 状态对象的selfId不正确，修正为:', currentSelfId);
    instanceData.selfId = currentSelfId;
  }

  console.log('[Bilibili DM] 成功获取实例数据:', instanceData);
  return instanceData;
});

// 监听状态变化
watch(() => data.value?.status, (newStatus: string | undefined, oldStatus: string | undefined) =>
{
  if (newStatus === 'qrcode')
  {
    qrCodeLoading.value = false;
    startQrCodeExpiryTimer();
  } else if (newStatus === 'error' && oldStatus === 'qrcode')
  {
    // 如果从qrcode状态变为error状态，可能是二维码过期
    qrCodeExpired.value = true;
  }
}, { immediate: true }); // 立即执行一次，以处理初始状态

// 设置二维码过期计时器（二维码通常有效期为3分钟） B站好像是2分钟？
function startQrCodeExpiryTimer()
{
  clearQrCodeExpiryTimer();

  qrCodeExpiryTime.value = Date.now() + 3 * 60 * 1000; // 3分钟后过期
  qrCodeExpired.value = false;

  // 每秒更新剩余时间
  qrCodeTimer.value = window.setInterval(() =>
  {
    if (!qrCodeExpiryTime.value) return;

    const timeLeft = Math.max(0, qrCodeExpiryTime.value - Date.now());

    if (timeLeft <= 0)
    {
      qrCodeExpired.value = true;
      clearQrCodeExpiryTimer();
    }
  }, 1000) as unknown as number;
}

// 清除二维码过期计时器
function clearQrCodeExpiryTimer()
{
  if (qrCodeTimer.value)
  {
    window.clearInterval(qrCodeTimer.value);
    qrCodeTimer.value = null;
  }
  qrCodeExpiryTime.value = null;
}

// 组件卸载时清除计时器
onUnmounted(() =>
{
  clearQrCodeExpiryTimer();
});

// 启动登录
function startLogin(selfId: string)
{
  qrCodeExpired.value = false;
  qrCodeLoading.value = true;

  const loginEventName = `bilibili-dm-${selfId}/start-login`;
  console.log(`[Bilibili DM] 发送登录请求到事件: ${loginEventName}, selfId: ${selfId}, config.value?.selfId: ${config.value?.selfId}`);

  send(loginEventName as any, {
    selfId: selfId || config.value?.selfId
  });
}

function getCommentType(status?: string)
{
  if (!status) return 'warning';
  if (status === 'init' || status === 'continue') return 'warning';
  if (status === 'error') return 'error';
  if (status === 'success') return 'success';
  if (status === 'qrcode') return 'warning';
  return 'warning';
}
</script>

<style lang="scss" scoped>
.bilibili-dm-settings {
  padding: 0;
  margin-top: -1rem; // 顶部间距
  margin-bottom: -1rem; // 底部间距

  .qrcode-container {
    position: relative;
    display: inline-block;
    margin: 1rem 0 0.35rem;
    border: 1px solid #eee;
    padding: 10px;
    border-radius: 8px;
    background-color: white;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  .qrcode {
    display: block;
    max-width: 200px;
    image-rendering: pixelated;
  }

  .qrcode-instructions {
    margin-bottom: 0.75rem;

    p {
      margin: 0.25rem 0;
    }
  }

  .refresh-overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.7);
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    color: white;
    border-radius: 8px;
  }

  .qrcode-actions {
    margin-top: 0;
    display: flex;
    gap: 0.5rem;
  }

  .status-icon {
    font-size: 2rem;
    margin: 1rem 0;

    &.success {
      color: #52c41a;
    }
  }

  .k-button {
    margin-top: 0.5rem;
    margin-bottom: 0.8rem;
  }

  .relogin-button {
    border-width: 2px;
  }

  .k-progress {
    margin-top: 1rem;
  }

  .rotating {
    animation: rotate 1s linear infinite;
  }

  @keyframes rotate {
    from {
      transform: rotate(0deg);
    }

    to {
      transform: rotate(360deg);
    }
  }
}
</style>
