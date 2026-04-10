const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const PDT_OFFSET = -7;

/**
 * 每6小时触发，用户级幂等：
 * - 遍历所有 recurring 用户
 * - 对当前周+下一周，已注册的跳过，没注册的补上
 * - 无全局锁，新开 recurring 的用户下次触发就能被注册
 */
exports.main = async (event, context) => {
  var pdtNow = getPDTNow();
  var currentWeek = getCurrentSunday(pdtNow);
  var nextWeek = getNextSunday(currentWeek);
  var weeks = [currentWeek, nextWeek];

  console.log('[自动报名] 检查 ' + weeks.join(', '));

  // 查所有 recurring 用户
  var usersRes = await db.collection('users')
    .where({ recurringHour: _.exists(true) })
    .limit(100)
    .get();

  if (usersRes.data.length === 0) {
    console.log('[自动报名] 无 recurring 用户');
    return { registered: 0 };
  }

  console.log('[自动报名] 找到 ' + usersRes.data.length + ' 个 recurring 用户');

  var registered = 0;

  for (var i = 0; i < usersRes.data.length; i++) {
    var user = usersRes.data[i];

    for (var w = 0; w < weeks.length; w++) {
      var weekDate = weeks[w];
      var result = await registerUserForWeek(user, weekDate);
      if (result) registered++;
    }
  }

  console.log('[自动报名完成] 共注册 ' + registered + ' 人次');
  return { registered: registered, weeks: weeks };
};

/**
 * 为单个用户注册单个周期（幂等：已注册则跳过）
 * 返回 true 如果实际注册了
 */
async function registerUserForWeek(user, weekDate) {
  var hour = user.recurringHour;
  var dayIndex = user.recurringDay || 0;
  var dayDate = getDayDate(weekDate, dayIndex);

  // 用户级去重：该周已注册则跳过
  var existing = await db.collection('slots')
    .where({ weekDate: weekDate, members: _.elemMatch({ openid: user.openid }) })
    .limit(1)
    .get();

  if (existing.data.length > 0) return false;

  // 找 count 最大的非满车（优先填满车）
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
        weekDate: weekDate, dayDate: dayDate, hour: hour,
        carIndex: newCarIndex,
        members: [{ openid: user.openid, nickname: user.nickname, role: user.role || '输出', joinedAt: db.serverDate() }],
        count: 1, full: false, leader: null,
        createdAt: db.serverDate()
      }
    });
  }

  console.log('[自动报名] ' + user.nickname + ' → ' + weekDate + ' ' + dayDate + ' ' + hour + ':00');
  return true;
}

// ===== 工具函数 =====

function getPDTNow() {
  var now = new Date();
  var utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcMs + PDT_OFFSET * 3600000);
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
