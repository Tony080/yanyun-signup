/**
 * 从云数据库 config 集合读取密钥
 *
 * 在云开发控制台 → 数据库 → 创建 config 集合 → 添加一条文档：
 * {
 *   "type": "secrets",
 *   "DISCORD_BOT_TOKEN": "你的bot token",
 *   "WX_TMPL_ID": "你的微信模板ID",
 *   "ADMIN_KEY": "你的管理密码"
 * }
 *
 * 权限设置为：仅管理员可读写（所有人不可读）
 */

let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

async function getSecrets(db) {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;

  try {
    var res = await db.collection('config').where({ type: 'secrets' }).limit(1).get();
    if (res.data.length > 0) {
      _cache = res.data[0];
      _cacheTime = Date.now();
      return _cache;
    }
  } catch (e) {
    console.warn('[config] 读取 secrets 失败:', e.message);
  }

  return {};
}

module.exports = { getSecrets };
