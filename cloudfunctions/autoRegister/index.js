const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const PDT_OFFSET = -7;

/**
 * 每周自动报名
 * 每6小时触发一次，函数自行判断是否需要执行
 * 当 weekDate 翻新后（PDT 周日 23:00+ 或周一起），为所有设置了 recurringHour 的用户自动报名
 */
exports.main = async (event, context) => {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const pdtNow = new Date(utcMs + PDT_OFFSET * 3600000);
  const weekDate = getCurrentSunday(pdtNow);

  console.log('[自动报名] 检查 weekDate=' + weekDate);

  // 检查是否已为本周执行过
  var metaRes;
  try {
    metaRes = await db.collection('meta')
      .where({ type: 'autoRegister' })
      .limit(1)
      .get();
  } catch (e) {
    metaRes = { data: [] };
  }

  if (metaRes.data.length > 0 && metaRes.data[0].lastWeekDate === weekDate) {
    console.log('[自动报名] 本周已执行过，跳过');
    return { skipped: true, reason: 'already done for ' + weekDate };
  }

  // 查找所有开启了每周自动的用户
  const usersRes = await db.collection('users')
    .where({ recurringHour: _.exists(true) })
    .limit(100)
    .get();

  if (usersRes.data.length === 0) {
    console.log('[自动报名] 无自动报名用户');
    await updateMeta(metaRes, weekDate);
    return { registered: 0 };
  }

  console.log('[自动报名] 找到 ' + usersRes.data.length + ' 个自动报名用户');

  var registered = 0;

  for (var i = 0; i < usersRes.data.length; i++) {
    var user = usersRes.data[i];
    var hour = user.recurringHour;

    // 检查是否已在本周报名
    var existCheck = await db.collection('slots')
      .where({ weekDate: weekDate, members: _.elemMatch({ openid: user.openid }) })
      .limit(1)
      .get();

    if (existCheck.data.length > 0) {
      console.log('[自动报名] ' + user.nickname + ' 已手动报名，跳过');
      continue;
    }

    // 寻找有空位的车
    var cars = await db.collection('slots')
      .where({ weekDate: weekDate, hour: hour, full: _.neq(true) })
      .orderBy('carIndex', 'asc')
      .limit(1)
      .get();

    if (cars.data.length > 0) {
      var car = cars.data[0];
      var newCount = car.count + 1;
      await db.collection('slots').doc(car._id).update({
        data: {
          members: _.push({
            openid: user.openid,
            nickname: user.nickname,
            joinedAt: db.serverDate()
          }),
          count: newCount,
          full: newCount >= 10
        }
      });
    } else {
      // 开新车
      var allCars = await db.collection('slots')
        .where({ weekDate: weekDate, hour: hour })
        .orderBy('carIndex', 'desc')
        .limit(1)
        .get();

      var newCarIndex = allCars.data.length > 0 ? allCars.data[0].carIndex + 1 : 0;

      await db.collection('slots').add({
        data: {
          weekDate: weekDate,
          hour: hour,
          carIndex: newCarIndex,
          members: [{ openid: user.openid, nickname: user.nickname, role: user.role || '输出', joinedAt: db.serverDate() }],
          count: 1,
          full: false,
          createdAt: db.serverDate()
        }
      });
    }

    registered++;
    console.log('[自动报名] ' + user.nickname + ' → ' + hour + ':00 PDT');
  }

  // 标记本周已完成
  await updateMeta(metaRes, weekDate);

  console.log('[自动报名完成] 本周报名 ' + registered + ' 人');
  return { registered: registered, weekDate: weekDate };
};

async function updateMeta(metaRes, weekDate) {
  if (metaRes.data.length > 0) {
    await db.collection('meta').doc(metaRes.data[0]._id).update({
      data: { lastWeekDate: weekDate, updatedAt: db.serverDate() }
    });
  } else {
    await db.collection('meta').add({
      data: { type: 'autoRegister', lastWeekDate: weekDate, updatedAt: db.serverDate() }
    });
  }
}

function getCurrentSunday(pdtNow) {
  var day = pdtNow.getDay();
  var result = new Date(pdtNow);
  if (day === 0) {
    if (pdtNow.getHours() >= 23) {
      result.setDate(result.getDate() + 7);
    }
  } else {
    result.setDate(result.getDate() + (7 - day));
  }
  return formatDate(result);
}

function formatDate(date) {
  var y = date.getFullYear();
  var m = String(date.getMonth() + 1).padStart(2, '0');
  var d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}
