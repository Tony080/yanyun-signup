/**
 * 时区工具
 * 活动基准时区：美西太平洋夏令时 PDT (UTC-7)
 * 如进入冬令时 PST 需改为 -8
 */
const PDT_OFFSET = -7;

// 活动时段（PDT 小时）
const SLOT_HOURS_PDT = [14, 15, 16, 17, 18, 19, 20, 21, 22];

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
 * - PDT 周日且未过 23:00 → 返回当天
 * - 否则 → 返回下一个 PDT 周日
 */
function getCurrentSunday() {
  const pdtNow = getPDTNow();
  const day = pdtNow.getDay();
  const result = new Date(pdtNow);

  if (day === 0) {
    if (pdtNow.getHours() >= 23) {
      result.setDate(result.getDate() + 7);
    }
  } else {
    result.setDate(result.getDate() + (7 - day));
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

module.exports = {
  PDT_OFFSET,
  SLOT_HOURS_PDT,
  WEEKDAY_NAMES,
  getPDTNow,
  getCurrentSunday,
  pdtToLocal,
  formatDate
};
