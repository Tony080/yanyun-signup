const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const PDT_OFFSET = -7;

/**
 * 每周自动报名（支持滚动窗口）
 * 每6小时触发一次，为当前周和下一周的 recurring 用户自动报名
 * 这样滚动窗口中下一周的日期也能显示 recurring 用户的报名
 */
exports.main = async (event, context) => {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const pdtNow = new Date(utcMs + PDT_OFFSET * 3600000);
  const currentWeekDate = getCurrentSunday(pdtNow);
  const nextWeekDate = getNextSunday(currentWeekDate);

  console.log('[自动报名] 检查 currentWeek=' + currentWeekDate + ' nextWeek=' + nextWeekDate);

  // 处理当前周和下一周
  var totalRegistered = 0;

  totalRegistered += await processWeek(currentWeekDate, pdtNow);
  totalRegistered += await processWeek(nextWeekDate, pdtNow);

  console.log('[自动报名完成] 共报名 ' + totalRegistered + ' 人');
  return { registered: totalRegistered, currentWeekDate: currentWeekDate, nextWeekDate: nextWeekDate };
};

async function processWeek(weekDate, pdtNow) {
  // 检查是否已为该周执行过
  var metaRes;
  try {
    metaRes = await db.collection('meta')
      .where({ type: 'autoRegister', weekDate: weekDate })
      .limit(1)
      .get();
  } catch (e) {
    metaRes = { data: [] };
  }

  if (metaRes.data.length > 0) {
    console.log('[自动报名] ' + weekDate + ' 已执行过，跳过');
    return 0;
  }

  // 查找所有开启了每周自动的用户
  const usersRes = await db.collection('users')
    .where({ recurringHour: _.exists(true) })
    .limit(100)
    .get();

  if (usersRes.data.length === 0) {
    console.log('[自动报名] 无自动报名用户');
    await saveMeta(weekDate);
    return 0;
  }

  console.log('[自动报名] ' + weekDate + ': 找到 ' + usersRes.data.length + ' 个自动报名用户');

  var registered = 0;

  for (var i = 0; i < usersRes.data.length; i++) {
    var user = usersRes.data[i];
    var hour = user.recurringHour;
    var dayIndex = user.recurringDay || 0;
    var dayDate = getDayDate(weekDate, dayIndex);

    // 检查是否已在该周报名
    var existCheck = await db.collection('slots')
      .where({ weekDate: weekDate, members: _.elemMatch({ openid: user.openid }) })
      .limit(1)
      .get();

    if (existCheck.data.length > 0) {
      console.log('[自动报名] ' + user.nickname + ' 已在 ' + weekDate + ' 报名，跳过');
      continue;
    }

    // 寻找 count 最大的非满车
    var cars = await db.collection('slots')
      .where({ weekDate: weekDate, dayDate: dayDate, hour: hour, full: _.neq(true) })
      .orderBy('count', 'desc')
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
            role: user.role || '输出',
            joinedAt: db.serverDate()
          }),
          count: newCount,
          full: newCount >= 10
        }
      });
    } else {
      // 开新车
      var allCars = await db.collection('slots')
        .where({ weekDate: weekDate, dayDate: dayDate, hour: hour })
        .orderBy('carIndex', 'desc')
        .limit(1)
        .get();

      var newCarIndex = allCars.data.length > 0 ? allCars.data[0].carIndex + 1 : 0;

      await db.collection('slots').add({
        data: {
          weekDate: weekDate,
          dayDate: dayDate,
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
    console.log('[自动报名] ' + user.nickname + ' → ' + weekDate + ' day' + dayIndex + ' ' + hour + ':00 PDT');
  }

  // 标记该周已完成
  await saveMeta(weekDate);

  console.log('[自动报名] ' + weekDate + ' 完成，报名 ' + registered + ' 人');
  return registered;
}

async function saveMeta(weekDate) {
  await db.collection('meta').add({
    data: { type: 'autoRegister', weekDate: weekDate, processedAt: db.serverDate() }
  });
}

function getCurrentSunday(pdtNow) {
  var day = pdtNow.getDay();
  var result = new Date(pdtNow);
  if (day === 0) {
    if (pdtNow.getHours() < 14) result.setDate(result.getDate() - 7);
  } else {
    result.setDate(result.getDate() - day);
  }
  return formatDate(result);
}

function getNextSunday(weekDateStr) {
  var p = weekDateStr.split('-');
  var d = new Date(+p[0], +p[1] - 1, +p[2]);
  d.setDate(d.getDate() + 7);
  return formatDate(d);
}

function formatDate(date) {
  var y = date.getFullYear();
  var m = String(date.getMonth() + 1).padStart(2, '0');
  var d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function getDayDate(weekDate, dayIndex) {
  var p = weekDate.split('-');
  var d = new Date(+p[0], +p[1] - 1, +p[2]);
  d.setDate(d.getDate() + (dayIndex || 0));
  return formatDate(d);
}
