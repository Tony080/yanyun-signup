const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/**
 * 一次性迁移脚本：
 * 1. 给所有现有 slots 补 activityType 字段（默认 raid 的 ID）
 * 2. 初始化 activities 配置（如果不存在）
 *
 * 在云开发控制台 → 云函数 → migrate → 云端测试 手动执行一次
 */
exports.main = async (event, context) => {
  var raidId = 'a1b2c3d4';
  var speedId = 'e5f6g7h8';

  // 1. 初始化 activities 配置
  var configRes = await db.collection('config').where({ type: 'activities' }).limit(1).get();

  if (configRes.data.length === 0) {
    await db.collection('config').add({
      data: {
        type: 'activities',
        activities: [
          {
            id: raidId,
            name: '十人本',
            maxPerCar: 10,
            startHour: 12,
            endHour: 22,
            roles: [
              { name: '输出', color: '#58a6ff' },
              { name: '霖霖', color: '#3fb950' }
            ],
            createdAt: new Date().toISOString()
          },
          {
            id: speedId,
            name: '竞速十人本',
            maxPerCar: 10,
            startHour: 12,
            endHour: 22,
            roles: [
              { name: '输出', color: '#58a6ff' },
              { name: '霖霖', color: '#3fb950' }
            ],
            createdAt: new Date().toISOString()
          }
        ]
      }
    });
    console.log('[迁移] 已创建 activities 配置');
  } else {
    console.log('[迁移] activities 配置已存在，跳过');
  }

  // 2. 给所有没有 activityType 的 slots 补上默认值
  var updated = 0;
  var batchSize = 20;

  while (true) {
    var slotsRes = await db.collection('slots')
      .where({ activityType: _.exists(false) })
      .limit(batchSize)
      .get();

    if (slotsRes.data.length === 0) break;

    for (var i = 0; i < slotsRes.data.length; i++) {
      await db.collection('slots').doc(slotsRes.data[i]._id).update({
        data: { activityType: raidId }
      });
      updated++;
    }

    console.log('[迁移] 已更新 ' + updated + ' 条 slots');
  }

  console.log('[迁移完成] 共更新 ' + updated + ' 条 slots');
  return { activitiesCreated: configRes.data.length === 0, slotsUpdated: updated };
};
