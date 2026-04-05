const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { getSecrets } = require('../lib/config');

// ===== 路由 =====

exports.main = async (event) => {
  const { action, userId, ...params } = event;
  const wxContext = cloud.getWXContext();
  // 微信用户用 OPENID，网页用户传 userId
  const openid = wxContext.OPENID || userId;

  const handlers = { getSlots, join, leave, move, updateNickname, setRecurring };
  const adminHandlers = { adminList, adminRemove, adminBan, adminUnban };
  const allHandlers = Object.assign({}, handlers, adminHandlers);

  if (!allHandlers[action]) {
    return { success: false, message: '未知操作: ' + action };
  }

  // 管理员操作：验密码
  if (adminHandlers[action]) {
    return await adminHandlers[action](params);
  }

  // getSlots 不需要用户身份
  if (action === 'getSlots') {
    return await handlers[action](openid, params);
  }

  if (!openid) {
    return { success: false, message: '无法识别用户' };
  }

  // 检查是否被封禁
  if (action === 'join') {
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
  const res = await db.collection('slots')
    .where({ weekDate })
    .orderBy('hour', 'asc')
    .orderBy('carIndex', 'asc')
    .limit(100)
    .get();
  return { success: true, slots: res.data };
}

// ===== 报名 =====

async function join(openid, { weekDate, hour, nickname, role, recurring }) {
  // 检查本周是否已报名
  const existing = await db.collection('slots')
    .where({ weekDate, members: _.elemMatch({ openid }) })
    .get();

  if (existing.data.length > 0) {
    return { success: false, message: '你本周已报名，请使用「挪到这里」切换时段' };
  }

  // 查找该时段有空位的车
  const cars = await db.collection('slots')
    .where({ weekDate, hour, full: _.neq(true) })
    .orderBy('carIndex', 'asc')
    .limit(1)
    .get();

  var resultCarIndex;

  if (cars.data.length > 0) {
    const car = cars.data[0];
    const newCount = car.count + 1;
    const isFull = newCount >= 10;

    await db.collection('slots').doc(car._id).update({
      data: {
        members: _.push({ openid, nickname, role: role || '输出', joinedAt: db.serverDate() }),
        count: newCount,
        full: isFull
      }
    });

    if (isFull) {
      await onCarFull(weekDate, hour, car.carIndex + 1, car.members.concat([{ openid, nickname }]));
    }

    resultCarIndex = car.carIndex;
  } else {
    // 没有空车，开新车
    const allCars = await db.collection('slots')
      .where({ weekDate, hour })
      .orderBy('carIndex', 'desc')
      .limit(1)
      .get();

    const newCarIndex = allCars.data.length > 0
      ? allCars.data[0].carIndex + 1
      : 0;

    await db.collection('slots').add({
      data: {
        weekDate, hour, carIndex: newCarIndex,
        members: [{ openid, nickname, role: role || '输出', joinedAt: db.serverDate() }],
        count: 1, full: false, createdAt: db.serverDate()
      }
    });

    resultCarIndex = newCarIndex;
  }

  // 保存 role 到用户表（下次 autoRegister 用）
  if (role) {
    var _ur = await db.collection('users').where({ openid }).get();
    if (_ur.data.length > 0) {
      await db.collection('users').doc(_ur.data[0]._id).update({ data: { role: role } });
    }
  }

  // 处理每周自动报名
  if (recurring === true) {
    await setUserRecurring(openid, hour);
  } else if (recurring === false) {
    await clearUserRecurring(openid);
  }

  return { success: true, hour, carIndex: resultCarIndex };
}

// ===== 退出 =====

async function leave(openid, { weekDate }) {
  const existing = await db.collection('slots')
    .where({ weekDate, members: _.elemMatch({ openid }) })
    .get();

  if (existing.data.length === 0) {
    return { success: false, message: '你本周未报名' };
  }

  const slot = existing.data[0];
  const newMembers = slot.members.filter(m => m.openid !== openid);

  if (newMembers.length === 0) {
    await db.collection('slots').doc(slot._id).remove();
  } else {
    await db.collection('slots').doc(slot._id).update({
      data: { members: newMembers, count: newMembers.length, full: false }
    });
  }

  // 退出仅退本周，不影响每周自动设置
  // 下周 autoRegister 仍会自动帮用户报名

  return { success: true };
}

// ===== 挪动 =====

async function move(openid, { weekDate, targetHour, nickname, role }) {
  const existing = await db.collection('slots')
    .where({ weekDate, members: _.elemMatch({ openid }) })
    .get();

  if (existing.data.length === 0) {
    return { success: false, message: '你本周未报名' };
  }

  const currentSlot = existing.data[0];

  if (currentSlot.hour === targetHour) {
    return { success: false, message: '你已在该时段' };
  }

  // 先退出当前车
  const newMembers = currentSlot.members.filter(m => m.openid !== openid);

  if (newMembers.length === 0) {
    await db.collection('slots').doc(currentSlot._id).remove();
  } else {
    await db.collection('slots').doc(currentSlot._id).update({
      data: { members: newMembers, count: newMembers.length, full: false }
    });
  }

  // 如果已开启自动报名，挪动后更新到新时段
  const userRes = await db.collection('users').where({ openid }).get();
  var wasRecurring = false;
  if (userRes.data.length > 0 && userRes.data[0].recurringHour != null) {
    wasRecurring = true;
    await setUserRecurring(openid, targetHour);
  }

  // 加入目标时段（不传 recurring，避免覆盖上面的设置）
  // 保留原有 role
  var myMember = currentSlot.members.find(function(m) { return m.openid === openid; });
  var myRole = (myMember && myMember.role) || role || '输出';
  return await join(openid, { weekDate, hour: targetHour, nickname, role: myRole });
}

// ===== 更新昵称 =====

async function updateNickname(openid, { nickname }) {
  const userRes = await db.collection('users').where({ openid }).get();
  if (userRes.data.length > 0) {
    await db.collection('users').doc(userRes.data[0]._id).update({
      data: { nickname }
    });
  }

  const slotsRes = await db.collection('slots')
    .where({ members: _.elemMatch({ openid }) })
    .get();

  const updates = slotsRes.data.map(slot => {
    const updatedMembers = slot.members.map(m =>
      m.openid === openid ? { ...m, nickname } : m
    );
    return db.collection('slots').doc(slot._id).update({
      data: { members: updatedMembers }
    });
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

async function setUserRecurring(openid, hour) {
  const userRes = await db.collection('users').where({ openid }).get();
  if (userRes.data.length > 0) {
    await db.collection('users').doc(userRes.data[0]._id).update({
      data: { recurringHour: hour }
    });
  }
}

async function clearUserRecurring(openid) {
  const userRes = await db.collection('users').where({ openid }).get();
  if (userRes.data.length > 0) {
    await db.collection('users').doc(userRes.data[0]._id).update({
      data: { recurringHour: _.remove() }
    });
  }
}

// ===== 满车日志 =====

async function onCarFull(weekDate, hour, carNumber, members) {
  console.log('[满车]', weekDate, hour + ':00', '第' + carNumber + '车',
    members.map(m => m.nickname).join('、'));
}

// ===== 管理员功能 =====
// 修改这个密码！部署前换成你自己的
async function checkAdmin(adminKey) {
  var secrets = await getSecrets(db);
  return adminKey === secrets.ADMIN_KEY;
}

// 列出某周所有报名 + 用户列表
async function adminList({ weekDate, adminKey }) {
  if (!(await checkAdmin(adminKey))) return { success: false, message: '密码错误' };

  var slotsRes = await db.collection('slots')
    .where({ weekDate: weekDate })
    .orderBy('hour', 'asc')
    .orderBy('carIndex', 'asc')
    .limit(100)
    .get();

  // 收集所有 openid
  var openids = [];
  slotsRes.data.forEach(function(s) {
    s.members.forEach(function(m) {
      if (openids.indexOf(m.openid) === -1) openids.push(m.openid);
    });
  });

  // 查用户详情（banned 状态等）
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

// 移除某人的报名
async function adminRemove({ weekDate, targetOpenid, adminKey }) {
  if (!(await checkAdmin(adminKey))) return { success: false, message: '密码错误' };

  var existing = await db.collection('slots')
    .where({ weekDate: weekDate, members: _.elemMatch({ openid: targetOpenid }) })
    .get();

  if (existing.data.length === 0) return { success: false, message: '该用户本周未报名' };

  var slot = existing.data[0];
  var newMembers = slot.members.filter(function(m) { return m.openid !== targetOpenid; });

  if (newMembers.length === 0) {
    await db.collection('slots').doc(slot._id).remove();
  } else {
    await db.collection('slots').doc(slot._id).update({
      data: { members: newMembers, count: newMembers.length, full: false }
    });
  }

  return { success: true, message: '已移除' };
}

// 封禁用户
async function adminBan({ targetOpenid, adminKey }) {
  if (!(await checkAdmin(adminKey))) return { success: false, message: '密码错误' };

  var userRes = await db.collection('users').where({ openid: targetOpenid }).get();
  if (userRes.data.length === 0) return { success: false, message: '用户不存在' };

  await db.collection('users').doc(userRes.data[0]._id).update({
    data: { banned: true, recurringHour: _.remove() }
  });

  return { success: true, message: '已封禁' };
}

// 解封用户
async function adminUnban({ targetOpenid, adminKey }) {
  if (!(await checkAdmin(adminKey))) return { success: false, message: '密码错误' };

  var userRes = await db.collection('users').where({ openid: targetOpenid }).get();
  if (userRes.data.length === 0) return { success: false, message: '用户不存在' };

  await db.collection('users').doc(userRes.data[0]._id).update({
    data: { banned: _.remove() }
  });

  return { success: true, message: '已解封' };
}
