/**
 * update-zones.cjs
 * -------------------------------------------------------------
 * 每日自动更新 Gist 上的 zones.json
 *
 * 完善点：
 *   1. 数据校验：推送前校验 zones 数组完整性，避免坏数据覆盖好数据
 *   2. 变更检测：对比新旧 zones 内容，无变化时只刷新时间戳
 *   3. 备份机制：推送前在 Gist 同一份数据里保留 lastBackup 字段
 *   4. 错误处理：任一步骤失败都保留旧数据，不破坏现有服务
 *   5. 数据源框架：预留 fetchPublicNotices() 接口，后续可接入真实数据源
 * -------------------------------------------------------------
 */

const https = require('https');
const http = require('http');
const fs = require('fs');

const GIST_TOKEN = process.env.GIST_TOKEN;
const GIST_ID = process.env.GIST_ID || 'ae100eae98e9ab0b6b8494b14e0059af';
const GIST_OWNER = '3324572';

// ========== 工具函数 ==========

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'drone-query-updater', ...options.headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetch(res.headers.location, options));
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

// ========== 数据校验 ==========

/**
 * 校验单个 zone 的必填字段
 * 必须包含：id, name, level, center.lat, center.lng, radius
 */
function validateZone(zone) {
  if (!zone || typeof zone !== 'object') return false;
  if (typeof zone.id !== 'string' || !zone.id) return false;
  if (typeof zone.name !== 'string' || !zone.name) return false;
  if (typeof zone.level !== 'string' || !zone.level) return false;
  if (typeof zone.center !== 'object' || zone.center === null) return false;
  if (typeof zone.center.lat !== 'number') return false;
  if (typeof zone.center.lng !== 'number') return false;
  if (typeof zone.radius !== 'number' || zone.radius <= 0) return false;
  return true;
}

/**
 * 校验整个 zones 数组
 * 返回 { valid, errors, validCount, invalidCount }
 */
function validateZones(zones) {
  const errors = [];
  if (!Array.isArray(zones)) {
    return { valid: false, errors: ['zones is not an array'], validCount: 0, invalidCount: 0 };
  }
  if (zones.length === 0) {
    return { valid: false, errors: ['zones array is empty'], validCount: 0, invalidCount: 0 };
  }
  // 检查 id 唯一性
  const ids = new Set();
  let validCount = 0;
  for (let i = 0; i < zones.length; i++) {
    if (!validateZone(zones[i])) {
      errors.push(`zone[${i}] invalid: ${JSON.stringify(zones[i]?.id || zones[i]?.name || i)}`);
      continue;
    }
    if (ids.has(zones[i].id)) {
      errors.push(`zone[${i}] duplicate id: ${zones[i].id}`);
      continue;
    }
    ids.add(zones[i].id);
    validCount++;
  }
  return {
    valid: errors.length === 0,
    errors,
    validCount,
    invalidCount: zones.length - validCount,
  };
}

// ========== 变更检测 ==========

/**
 * 对比新旧 zones 内容是否发生变化
 * 只比较 zones 数组本身，不比较时间戳等元数据
 */
function hasContentChanged(oldZones, newZones) {
  if (!Array.isArray(oldZones) || !Array.isArray(newZones)) return true;
  if (oldZones.length !== newZones.length) return true;
  // 按 id 排序后逐项对比
  const sortById = (a, b) => a.id.localeCompare(b.id);
  const oldSorted = [...oldZones].sort(sortById);
  const newSorted = [...newZones].sort(sortById);
  for (let i = 0; i < oldSorted.length; i++) {
    const o = oldSorted[i];
    const n = newSorted[i];
    if (o.id !== n.id) return true;
    if (o.name !== n.name) return true;
    if (o.level !== n.level) return true;
    if (o.radius !== n.radius) return true;
    if (o.center?.lat !== n.center?.lat) return true;
    if (o.center?.lng !== n.center?.lng) return true;
    if (o.altitudeLimit !== n.altitudeLimit) return true;
  }
  return false;
}

// ========== 数据源抓取框架 ==========

/**
 * 从公开数据源抓取最新禁飞区通告
 * 当前为占位实现，返回 null（表示无新数据）
 *
 * TODO: 后续可接入：
 *   - 民航局公告页面抓取
 *   - 智谱 GLM API 搜索公开通告（需配置 ZHIPU_API_KEY）
 *   - 其他公开数据源
 */
async function fetchPublicNotices() {
  console.log('[fetchPublicNotices] 暂无公开数据源接入，保持现有数据不变');
  return null;
}

// ========== Gist 操作 ==========

async function getCurrentZones() {
  const url = `https://gist.githubusercontent.com/${GIST_OWNER}/${GIST_ID}/raw/zones.json`;
  try {
    const r = await fetch(url);
    if (r.status !== 200) {
      console.warn(`[getCurrentZones] HTTP ${r.status}, 使用本地兜底`);
      return null;
    }
    return JSON.parse(r.data);
  } catch (e) {
    console.warn('[getCurrentZones] 获取失败:', e.message);
    return null;
  }
}

async function updateGist(content) {
  const body = JSON.stringify({
    description: 'drone-query-zones',
    files: { 'zones.json': { content: JSON.stringify(content, null, 2) } },
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/gists/${GIST_ID}`,
      method: 'PATCH',
      headers: {
        'Authorization': `token ${GIST_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'drone-query-updater',
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, data: d }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ========== 主流程 ==========

(async () => {
  console.log('='.repeat(60));
  console.log(`[zones-updater] 开始执行 ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  // 1. 环境检查
  if (!GIST_TOKEN) {
    console.error('[FATAL] GIST_TOKEN 未设置，退出');
    process.exit(1);
  }
  console.log('[step 1] 环境检查通过: GIST_TOKEN 已配置');

  // 2. 获取当前 Gist 数据
  console.log('[step 2] 获取当前 Gist 数据...');
  const current = await getCurrentZones();
  if (!current || !current.zones) {
    console.error('[FATAL] 无法获取当前 Gist 数据且无本地兜底，退出（不破坏现有数据）');
    process.exit(1);
  }
  console.log(`[step 2] 当前数据: ${current.zones.length} 个禁飞区, updatedAt=${current.updatedAt}`);

  // 3. 校验当前数据
  console.log('[step 3] 校验当前数据...');
  const currentValidation = validateZones(current.zones);
  console.log(`[step 3] 校验结果: valid=${currentValidation.valid}, validCount=${currentValidation.validCount}, invalidCount=${currentValidation.invalidCount}`);
  if (currentValidation.errors.length > 0) {
    console.warn('[step 3] 警告:', currentValidation.errors.join('; '));
  }

  // 4. 尝试抓取公开通告（当前为占位，返回 null）
  console.log('[step 4] 尝试抓取公开通告...');
  const newNotices = await fetchPublicNotices();

  // 5. 构建新数据
  console.log('[step 5] 构建新数据...');
  const newZones = newNotices ? newNotices : current.zones;
  const contentChanged = hasContentChanged(current.zones, newZones);
  console.log(`[step 5] 内容是否变化: ${contentChanged}`);

  // 6. 校验新数据
  console.log('[step 6] 校验新数据...');
  const newValidation = validateZones(newZones);
  if (!newValidation.valid) {
    console.error('[step 6] 新数据校验失败:', newValidation.errors.join('; '));
    console.error('[step 6] 放弃更新，保留旧数据');
    process.exit(1);
  }
  console.log(`[step 6] 新数据校验通过: ${newValidation.validCount} 个有效禁飞区`);

  // 7. 构建最终数据（保留旧数据备份）
  const now = new Date().toISOString();
  const finalData = {
    ...current,
    zones: newZones,
    updatedAt: now,
    lastUpdateSource: contentChanged ? 'github-actions-daily-updated' : 'github-actions-daily-heartbeat',
    lastContentChange: contentChanged ? now : (current.lastContentChange || current.updatedAt || now),
    dataSource: 'based on public notices, not UOM real-time data',
    // 备份上一次的数据（仅保留 zones 和时间戳，避免数据过大）
    lastBackup: {
      updatedAt: current.updatedAt,
      zonesCount: current.zones.length,
      zones: current.zones,
    },
  };

  // 8. 推送到 Gist
  console.log('[step 8] 推送到 Gist...');
  const r = await updateGist(finalData);
  if (r.status === 200) {
    console.log('[step 8] Gist 更新成功');
  } else {
    console.error(`[step 8] Gist 更新失败: HTTP ${r.status}`);
    console.error(r.data);
    process.exit(1);
  }

  // 9. 保存本地快照（供 commit）
  try {
    fs.writeFileSync('zones.json', JSON.stringify(finalData, null, 2));
    console.log('[step 9] 本地快照已保存');
  } catch (e) {
    console.warn('[step 9] 本地快照保存失败（不影响 Gist 更新）:', e.message);
  }

  console.log('='.repeat(60));
  console.log(`[zones-updater] 完成 ${new Date().toISOString()}`);
  console.log(`  禁飞区数量: ${newZones.length}`);
  console.log(`  内容变化: ${contentChanged ? '是' : '否'}`);
  console.log(`  更新类型: ${contentChanged ? '内容更新' : '心跳刷新'}`);
  console.log('='.repeat(60));
})();
