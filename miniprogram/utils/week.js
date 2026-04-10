/**
 * 时区工具
 * 活动基准时区：美西太平洋夏令时 PDT (UTC-7)
 * 如进入冬令时 PST 需改为 -8
 */
const PDT_OFFSET = -7;

// 活动时段（PDT 小时）
const SLOT_HOURS_PDT = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
const SUNDAY_DISABLED_HOURS = [12, 13];

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 获取当前 PDT 时间
 */
function getPDTNow() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcMs + PDT_OFFSET * 3600000);
}

/**
 * 获取当前应报名的 PDT 周日日期
 * 每周从周日 14:00 PDT 开始，到下周六晚结束
 * - 周日 14:00+ → 本周日（新一周）
 * - 周日 14:00 前 → 上周日
 * - 周一~周六 → 回退到上个周日
 */
function getCurrentSunday() {
  const pdtNow = getPDTNow();
  const day = pdtNow.getDay();
  const result = new Date(pdtNow);

  if (day === 0) {
    // 周日：14:00 前属于上一周
    if (pdtNow.getHours() < 14) {
      result.setDate(result.getDate() - 7);
    }
  } else {
    // 周一~周六：回退到本周日
    result.setDate(result.getDate() - day);
  }

  return formatDate(result);
}

/**
 * 把 PDT 日期+小时 → 用户本地时间
 * @param {string} pdtDateStr  PDT 日期 "2026-04-05"
 * @param {number} pdtHour     PDT 小时 14
 * @returns {{ localDate, localHour, weekday, display, shortDisplay }}
 */
function pdtToLocal(pdtDateStr, pdtHour) {
  var parts = pdtDateStr.split('-');
  var y = parseInt(parts[0]);
  var m = parseInt(parts[1]);
  var d = parseInt(parts[2]);
  // PDT → UTC → 浏览器自动转本地
  var utcHour = pdtHour - PDT_OFFSET;
  var dt = new Date(Date.UTC(y, m - 1, d, utcHour, 0, 0));
  var h12 = fmt12h(dt.getHours());
  return {
    localDate: formatDate(dt),
    localHour: dt.getHours(),
    weekday: WEEKDAY_NAMES[dt.getDay()],
    display: WEEKDAY_NAMES[dt.getDay()] + ' ' + h12,
    shortDisplay: h12,
    dateLabel: (dt.getMonth() + 1) + '月' + dt.getDate() + '日'
  };
}

/**
 * 获取一周 7 天的日期信息（周日到周六）
 * @param {string} weekDate  周日日期 "2026-04-05"
 * @returns {Array<{dayIndex, dayDate, dayName, shortDate}>}
 */
function getDaysOfWeek(weekDate) {
  var parts = weekDate.split('-');
  var sun = new Date(+parts[0], +parts[1] - 1, +parts[2]);
  var days = [];
  for (var i = 0; i < 7; i++) {
    var d = new Date(sun);
    d.setDate(sun.getDate() + i);
    days.push({
      dayIndex: i,
      dayDate: formatDate(d),
      dayName: WEEKDAY_NAMES[i],
      dayShort: WEEKDAY_NAMES[i].replace('周', ''),
      shortDate: (d.getMonth() + 1) + '/' + d.getDate()
    });
  }
  return days;
}

function formatDate(date) {
  var y = date.getFullYear();
  var m = String(date.getMonth() + 1).padStart(2, '0');
  var d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmt12h(hour) {
  if (hour === 0) return '12:00 AM';
  if (hour < 12) return hour + ':00 AM';
  if (hour === 12) return '12:00 PM';
  return (hour - 12) + ':00 PM';
}

/**
 * 给定日期字符串，返回其所属 weekDate（PDT 周日）
 * 规则：周日 14:00 PDT 为周期分界
 * - 未来的周日：属于自己的周期
 * - 今天是周日且 <14:00：属于上一周
 * - 今天是周日且 >=14:00：属于本周
 * - 周一~周六：回退到上个周日
 */
function getWeekDateForDay(dayDateStr) {
  var pdtNow = getPDTNow();
  var todayStr = formatDate(pdtNow);
  var p = dayDateStr.split('-');
  var d = new Date(+p[0], +p[1] - 1, +p[2]);
  var dayOfWeek = d.getDay();

  if (dayOfWeek === 0) {
    if (dayDateStr === todayStr && pdtNow.getHours() < 14) {
      d.setDate(d.getDate() - 7);
      return formatDate(d);
    }
    return dayDateStr;
  } else {
    d.setDate(d.getDate() - dayOfWeek);
    return formatDate(d);
  }
}

/**
 * 获取滚动窗口 9 天（today-1 到 today+7）
 * 每天带有所属 weekDate
 */
function getRollingWindowDays() {
  var pdtNow = getPDTNow();
  var today = new Date(pdtNow.getFullYear(), pdtNow.getMonth(), pdtNow.getDate());
  var days = [];

  for (var i = -1; i <= 7; i++) {
    var d = new Date(today);
    d.setDate(today.getDate() + i);
    var dayDate = formatDate(d);
    var dayOfWeek = d.getDay();
    var wDate = getWeekDateForDay(dayDate);

    days.push({
      windowIndex: i + 1,
      dayDate: dayDate,
      weekDate: wDate,
      dayOfWeek: dayOfWeek,
      dayName: WEEKDAY_NAMES[dayOfWeek],
      dayShort: WEEKDAY_NAMES[dayOfWeek].replace('周', ''),
      shortDate: (d.getMonth() + 1) + '/' + d.getDate()
    });
  }

  return days;
}

/**
 * 获取滚动窗口涉及的所有不重复 weekDates
 */
function getWindowWeekDates() {
  var days = getRollingWindowDays();
  var seen = {};
  var result = [];
  for (var i = 0; i < days.length; i++) {
    if (!seen[days[i].weekDate]) {
      seen[days[i].weekDate] = true;
      result.push(days[i].weekDate);
    }
  }
  return result;
}

/**
 * 检查某个 weekDate 的报名窗口是否开放
 * 只要当前时间在截止时间（周六 01:00 PDT）之前，就可以报名
 * 未来周期也允许提前报名
 */
function isSignupWindowOpen(weekDateStr) {
  var pdtNow = getPDTNow();
  var p = weekDateStr.split('-');
  var sunday = new Date(+p[0], +p[1] - 1, +p[2]);

  var closeTime = new Date(sunday);
  closeTime.setDate(closeTime.getDate() + 6);
  closeTime.setHours(1, 0, 0, 0);

  return pdtNow < closeTime;
}

module.exports = {
  PDT_OFFSET,
  SLOT_HOURS_PDT,
  WEEKDAY_NAMES,
  getPDTNow,
  getCurrentSunday,
  getDaysOfWeek,
  getRollingWindowDays,
  getWindowWeekDates,
  getWeekDateForDay,
  isSignupWindowOpen,
  SUNDAY_DISABLED_HOURS,
  pdtToLocal,
  formatDate
};
