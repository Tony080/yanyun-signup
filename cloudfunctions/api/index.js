const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { getSecrets } = require('./config');

// ===== 路由 =====

exports.main = async (event) => {
  const { action, userId, ...params } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || userId;

  const handlers = {
    getSlots, join, quickJoin, createTeam, leave, move,
    updateNickname, setRecurring, removeProxy
  };
  const adminHandlers = { adminList, adminRemove, adminBan, adminUnban };
  const allHandlers = Object.assign({}, handlers, adminHandlers);

  if (!allHandlers[action]) {
    return { success: false, message: '未知操作: ' + action };
  }

  if (adminHandlers[action]) {
    return await adminHandlers[action](params);
  }

  if (action === 'getSlots') {
    return await handlers[action](openid, params);
  }

  if (!openid) {
    return { success: false, message: '无法识别用户' };
  }

  // 封禁检查（报名类操作）
  if (action === 'join' || action === 'quickJoin' || action === 'createTeam') {
    var userCheck = await db.collection('users').where({ openid: openid }).get();
    if (userCheck.data.length > 0 && userCheck.data[0].banned) {
      return { success: false, message: '你的账号已被管理员限制报名' };
    }
  }

  try {
    return await handlers[action](openid, params);
  } catch (err) {
    console.error('[api]', action, err);
    return { success: false, message: '服务器错误' };
  }
};

// ===== 获取报名数据 =====

async function getSlots(openid, { weekDate }) {
  var res = await db.collection('slots')
    .where({ weekDate })
    .orderBy('hour', 'asc')
    .orderBy('carIndex', 'asc')
    .limit(100)
    .get();
  return { success: true, slots: res.data };
}

// ===== 旧版报名（向后兼容，等同 quickJoin） =====

async function join(openid, params) {
  return await quickJoin(openid, params);
}

// ===== 快速加入 =====

async function quickJoin(openid, { weekDate, hour, nickname, role, recurring, extraMembers }) {
  role = role || '输出';

  // 检查本周是否已报名
  var existing = await db.collection('slots')
    .where({ weekDate, members: _.elemMatch({ openid }) })
    .get();
  if (existing.data.length > 0) {
    return { success: false, message: '你本周已报名，请使用挪动切换时段' };
  }

  var targetCar;
  var resultHour;

  if (hour != null) {
    // 指定时段：找 count 最大的非满车（优先填满车）
    targetCar = await findBestCar(weekDate, hour);
    resultHour = hour;
  } else {
    // 随缘：跨所有时段找 count 最大的非满车
    targetCar = await findBestCarAnyHour(weekDate);
    resultHour = targetCar ? targetCar.hour : 14; // 全空默认14:00
  }

  // 计算所有要加入的人（自己 + 代报名）
  var allMembers = [{ openid: openid, nickname: nickname, role: role, registeredBy: null }];
  if (extraMembers && extraMembers.length > 0) {
    extraMembers.forEach(function(em, i) {
      allMembers.push({
        openid: openid + '_p' + i,
        nickname: em.nickname,
        role: em.role || '输出',
        registeredBy: openid
      });
    });
  }

  // 加入车（可能溢出到新车）
  var result = await addMembersToCar(weekDate, resultHour, targetCar, allMembers, null);

  // 保存 role 到用户表
  await saveUserRole(openid, role);

  // 处理 recurring
  if (recurring === true) {
    await setUserRecurring(openid, resultHour);
  } else if (recurring === false) {
    await clearUserRecurring(openid);
  }

  return { success: true, hour: resultHour, carIndex: result.carIndex };
}

// ===== 创建车队 =====

async function createTeam(openid, { weekDate, hour, nickname, role, recurring, extraMembers }) {
  role = role || '输出';

  // 检查本周是否已报名
  var existing = await db.collection('slots')
    .where({ weekDate, members: _.elemMatch({ openid }) })
    .get();
  if (existing.data.length > 0) {
    return { success: false, message: '你本周已报名，请先退出再创建车队' };
  }

  // 计算所有要加入的人
  var allMembers = [{ openid: openid, nickname: nickname, role: role, registeredBy: null }];
  if (extraMembers && extraMembers.length > 0) {
    extraMembers.forEach(function(em, i) {
      allMembers.push({
        openid: openid + '_p' + i,
        nickname: em.nickname,
        role: em.role || '输出',
        registeredBy: openid
      });
    });
  }

  // 始终创建新车，leader 为自己
  var result = await addMembersToCar(weekDate, hour, null, allMembers, openid);

  await saveUserRole(openid, role);

  if (recurring === true) {
    await setUserRecurring(openid, hour);
  } else if (recurring === false) {
    await clearUserRecurring(openid);
  }

  return { success: true, hour: hour, carIndex: result.carIndex };
}

// ===== 退出 =====

async function leave(openid, { weekDate }) {
  var existing = await db.collection('slots')
    .where({ weekDate, members: _.elemMatch({ openid }) })
    .get();

  if (existing.data.length === 0) {
    return { success: false, message: '你本周未报名' };
  }

  var slot = existing.data[0];

  // 同时移除自己和自己代报的人
  var newMembers = slot.members.filter(function(m) {
    return m.openid !== openid && m.registeredBy !== openid;
  });

  // 处理 leader
  var updateData = { members: newMembers, count: newMembers.length, full: false };
  if (slot.leader === openid) {
    updateData.leader = null;
  }

  if (newMembers.length === 0) {
    await db.collection('slots').doc(slot._id).remove();
  } else {
    await db.collection('slots').doc(slot._id).update({ data: updateData });
  }

  return { success: true };
}

// ===== 挪动 =====

async function move(openid, { weekDate, targetHour, nickname, role }) {
  var existing = await db.collection('slots')
    .where({ weekDate, members: _.elemMatch({ openid }) })
    .get();

  if (existing.data.length === 0) {
    return { success: false, message: '你本周未报名' };
  }

  var currentSlot = existing.data[0];
  if (currentSlot.hour === targetHour) {
    return { success: false, message: '你已在该时段' };
  }

  // 收集自己和自己代报的人
  var myMembers = currentSlot.members.filter(function(m) {
    return m.openid === openid || m.registeredBy === openid;
  });
  var myMember = myMembers.find(function(m) { return m.openid === openid; });
  var myRole = (myMember && myMember.role) || role || '输出';

  // 从老车移除
  var newMembers = currentSlot.members.filter(function(m) {
    return m.openid !== openid && m.registeredBy !== openid;
  });
  var updateData = { members: newMembers, count: newMembers.length, full: false };
  if (currentSlot.leader === openid) {
    updateData.leader = null; // 离开时失去 leader
  }

  if (newMembers.length === 0) {
    await db.collection('slots').doc(currentSlot._id).remove();
  } else {
    await db.collection('slots').doc(currentSlot._id).update({ data: updateData });
  }

  // 更新 recurring
  var userRes = await db.collection('users').where({ openid }).get();
  if (userRes.data.length > 0 && userRes.data[0].recurringHour != null) {
    await setUserRecurring(openid, targetHour);
  }

  // 加入目标时段（带上代报的人，但不保留 leader）
  var targetCar = await findBestCar(weekDate, targetHour);
  var allToMove = [{ openid: openid, nickname: nickname || myMember.nickname, role: myRole, registeredBy: null }];
  myMembers.forEach(function(m) {
    if (m.openid !== openid) {
      allToMove.push({ openid: m.openid, nickname: m.nickname, role: m.role, registeredBy: openid });
    }
  });
  var result = await addMembersToCar(weekDate, targetHour, targetCar, allToMove, null);

  return { success: true, hour: targetHour, carIndex: result.carIndex };
}

// ===== 移除代报名 =====

async function removeProxy(openid, { weekDate, targetOpenid }) {
  var existing = await db.collection('slots')
    .where({ weekDate, members: _.elemMatch({ openid: targetOpenid }) })
    .get();

  if (existing.data.length === 0) {
    return { success: false, message: '找不到该成员' };
  }

  var slot = existing.data[0];
  var target = slot.members.find(function(m) { return m.openid === targetOpenid; });

  if (!target || target.registeredBy !== openid) {
    return { success: false, message: '只能移除自己代报的人' };
  }

  var newMembers = slot.members.filter(function(m) { return m.openid !== targetOpenid; });

  if (newMembers.length === 0) {
    await db.collection('slots').doc(slot._id).remove();
  } else {
    await db.collection('slots').doc(slot._id).update({
      data: { members: newMembers, count: newMembers.length, full: newMembers.length >= 10 }
    });
  }

  return { success: true };
}

// ===== 核心工具：查找最佳车 =====

// 指定时段找 count 最大的非满车（优先填满车，优先有 leader 的车）
async function findBestCar(weekDate, hour) {
  var cars = await db.collection('slots')
    .where({ weekDate, hour: hour, full: _.neq(true) })
    .orderBy('count', 'desc')
    .limit(20)
    .get();

  if (cars.data.length === 0) return null;

  // 有 leader 的车优先
  var withLeader = cars.data.filter(function(c) { return c.leader; });
  if (withLeader.length > 0) return withLeader[0];
  return cars.data[0];
}

// 跨所有时段找 count 最大的非满车
async function findBestCarAnyHour(weekDate) {
  var cars = await db.collection('slots')
    .where({ weekDate, full: _.neq(true) })
    .orderBy('count', 'desc')
    .limit(20)
    .get();

  if (cars.data.length === 0) return null;

  var withLeader = cars.data.filter(function(c) { return c.leader; });
  if (withLeader.length > 0) return withLeader[0];
  return cars.data[0];
}

// 把多个成员加入车（处理溢出到新车）
async function addMembersToCar(weekDate, hour, targetCar, members, leader) {
  var firstCarIndex = null;

  for (var i = 0; i < members.length; i++) {
    var m = members[i];

    if (targetCar && targetCar.count < 10) {
      // 加入现有车
      var newCount = targetCar.count + 1;
      await db.collection('slots').doc(targetCar._id).update({
        data: {
          members: _.push({
            openid: m.openid, nickname: m.nickname,
            role: m.role || '输出', registeredBy: m.registeredBy || null,
            joinedAt: db.serverDate()
          }),
          count: newCount,
          full: newCount >= 10
        }
      });
      targetCar.count = newCount;
      if (firstCarIndex === null) firstCarIndex = targetCar.carIndex;

      if (newCount >= 10) {
        await onCarFull(weekDate, hour, targetCar.carIndex + 1, []);
        targetCar = null; // 满了，下一个人开新车
      }
    } else {
      // 开新车
      var allCars = await db.collection('slots')
        .where({ weekDate, hour })
        .orderBy('carIndex', 'desc')
        .limit(1)
        .get();
      var newCarIndex = allCars.data.length > 0 ? allCars.data[0].carIndex + 1 : 0;

      var newCarData = {
        weekDate: weekDate, hour: hour, carIndex: newCarIndex,
        members: [{
          openid: m.openid, nickname: m.nickname,
          role: m.role || '输出', registeredBy: m.registeredBy || null,
          joinedAt: db.serverDate()
        }],
        count: 1, full: false,
        leader: (i === 0 && leader) ? leader : null,
        createdAt: db.serverDate()
      };

      var addRes = await db.collection('slots').add({ data: newCarData });

      // 记住新车供后续成员加入
      targetCar = { _id: addRes._id, carIndex: newCarIndex, count: 1 };
      if (firstCarIndex === null) firstCarIndex = newCarIndex;
    }
  }

  return { carIndex: firstCarIndex };
}

// ===== 更新昵称 =====

async function updateNickname(openid, { nickname }) {
  var userRes = await db.collection('users').where({ openid }).get();
  if (userRes.data.length > 0) {
    await db.collection('users').doc(userRes.data[0]._id).update({ data: { nickname } });
  }

  var slotsRes = await db.collection('slots')
    .where({ members: _.elemMatch({ openid }) })
    .get();

  var updates = slotsRes.data.map(function(slot) {
    var updatedMembers = slot.members.map(function(m) {
      return m.openid === openid ? Object.assign({}, m, { nickname: nickname }) : m;
    });
    return db.collection('slots').doc(slot._id).update({ data: { members: updatedMembers } });
  });

  await Promise.all(updates);
  return { success: true };
}

// ===== 设置/取消每周自动报名 =====

async function setRecurring(openid, { hour }) {
  if (hour != null) {
    await setUserRecurring(openid, hour);
  } else {
    await clearUserRecurring(openid);
  }
  return { success: true };
}

// ===== 内部工具 =====

async function saveUserRole(openid, role) {
  if (!role) return;
  var res = await db.collection('users').where({ openid }).get();
  if (res.data.length > 0) {
    await db.collection('users').doc(res.data[0]._id).update({ data: { role: role } });
  }
}

async function setUserRecurring(openid, hour) {
  var res = await db.collection('users').where({ openid }).get();
  if (res.data.length > 0) {
    await db.collection('users').doc(res.data[0]._id).update({ data: { recurringHour: hour } });
  }
}

async function clearUserRecurring(openid) {
  var res = await db.collection('users').where({ openid }).get();
  if (res.data.length > 0) {
    await db.collection('users').doc(res.data[0]._id).update({ data: { recurringHour: _.remove() } });
  }
}

async function onCarFull(weekDate, hour, carNumber, members) {
  console.log('[满车]', weekDate, hour + ':00', '第' + carNumber + '车');
}

// ===== 管理员功能 =====

async function checkAdmin(adminKey) {
  var secrets = await getSecrets(db);
  return adminKey === secrets.ADMIN_KEY;
}

async function adminList({ weekDate, adminKey }) {
  if (!(await checkAdmin(adminKey))) return { success: false, message: '密码错误' };

  var slotsRes = await db.collection('slots')
    .where({ weekDate: weekDate })
    .orderBy('hour', 'asc')
    .orderBy('carIndex', 'asc')
    .limit(100)
    .get();

  var openids = [];
  slotsRes.data.forEach(function(s) {
    s.members.forEach(function(m) {
      if (openids.indexOf(m.openid) === -1) openids.push(m.openid);
    });
  });

  var usersMap = {};
  if (openids.length > 0) {
    var usersRes = await db.collection('users')
      .where({ openid: _.in(openids) })
      .limit(100)
      .get();
    usersRes.data.forEach(function(u) {
      usersMap[u.openid] = { nickname: u.nickname, banned: !!u.banned, recoveryCode: u.recoveryCode || '' };
    });
  }

  return { success: true, slots: slotsRes.data, users: usersMap };
}

async function adminRemove({ weekDate, targetOpenid, adminKey }) {
  if (!(await checkAdmin(adminKey))) return { success: false, message: '密码错误' };

  var existing = await db.collection('slots')
    .where({ weekDate: weekDate, members: _.elemMatch({ openid: targetOpenid }) })
    .get();

  if (existing.data.length === 0) return { success: false, message: '该用户本周未报名' };

  var slot = existing.data[0];
  var newMembers = slot.members.filter(function(m) { return m.openid !== targetOpenid; });

  var updateData = { members: newMembers, count: newMembers.length, full: false };
  if (slot.leader === targetOpenid) updateData.leader = null;

  if (newMembers.length === 0) {
    await db.collection('slots').doc(slot._id).remove();
  } else {
    await db.collection('slots').doc(slot._id).update({ data: updateData });
  }

  return { success: true, message: '已移除' };
}

async function adminBan({ targetOpenid, adminKey }) {
  if (!(await checkAdmin(adminKey))) return { success: false, message: '密码错误' };

  var userRes = await db.collection('users').where({ openid: targetOpenid }).get();
  if (userRes.data.length === 0) return { success: false, message: '用户不存在' };

  await db.collection('users').doc(userRes.data[0]._id).update({
    data: { banned: true, recurringHour: _.remove() }
  });

  return { success: true, message: '已封禁' };
}

async function adminUnban({ targetOpenid, adminKey }) {
  if (!(await checkAdmin(adminKey))) return { success: false, message: '密码错误' };

  var userRes = await db.collection('users').where({ openid: targetOpenid }).get();
  if (userRes.data.length === 0) return { success: false, message: '用户不存在' };

  await db.collection('users').doc(userRes.data[0]._id).update({
    data: { banned: _.remove() }
  });

  return { success: true, message: '已解封' };
}
