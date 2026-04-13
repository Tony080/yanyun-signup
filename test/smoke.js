/**
 * Smoke test — 周期分界 & 跨周期挪动逻辑
 *
 * 运行: node test/smoke.js
 * 零依赖，用 Node.js 内置 assert。
 */
var assert = require('assert');
var passed = 0;
var failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + name);
    console.log('    ' + e.message);
  }
}

// ===== 从生产代码复制的纯函数（无外部依赖）=====
// 来源: cloudfunctions/api/index.js

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

function getDayIndex(weekDate, dayDate) {
  var wp = weekDate.split('-');
  var dp = dayDate.split('-');
  var w = new Date(+wp[0], +wp[1] - 1, +wp[2]);
  var d = new Date(+dp[0], +dp[1] - 1, +dp[2]);
  return Math.round((d - w) / 86400000);
}

function getDayDate(weekDate, dayIndex) {
  var p = weekDate.split('-');
  var d = new Date(+p[0], +p[1] - 1, +p[2]);
  d.setDate(d.getDate() + (dayIndex || 0));
  return formatDate(d);
}

function formatDate(date) {
  var y = date.getFullYear();
  var m = String(date.getMonth() + 1).padStart(2, '0');
  var d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

// 来源: 前端 handleMove + 后端 move 中的跨周期判断
function isCrossCycleMove(fromDayDate, fromHour, toDayDate, toHour) {
  var fp = fromDayDate.split('-');
  var fromDow = new Date(+fp[0], +fp[1] - 1, +fp[2]).getDay();
  var tp = toDayDate.split('-');
  var toDow = new Date(+tp[0], +tp[1] - 1, +tp[2]).getDay();
  var fromNew = fromDow === 0 && fromHour >= 14;
  var toNew = toDow === 0 && toHour >= 14;
  return fromNew !== toNew;
}

// ===== 测试 =====

console.log('\n getCurrentSunday — 周日 14:00 分界');

test('周日 13:59 → 上周日', function () {
  // 2026-04-12 是周日
  var pdtNow = new Date(2026, 3, 12, 13, 59);
  assert.strictEqual(getCurrentSunday(pdtNow), '2026-04-05');
});

test('周日 14:00 → 本周日', function () {
  var pdtNow = new Date(2026, 3, 12, 14, 0);
  assert.strictEqual(getCurrentSunday(pdtNow), '2026-04-12');
});

test('周六 → 回退到上周日', function () {
  // 2026-04-11 是周六
  var pdtNow = new Date(2026, 3, 11, 20, 0);
  assert.strictEqual(getCurrentSunday(pdtNow), '2026-04-05');
});

test('周一 → 回退到上周日', function () {
  // 2026-04-13 是周一
  var pdtNow = new Date(2026, 3, 13, 10, 0);
  assert.strictEqual(getCurrentSunday(pdtNow), '2026-04-12');
});

test('跨年: 2027-01-03 周日 14:00+', function () {
  // 2027-01-03 是周日
  var pdtNow = new Date(2027, 0, 3, 14, 0);
  assert.strictEqual(getCurrentSunday(pdtNow), '2027-01-03');
});

test('跨年: 2027-01-02 周六', function () {
  // 2027-01-02 是周六
  var pdtNow = new Date(2027, 0, 2, 20, 0);
  assert.strictEqual(getCurrentSunday(pdtNow), '2026-12-27');
});

console.log('\n getDayIndex / getDayDate — 日期偏移');

test('周日自身 dayIndex=0', function () {
  assert.strictEqual(getDayIndex('2026-04-05', '2026-04-05'), 0);
});

test('周六 dayIndex=6', function () {
  assert.strictEqual(getDayIndex('2026-04-05', '2026-04-11'), 6);
});

test('跨月', function () {
  assert.strictEqual(getDayIndex('2026-03-29', '2026-04-04'), 6);
});

test('getDayDate 往返一致', function () {
  assert.strictEqual(getDayDate('2026-04-05', 6), '2026-04-11');
  assert.strictEqual(getDayDate('2026-04-05', 0), '2026-04-05');
});

console.log('\n isCrossCycleMove — 跨周期挪动拦截');

test('周日 14:00 → 周六: 跨周期 ✗', function () {
  assert.strictEqual(isCrossCycleMove('2026-04-12', 14, '2026-04-11', 22), true);
});

test('周日 15:00 → 周六: 跨周期 ✗', function () {
  assert.strictEqual(isCrossCycleMove('2026-04-12', 15, '2026-04-11', 20), true);
});

test('周六 → 周日 14:00: 跨周期 ✗', function () {
  assert.strictEqual(isCrossCycleMove('2026-04-11', 20, '2026-04-12', 14), true);
});

test('周日 14:00 → 周日 16:00: 同周期 ✓', function () {
  assert.strictEqual(isCrossCycleMove('2026-04-12', 14, '2026-04-12', 16), false);
});

test('周六 20:00 → 周六 22:00: 同周期 ✓', function () {
  assert.strictEqual(isCrossCycleMove('2026-04-11', 20, '2026-04-11', 22), false);
});

test('周一 → 周三: 同周期 ✓', function () {
  assert.strictEqual(isCrossCycleMove('2026-04-13', 14, '2026-04-15', 20), false);
});

test('周三 → 周六: 同周期 ✓', function () {
  assert.strictEqual(isCrossCycleMove('2026-04-15', 18, '2026-04-18', 22), false);
});

// ===== 总结 =====

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
if (failed > 0) process.exit(1);
