var week = require('../../utils/week');
var SUNDAY_DISABLED_HOURS = week.SUNDAY_DISABLED_HOURS;
var pdtToLocal = week.pdtToLocal;
var getRollingWindowDays = week.getRollingWindowDays;
var getWindowWeekDates = week.getWindowWeekDates;
var isSignupWindowOpen = week.isSignupWindowOpen;

/**
 * Helper: hex color string "#RRGGBB" -> {r, g, b}
 */
function hexToRgb(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  var num = parseInt(hex, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

/**
 * Build inline style for a member chip given a role color hex string.
 * isMe: highlight with stronger background & border
 */
function memberStyle(color, isMe) {
  var rgb = hexToRgb(color);
  var bgA = isMe ? 0.25 : 0.12;
  var borderA = isMe ? 0.6 : 0.25;
  return 'background:rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + bgA + ');color:' + color + ';border:1rpx solid rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + borderA + ')';
}

var SPECIAL_USERS = ['yoky', 'ykoy', 'deand', '狐狸', '测试管理'];
function isSpecialUser(nickname) {
  return SPECIAL_USERS.indexOf((nickname || '').toLowerCase()) !== -1;
}

/**
 * Build inline style for a proxy extra tag given a role color hex string.
 */
function extraTagStyle(color) {
  var rgb = hexToRgb(color);
  return 'background:rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.15);color:' + color + ';border:1rpx solid rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.3)';
}

Page({
  data: {
    openid: '',
    nickname: '',
    nicknameInput: '',
    weekLabel: '',
    pdtLabel: '',
    timeSlots: [],
    slotsMap: {},
    // 滚动窗口: 当前选中天对应的 weekDate 下的报名信息
    myRegistration: null,
    // 所有 weekDate 的报名信息: { weekDate: registration }
    myRegistrations: {},
    isRecurring: false,
    recurringHour: null,
    recurringDay: null,
    recurringLocalDisplay: '',
    loading: true,
    actionLoading: false,
    selectedDay: 0,        // windowIndex into rollingDays
    rollingDays: [],       // 8天滚动窗口
    windowWeekDates: [],   // 窗口涉及的 weekDates
    allSlots: [],

    // 帮报名列表（报名弹窗内）
    proxyList: [],
    proxyNameInput: '',
    proxyRoleIndex: 0,

    // Dashboard: expanded slots, heatmap, recommendation
    expandedSlots: {},
    heatmapData: [],
    recommendation: null,
    preferredRole: '输出', // 记忆职业

    // Signup modal state
    showSignupModal: false,
    signupMode: '',        // 'quick' or 'create'
    signupHour: null,      // null = 随缘 (only for quick mode)
    signupRole: '输出',
    signupRecurring: false,
    signupExtras: [],      // [{nickname, role}]
    extraNameInput: '',
    extraRoleInput: '输出',

    // Day + Hour pickers
    signupDayIndex: 0,
    dayPickerOptions: [],
    dayPickerIndex: 0,
    hourPickerOptions: [],
    timePickerIndex: 0,

    // 默认名字确认弹窗（简化版）
    showNameConfirm: false,
    nameConfirmTarget: '',
    slotMeta: {},

    // 当前选中天的报名窗口状态
    selectedDayWindowOpen: false,

    // ===== Multi-activity support =====
    activities: [],
    selectedActivity: '',
    currentActivityConfig: null,

    // Create activity modal
    showCreateActivityModal: false,
    newActivityName: '',
    newActivityMaxPerCar: 10,
    newActivityStartHour: 0,
    newActivityEndHour: 23,
    newActivityRoles: [
      { name: '输出', color: '#58a6ff' },
      { name: '霖霖', color: '#3fb950' }
    ],
    newRoleName: '',
    newRoleColor: '#58a6ff',
    presetColors: ['#58a6ff', '#3fb950', '#f85149', '#a78bfa', '#f0b429', '#e3b341', '#39d2c0', '#db61a2']
  },

  onLoad: function () {
    this.init();
  },

  onPullDownRefresh: function () {
    this.loadSlots().then(function () { wx.stopPullDownRefresh(); });
  },

  init: async function () {
    wx.showLoading({ title: '加载中...' });
    try {
      var res = await wx.cloud.callFunction({ name: 'login' });
      var openid = res.result.openid;
      var nickname = res.result.nickname;
      var recurringHour = res.result.recurringHour;
      var recurringDay = res.result.recurringDay != null ? res.result.recurringDay : (recurringHour != null ? 0 : null);

      var rollingDays = getRollingWindowDays();
      var windowWeekDates = getWindowWeekDates();

      // 默认选中 today（windowIndex 1）
      var defaultSelected = 1;

      var f = rollingDays[0];
      var la = rollingDays[rollingDays.length - 1];
      var weekLabel = f.shortDate + ' ' + f.dayName + ' ~ ' + la.shortDate + ' ' + la.dayName;
      var pdtLabel = '昨天 ~ +7天 · 每周期周六1AM PDT截止';

      var recurringLocalDisplay = '';
      if (recurringHour != null && recurringDay != null) {
        var recDay = rollingDays.find(function(d) { return d.dayOfWeek === recurringDay; });
        if (recDay) {
          recurringLocalDisplay = pdtToLocal(recDay.dayDate, recurringHour).display;
        }
      }

      var savedRole = wx.getStorageSync('yanyun_role') || '输出';

      this.setData({
        openid: openid,
        nickname: nickname,
        nicknameInput: nickname,
        preferredRole: savedRole,
        weekLabel: weekLabel,
        pdtLabel: pdtLabel,
        rollingDays: rollingDays,
        windowWeekDates: windowWeekDates,
        selectedDay: defaultSelected,
        isRecurring: recurringHour != null,
        recurringHour: recurringHour,
        recurringDay: recurringDay,
        recurringLocalDisplay: recurringLocalDisplay
      });

      // Load activities first, then slots
      await this.loadActivities();
      await this.loadSlots();
    } catch (err) {
      console.error('init failed', err);
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  // ===== Activity management =====

  loadActivities: async function () {
    try {
      var res = await wx.cloud.callFunction({
        name: 'api',
        data: { action: 'getActivities' }
      });
      if (res.result && res.result.success && res.result.activities && res.result.activities.length > 0) {
        var acts = res.result.activities;
        var selectedId = this.data.selectedActivity || acts[0].id;
        var config = acts.find(function(a) { return a.id === selectedId; }) || acts[0];
        selectedId = config.id;
        this.setData({
          activities: acts,
          selectedActivity: selectedId,
          currentActivityConfig: config
        });
      } else {
        // Fallback: create a default config if API returns nothing
        var defaultConfig = {
          id: 'default',
          name: '百业十人本',
          maxPerCar: 10,
          startHour: 12,
          endHour: 22,
          roles: [
            { name: '输出', color: '#58a6ff' },
            { name: '霖霖', color: '#3fb950' }
          ]
        };
        this.setData({
          activities: [defaultConfig],
          selectedActivity: 'default',
          currentActivityConfig: defaultConfig
        });
      }
    } catch (err) {
      console.error('loadActivities failed', err);
      // Fallback default
      var defaultConfig = {
        id: 'default',
        name: '百业十人本',
        maxPerCar: 10,
        startHour: 12,
        endHour: 22,
        roles: [
          { name: '输出', color: '#58a6ff' },
          { name: '霖霖', color: '#3fb950' }
        ]
      };
      this.setData({
        activities: [defaultConfig],
        selectedActivity: 'default',
        currentActivityConfig: defaultConfig
      });
    }
  },

  switchActivity: function (e) {
    var id = e.currentTarget.dataset.id;
    if (id === this.data.selectedActivity) return;
    var config = this.data.activities.find(function(a) { return a.id === id; });
    if (!config) return;
    this.setData({
      selectedActivity: id,
      currentActivityConfig: config,
      loading: true,
      expandedSlots: {}
    });
    this.loadSlots();
  },

  // ===== Create activity modal =====

  showCreateActivity: function () {
    this.setData({
      showCreateActivityModal: true,
      newActivityName: '',
      newActivityMaxPerCar: 10,
      newActivityStartHour: 0,
      newActivityEndHour: 23,
      newActivityRoles: [
        { name: '输出', color: '#58a6ff' },
        { name: '霖霖', color: '#3fb950' }
      ],
      newRoleName: '',
      newRoleColor: '#58a6ff'
    });
  },

  closeCreateActivity: function () {
    this.setData({ showCreateActivityModal: false });
  },

  onNewActivityNameInput: function (e) {
    this.setData({ newActivityName: e.detail.value });
  },

  onNewActivityMaxInput: function (e) {
    var val = parseInt(e.detail.value) || 1;
    if (val < 1) val = 1;
    if (val > 99) val = 99;
    this.setData({ newActivityMaxPerCar: val });
  },

  onStartHourChange: function (e) {
    var val = parseInt(e.detail.value);
    this.setData({ newActivityStartHour: val });
  },

  onEndHourChange: function (e) {
    var val = parseInt(e.detail.value);
    this.setData({ newActivityEndHour: val });
  },

  onNewRoleNameInput: function (e) {
    this.setData({ newRoleName: e.detail.value });
  },

  selectNewRoleColor: function (e) {
    var color = e.currentTarget.dataset.color;
    this.setData({ newRoleColor: color });
  },

  addNewRole: function () {
    var name = (this.data.newRoleName || '').trim();
    if (!name) {
      wx.showToast({ title: '请输入角色名', icon: 'none' });
      return;
    }
    var exists = this.data.newActivityRoles.some(function(r) { return r.name === name; });
    if (exists) {
      wx.showToast({ title: '角色名已存在', icon: 'none' });
      return;
    }
    var roles = this.data.newActivityRoles.concat([{ name: name, color: this.data.newRoleColor }]);
    this.setData({ newActivityRoles: roles, newRoleName: '' });
  },

  removeNewRole: function (e) {
    var idx = e.currentTarget.dataset.index;
    var roles = this.data.newActivityRoles.slice();
    if (roles.length <= 1) {
      wx.showToast({ title: '至少保留一个角色', icon: 'none' });
      return;
    }
    roles.splice(idx, 1);
    this.setData({ newActivityRoles: roles });
  },

  submitCreateActivity: async function () {
    var name = (this.data.newActivityName || '').trim();
    if (!name) {
      wx.showToast({ title: '请输入活动名称', icon: 'none' });
      return;
    }
    if (this.data.newActivityStartHour > this.data.newActivityEndHour) {
      wx.showToast({ title: '开始时间不能晚于结束时间', icon: 'none' });
      return;
    }
    if (this.data.newActivityRoles.length === 0) {
      wx.showToast({ title: '至少需要一个角色', icon: 'none' });
      return;
    }

    this.setData({ actionLoading: true });
    try {
      var res = await wx.cloud.callFunction({
        name: 'api',
        data: {
          action: 'createActivity',
          activityName: name,
          maxPerCar: this.data.newActivityMaxPerCar,
          startHour: this.data.newActivityStartHour,
          endHour: this.data.newActivityEndHour,
          roles: this.data.newActivityRoles
        }
      });
      if (res.result && res.result.success) {
        wx.showToast({ title: '活动已创建' });
        this.setData({ showCreateActivityModal: false });
        await this.loadActivities();
        // Switch to the newly created activity
        if (res.result.activityId) {
          var config = this.data.activities.find(function(a) { return a.id === res.result.activityId; });
          if (config) {
            this.setData({
              selectedActivity: res.result.activityId,
              currentActivityConfig: config,
              expandedSlots: {}
            });
          }
        }
        await this.loadSlots();
      } else {
        wx.showToast({ title: (res.result && res.result.message) || '创建失败', icon: 'none' });
      }
    } catch (err) {
      console.error('createActivity failed', err);
      wx.showToast({ title: '创建失败', icon: 'none' });
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  // ===== Hour generation from activity config =====

  getActivitySlotHours: function () {
    var config = this.data.currentActivityConfig;
    if (!config) return [];
    var hours = [];
    for (var h = config.startHour; h <= config.endHour; h++) {
      hours.push(h);
    }
    return hours;
  },

  getLocalDisplay: function (pdtHour) {
    var rd = this.data.rollingDays;
    var sel = this.data.selectedDay;
    return pdtToLocal(rd[sel].dayDate, pdtHour).display;
  },

  // Build hour picker options for a given windowIndex
  buildHourPickerOptions: function (windowIndex, mode) {
    var rollingDays = this.data.rollingDays;
    var day = rollingDays[windowIndex];
    var dayDate = day.dayDate;
    var dayOfWeek = day.dayOfWeek;
    var allSlots = this.data.allSlots;
    var SLOT_HOURS = this.getActivitySlotHours();

    // Build slotsMap for this day
    var daySlotsMap = {};
    for (var si = 0; si < allSlots.length; si++) {
      var slot = allSlots[si];
      if (slot.dayDate !== dayDate) continue;
      var h = slot.hour;
      if (!daySlotsMap[h]) daySlotsMap[h] = { totalCount: 0 };
      daySlotsMap[h].totalCount += slot.count;
    }

    var pdtNow = week.getPDTNow();
    var pdtTodayStr = week.formatDate(pdtNow);
    var pdtCurrentHour = pdtNow.getHours();
    var isDayToday = dayDate === pdtTodayStr;
    var isDayPast = dayDate < pdtTodayStr;

    var options = [];

    if (mode === 'quick') {
      options.push({ label: '🎲 随缘', pdtHour: null });
    }

    for (var i = 0; i < SLOT_HOURS.length; i++) {
      var pdtHour = SLOT_HOURS[i];

      // Sunday: skip disabled hours
      if (dayOfWeek === 0 && SUNDAY_DISABLED_HOURS.indexOf(pdtHour) >= 0) continue;

      // Today: skip hours <= current PDT hour; past days: skip all
      if (isDayPast) continue;
      if (isDayToday && pdtHour <= pdtCurrentHour) continue;

      var local = pdtToLocal(dayDate, pdtHour);
      var count = daySlotsMap[pdtHour] ? daySlotsMap[pdtHour].totalCount : 0;
      var label = local.shortDisplay + '（' + count + '人）';
      options.push({ label: label, pdtHour: pdtHour });
    }

    // If no hours available (past day), show a placeholder
    if (options.length === 0 || (options.length === 1 && options[0].pdtHour === null)) {
      if (options.length === 0) {
        options.push({ label: '无可选时段', pdtHour: null });
      }
    }

    return options;
  },

  // ===== Helper: get role color from activity config =====

  getRoleColor: function (roleName) {
    var config = this.data.currentActivityConfig;
    if (!config || !config.roles) return '#58a6ff';
    var role = config.roles.find(function(r) { return r.name === roleName; });
    return role ? role.color : '#58a6ff';
  },

  /**
   * Compute member inline styles for the current slotsMap.
   * Returns an object keyed by slot hour, then by member openid.
   */
  computeMemberStyles: function (slotsMap) {
    var self = this;
    var openid = this.data.openid;
    var styles = {};
    for (var h in slotsMap) {
      styles[h] = {};
      var cars = slotsMap[h].cars;
      for (var ci = 0; ci < cars.length; ci++) {
        var car = cars[ci];
        for (var mi = 0; mi < car.members.length; mi++) {
          var member = car.members[mi];
          var color = self.getRoleColor(member.role);
          var isMe = member.openid === openid;
          styles[h][member.openid + '_' + ci] = memberStyle(color, isMe);
        }
      }
    }
    return styles;
  },

  loadSlots: async function () {
    var windowWeekDates = this.data.windowWeekDates;
    var openid = this.data.openid;
    var rollingDays = this.data.rollingDays;
    var activityType = this.data.selectedActivity;
    try {
      // 每个 weekDate 单独查，兼容新旧 API
      var allResults = await Promise.all(windowWeekDates.map(function(wd) {
        return wx.cloud.callFunction({
          name: 'api',
          data: { action: 'getSlots', weekDate: wd, activityType: activityType }
        });
      }));

      var slots = [];
      for (var ri = 0; ri < allResults.length; ri++) {
        var r = allResults[ri];
        if (r.result && r.result.success && r.result.slots) {
          slots = slots.concat(r.result.slots);
        }
      }
      // Backward compat: add dayDate if missing
      for (var i = 0; i < slots.length; i++) {
        if (!slots[i].dayDate) slots[i].dayDate = slots[i].weekDate;
        var slot = slots[i];
        if (slot.leader) {
          var lm = slot.members.find(function(m) { return m.openid === slot.leader; });
          slot.leaderNick = lm ? lm.nickname : '';
        } else {
          slot.leaderNick = '';
        }
        // Set isLeader and isSpecial flags on each member
        for (var j = 0; j < slot.members.length; j++) {
          var mem = slot.members[j];
          mem.isLeader = !!(slot.leader && mem.openid === slot.leader);
          mem.isSpecial = isSpecialUser(mem.nickname);
        }
      }

      // Compute per-day totalCount and find registrations per weekDate
      var dayCounts = {};
      var myRegistrations = {};
      for (var j = 0; j < slots.length; j++) {
        var s = slots[j];
        if (!dayCounts[s.dayDate]) dayCounts[s.dayDate] = 0;
        dayCounts[s.dayDate] += s.count;
        // Find my registration per weekDate
        if (s.members.some(function (m) { return m.openid === openid; })) {
          var winIdx = -1;
          for (var k = 0; k < rollingDays.length; k++) {
            if (rollingDays[k].dayDate === s.dayDate) { winIdx = k; break; }
          }
          myRegistrations[s.weekDate] = {
            hour: s.hour,
            carIndex: s.carIndex,
            slotId: s._id,
            dayDate: s.dayDate,
            weekDate: s.weekDate,
            windowIndex: winIdx >= 0 ? winIdx : -1,
            localDisplay: pdtToLocal(s.dayDate, s.hour).display
          };
        }
      }
      // Update rollingDays with totalCount
      var updatedDays = rollingDays.map(function(rd) {
        return Object.assign({}, rd, { totalCount: dayCounts[rd.dayDate] || 0 });
      });

      // 当前选中天对应的 weekDate 的报名
      var selectedDay = this.data.selectedDay;
      var selectedWeekDate = updatedDays[selectedDay].weekDate;
      var myRegistration = myRegistrations[selectedWeekDate] || null;

      this.setData({
        allSlots: slots,
        myRegistrations: myRegistrations,
        myRegistration: myRegistration,
        rollingDays: updatedDays,
        selectedDayWindowOpen: isSignupWindowOpen(selectedWeekDate),
        loading: false
      });
      this.rebuildSlotsMapForDay();
    } catch (err) {
      console.error('loadSlots failed', err);
      this.setData({ loading: false });
    }
  },

  rebuildSlotsMapForDay: function () {
    var rollingDays = this.data.rollingDays;
    var selectedDay = this.data.selectedDay;
    var day = rollingDays[selectedDay];
    var dayDate = day.dayDate;
    var selectedWeekDate = day.weekDate;
    var allSlots = this.data.allSlots;
    var slotsMap = {};
    var config = this.data.currentActivityConfig;
    var maxPerCar = config ? config.maxPerCar : 10;

    for (var i = 0; i < allSlots.length; i++) {
      var slot = allSlots[i];
      if (slot.dayDate !== dayDate) continue;
      var h = slot.hour;
      if (!slotsMap[h]) {
        slotsMap[h] = { cars: [], totalCount: 0 };
      }
      slotsMap[h].cars.push(slot);
      slotsMap[h].totalCount += slot.count;
    }

    for (var key in slotsMap) {
      slotsMap[key].cars.sort(function (a, b) { return a.carIndex - b.carIndex; });
    }

    // Use activity config hours instead of hardcoded SLOT_HOURS_PDT
    var SLOT_HOURS = this.getActivitySlotHours();

    // Rebuild timeSlots for selected day
    var timeSlots = SLOT_HOURS.map(function (pdtHour) {
      var local = pdtToLocal(dayDate, pdtHour);
      return {
        pdtHour: pdtHour,
        display: local.display,
        shortDisplay: local.shortDisplay,
        weekday: local.weekday,
        dateLabel: local.dateLabel
      };
    });

    // Build heatmap: fixed 8rpx per person, cap at 120rpx
    var heatmapData = timeSlots.map(function(ts) {
      var d = slotsMap[ts.pdtHour];
      var count = d ? d.totalCount : 0;
      var barH = count === 0 ? 4 : Math.min(count * 8, 120);
      var tier = count === 0 ? 'tier-empty' : count < maxPerCar ? 'tier-low' : count < maxPerCar * 2 ? 'tier-mid' : 'tier-hot';
      return { pdtHour: ts.pdtHour, count: count, barH: barH, tier: tier, label: ts.shortDisplay || ts.display };
    });

    // 当前选中天的 weekDate 对应的报名
    var myRegistrations = this.data.myRegistrations;
    var myRegistration = myRegistrations[selectedWeekDate] || null;
    var windowOpen = isSignupWindowOpen(selectedWeekDate);

    // Build recommendation (find car needing specific role)
    var recommendation = null;
    if (!myRegistration && windowOpen && config && config.roles && config.roles.length >= 2) {
      for (var rh in slotsMap) {
        var rdata = slotsMap[rh];
        for (var ci = 0; ci < rdata.cars.length; ci++) {
          var rcar = rdata.cars[ci];
          if (rcar.full || rcar.count < Math.floor(maxPerCar / 2)) continue;
          // Count members by role
          var roleCounts = {};
          for (var mi = 0; mi < rcar.members.length; mi++) {
            var rn = rcar.members[mi].role;
            roleCounts[rn] = (roleCounts[rn] || 0) + 1;
          }
          // Find the role with fewest members
          var minRole = null;
          var minCount = Infinity;
          for (var ri = 0; ri < config.roles.length; ri++) {
            var rc = roleCounts[config.roles[ri].name] || 0;
            if (rc < minCount) { minCount = rc; minRole = config.roles[ri]; }
          }
          var needed = minRole ? Math.ceil(maxPerCar / config.roles.length) - minCount : 0;
          if (minRole && needed > 0 && (!recommendation || rcar.count > recommendation.carCount)) {
            recommendation = {
              hour: +rh,
              carIndex: rcar.carIndex,
              neededRole: minRole.name,
              neededRoleColor: minRole.color,
              neededCount: needed,
              carCount: rcar.count,
              display: pdtToLocal(dayDate, +rh).display
            };
          }
        }
      }
    }

    // Build slot metadata for compact rows + past check
    var pdtNow = week.getPDTNow();
    var pdtTodayStr = week.formatDate(pdtNow);
    var pdtCurrentHour = pdtNow.getHours();
    var isDayPast = dayDate < pdtTodayStr;
    var isDayToday = dayDate === pdtTodayStr;

    var slotMeta = {};
    for (var sh in slotsMap) {
      var sd = slotsMap[sh];
      slotMeta[sh] = {
        allFull: sd.cars.length > 0 && sd.cars.every(function(c) { return c.full; }),
        isHot: sd.totalCount >= maxPerCar * 2,
        isPast: isDayPast || (isDayToday && +sh <= pdtCurrentHour)
      };
    }
    // Also mark hours with no slots as past
    for (var ti = 0; ti < SLOT_HOURS.length; ti++) {
      var hr = SLOT_HOURS[ti];
      if (!slotMeta[hr]) {
        slotMeta[hr] = {
          allFull: false, isHot: false,
          isPast: isDayPast || (isDayToday && hr <= pdtCurrentHour)
        };
      }
    }

    // Compute car progress bar widths and count text
    for (var ch in slotsMap) {
      var cdata = slotsMap[ch];
      for (var cci = 0; cci < cdata.cars.length; cci++) {
        var ccar = cdata.cars[cci];
        ccar._barWidth = Math.min(ccar.count / maxPerCar * 100, 100);
        ccar._countText = ccar.count + '/' + maxPerCar;
        ccar._pctText = Math.round(ccar._barWidth) + '% — ' + (ccar.full ? '已满' : '还差' + (maxPerCar - ccar.count) + '人');
      }
    }

    // Compute member inline styles
    var memberStyles = this.computeMemberStyles(slotsMap);

    // 检测 recurring 预约状态
    var recurringPending = false;
    var recurringPendingDisplay = '';
    if (!myRegistration && this.data.isRecurring && this.data.recurringHour != null && this.data.recurringDay != null) {
      if (day.dayOfWeek === this.data.recurringDay) {
        recurringPending = true;
        recurringPendingDisplay = pdtToLocal(dayDate, this.data.recurringHour).display;
      }
    }

    this.setData({
      slotsMap: slotsMap,
      timeSlots: timeSlots,
      heatmapData: heatmapData,
      recommendation: recommendation,
      slotMeta: slotMeta,
      pdtTodayStr: pdtTodayStr,
      myRegistration: myRegistration,
      selectedDayWindowOpen: windowOpen,
      recurringPending: recurringPending,
      recurringPendingDisplay: recurringPendingDisplay,
      memberStyles: memberStyles
    });
  },

  selectDay: function (e) {
    var windowIndex = e.currentTarget.dataset.day;
    this.setData({ selectedDay: windowIndex });
    this.rebuildSlotsMapForDay();
  },

  // ===== 昵称 =====

  onNicknameInput: function (e) {
    this.setData({ nicknameInput: e.detail.value });
  },

  // ===== 帮报名列表管理 =====

  onProxyNameInput: function (e) {
    this.setData({ proxyNameInput: e.detail.value });
  },

  onProxyRoleChange: function (e) {
    this.setData({ proxyRoleIndex: Number(e.detail.value) });
  },

  addProxyToList: function () {
    var name = (this.data.proxyNameInput || '').trim().slice(0, 12);
    if (!name) { wx.showToast({ title: '请输入名字', icon: 'none' }); return; }
    var config = this.data.currentActivityConfig;
    var roles = config ? config.roles : [];
    var roleIdx = this.data.proxyRoleIndex;
    var role = roles[roleIdx] ? roles[roleIdx].name : '输出';
    var list = this.data.proxyList.concat([{ nickname: name, role: role }]);
    this.setData({ proxyList: list, proxyNameInput: '' });
  },

  removeProxyFromList: function (e) {
    var idx = e.currentTarget.dataset.index;
    var list = this.data.proxyList.slice();
    list.splice(idx, 1);
    this.setData({ proxyList: list });
  },

  // ===== 职业记忆 =====

  setPreferredRole: function (e) {
    var role = e.currentTarget.dataset.role;
    this.setData({ preferredRole: role });
    wx.setStorageSync('yanyun_role', role);
  },

  // ===== 展开/折叠时段 =====

  toggleSlot: function (e) {
    var hour = e.currentTarget.dataset.hour;
    var expanded = this.data.expandedSlots;
    expanded[hour] = !expanded[hour];
    this.setData({ expandedSlots: expanded });
  },

  // ===== 推荐卡片一键加入 =====

  joinRecommend: function () {
    var rec = this.data.recommendation;
    if (!rec) return;
    this.setData({ signupRole: rec.neededRole });
    this.openSignupModal({
      currentTarget: { dataset: { mode: 'quick', hour: rec.hour } }
    });
  },

  // ===== 满车时段创建车队 =====

  createTeamAt: function (e) {
    var hour = e.currentTarget.dataset.hour;
    this.openSignupModal({
      currentTarget: { dataset: { mode: 'create', hour: hour } }
    });
  },

  // ===== 默认名字确认（简化版）=====

  confirmNameOk: function () {
    this.setData({ showNameConfirm: false });
    if (this._nameConfirmResolve) this._nameConfirmResolve(true);
  },

  confirmNameCancel: function () {
    this.setData({ showNameConfirm: false });
    if (this._nameConfirmResolve) this._nameConfirmResolve(false);
  },

  saveNickname: async function () {
    var nicknameInput = this.data.nicknameInput;
    var nickname = this.data.nickname;
    var trimmed = nicknameInput.trim();
    if (!trimmed || trimmed === nickname) return;
    var newName = trimmed.slice(0, 12);

    try {
      wx.showLoading({ title: '保存中...' });
      await wx.cloud.callFunction({
        name: 'api',
        data: { action: 'updateNickname', nickname: newName }
      });
      this.setData({ nickname: newName, nicknameInput: newName });
      wx.hideLoading();
      wx.showToast({ title: '昵称已更新' });
      this.loadSlots();
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '更新失败', icon: 'none' });
    }
  },

  // ===== 报名弹窗 =====

  openSignupModal: function (e) {
    var mode = e.currentTarget.dataset.mode; // 'quick' or 'create'
    var hour = e.currentTarget.dataset.hour;  // optional: pre-selected hour
    var rollingDays = this.data.rollingDays;
    var selectedDay = this.data.selectedDay;

    // Build day picker options (only future days with open signup window)
    var pdtNow = week.getPDTNow();
    var pdtTodayStr = week.formatDate(pdtNow);
    var dayPickerOptions = [];
    for (var di = 0; di < rollingDays.length; di++) {
      var rd = rollingDays[di];
      var dayLabel = rd.dayName + ' ' + rd.shortDate;
      var windowOpen = isSignupWindowOpen(rd.weekDate);
      if (rd.dayDate < pdtTodayStr) {
        dayLabel += '（已过）';
      } else if (!windowOpen) {
        dayLabel += '（未开放）';
      }
      dayPickerOptions.push({ label: dayLabel, windowIndex: di });
    }

    // Find picker index for current selectedDay
    var dayPickerIndex = 0;
    for (var dj = 0; dj < dayPickerOptions.length; dj++) {
      if (dayPickerOptions[dj].windowIndex === selectedDay) {
        dayPickerIndex = dj;
        break;
      }
    }

    var signupDayIndex = selectedDay;

    // Build hour options for selected day
    var hourOptions = this.buildHourPickerOptions(signupDayIndex, mode);

    // Find hour picker index if pre-selected hour given
    var timePickerIndex = 0;
    if (hour !== undefined && hour !== null) {
      var hourNum = Number(hour);
      for (var hi = 0; hi < hourOptions.length; hi++) {
        if (hourOptions[hi].pdtHour === hourNum) {
          timePickerIndex = hi;
          break;
        }
      }
    }

    this.setData({
      showSignupModal: true,
      signupMode: mode,
      signupDayIndex: signupDayIndex,
      dayPickerOptions: dayPickerOptions,
      dayPickerIndex: dayPickerIndex,
      hourPickerOptions: hourOptions,
      timePickerIndex: timePickerIndex,
      signupHour: hourOptions[timePickerIndex].pdtHour,
      signupRole: this.data.preferredRole,
      signupRecurring: false,
      signupExtras: [],
      extraNameInput: '',
      extraRoleInput: '输出'
    });
  },

  closeSignupModal: function () {
    this.setData({ showSignupModal: false });
  },

  // Prevent tap-through on modal overlay
  preventBubble: function () {},

  onDayPickerChange: function (e) {
    var idx = Number(e.detail.value);
    var dayOption = this.data.dayPickerOptions[idx];
    var newWindowIndex = dayOption.windowIndex;
    var hourOptions = this.buildHourPickerOptions(newWindowIndex, this.data.signupMode);

    this.setData({
      dayPickerIndex: idx,
      signupDayIndex: newWindowIndex,
      hourPickerOptions: hourOptions,
      timePickerIndex: 0,
      signupHour: hourOptions[0].pdtHour
    });
  },

  onTimePickerChange: function (e) {
    var idx = Number(e.detail.value);
    var options = this.data.hourPickerOptions;
    this.setData({
      timePickerIndex: idx,
      signupHour: options[idx].pdtHour
    });
  },

  selectRole: function (e) {
    var role = e.currentTarget.dataset.role;
    this.setData({ signupRole: role });
  },

  toggleSignupRecurring: function () {
    this.setData({ signupRecurring: !this.data.signupRecurring });
  },

  onExtraNameInput: function (e) {
    this.setData({ extraNameInput: e.detail.value });
  },

  selectExtraRole: function (e) {
    var role = e.currentTarget.dataset.role;
    this.setData({ extraRoleInput: role });
  },

  addExtra: function () {
    var name = this.data.extraNameInput.trim();
    if (!name) {
      wx.showToast({ title: '请输入名字', icon: 'none' });
      return;
    }
    var extras = this.data.signupExtras.concat([{
      nickname: name.slice(0, 12),
      role: this.data.extraRoleInput
    }]);
    this.setData({
      signupExtras: extras,
      extraNameInput: ''
    });
  },

  removeExtra: function (e) {
    var idx = Number(e.currentTarget.dataset.idx);
    var extras = this.data.signupExtras.filter(function (_, i) { return i !== idx; });
    this.setData({ signupExtras: extras });
  },

  // Submit signup
  submitSignup: async function () {
    if (this.data.actionLoading) return;

    var nickname = this.data.nickname;

    // 默认名字二次确认（简化版）
    if (nickname.startsWith('水仙十字社小可爱') || nickname.startsWith('访客')) {
      var self = this;
      var confirmed = await new Promise(function (resolve) {
        self.setData({
          showNameConfirm: true,
          nameConfirmTarget: nickname
        });
        self._nameConfirmResolve = resolve;
      });
      if (!confirmed) return;
    }

    var mode = this.data.signupMode;
    var pdtHour = this.data.signupHour;
    var role = this.data.signupRole;
    var recurring = this.data.signupRecurring;
    var extras = this.data.signupExtras;

    if (mode === 'create' && pdtHour === null) {
      wx.showToast({ title: '创建车队需选择时段', icon: 'none' });
      return;
    }

    this.setData({ actionLoading: true });

    try {
      var action = mode === 'quick' ? 'quickJoin' : 'createTeam';
      var selectedRollingDay = this.data.rollingDays[this.data.signupDayIndex];
      var selectedDayDate = selectedRollingDay.dayDate;
      var weekDate = selectedRollingDay.weekDate;
      var callData = {
        action: action,
        weekDate: weekDate,
        dayDate: selectedDayDate,
        hour: pdtHour,
        nickname: nickname,
        role: role,
        recurring: recurring,
        activityType: this.data.selectedActivity
      };

      // 合并弹窗 extras + header proxyList
      var allExtras = extras.concat(this.data.proxyList);
      if (allExtras.length > 0) {
        callData.extraMembers = allExtras;
      }

      var res = await wx.cloud.callFunction({
        name: 'api',
        data: callData
      });

      if (res.result.success) {
        var displayHour = res.result.hour || pdtHour;
        var displayDayDate = res.result.dayDate || selectedDayDate;
        var localDisplay = displayHour !== null ? pdtToLocal(displayDayDate, displayHour).display : '随缘';
        var msg = mode === 'quick' ? '已加入 ' + localDisplay : '已创建车队 ' + localDisplay;
        if (recurring) msg += '（每周自动）';
        wx.showToast({ title: msg, icon: 'none' });

        if (recurring && displayHour !== null) {
          var recurringDayOfWeek = selectedRollingDay.dayOfWeek;
          this.setData({
            isRecurring: true,
            recurringHour: displayHour,
            recurringDay: recurringDayOfWeek,
            recurringLocalDisplay: pdtToLocal(displayDayDate, displayHour).display
          });
        }

        this.setData({ showSignupModal: false, proxyList: [] });
        await this.loadSlots();
        this.requestSubscribe();
      } else {
        wx.showToast({ title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      console.error('submitSignup failed', err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  // ===== Per-slot join button =====

  handleSlotJoin: function (e) {
    var hour = e.currentTarget.dataset.hour;
    this.openSignupModal({
      currentTarget: {
        dataset: { mode: 'quick', hour: hour }
      }
    });
  },

  // ===== 退出 =====

  handleLeave: async function () {
    if (this.data.actionLoading) return;
    var myReg = this.data.myRegistration;
    if (!myReg) return;

    var content = '确定要退出报名吗？';
    if (this.data.isRecurring) {
      content += '\n每周自动报名也会一并取消';
    }

    var confirm = await this.showConfirm('确认退出', content);
    if (!confirm) return;

    this.setData({ actionLoading: true });

    try {
      var res = await wx.cloud.callFunction({
        name: 'api',
        data: { action: 'leave', weekDate: myReg.weekDate, activityType: this.data.selectedActivity }
      });

      if (res.result.success) {
        wx.showToast({ title: '已退出报名' });
        await this.loadSlots();
      } else {
        wx.showToast({ title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  // ===== 挪动 =====

  handleMove: async function (e) {
    var targetPdtHour = Number(e.currentTarget.dataset.hour);
    var nickname = this.data.nickname;
    var myReg = this.data.myRegistration;
    if (this.data.actionLoading || !myReg) return;

    var rollingDays = this.data.rollingDays;
    var selectedDay = this.data.selectedDay;
    var targetDay = rollingDays[selectedDay];

    // 只能在同一个 weekDate 内挪动
    if (targetDay.weekDate !== myReg.weekDate) {
      wx.showToast({ title: '不能跨周期挪动，请退出后重新报名', icon: 'none' });
      return;
    }

    var fromDisplay = pdtToLocal(myReg.dayDate, myReg.hour).display;
    var toDisplay = pdtToLocal(targetDay.dayDate, targetPdtHour).display;

    var extra = '';
    if (this.data.isRecurring) {
      extra = '\n每周自动报名也会跟着改';
    }

    var confirm = await this.showConfirm(
      '确认挪动',
      '从 ' + fromDisplay + ' 挪到 ' + toDisplay + '？' + extra
    );
    if (!confirm) return;

    this.setData({ actionLoading: true });

    try {
      var res = await wx.cloud.callFunction({
        name: 'api',
        data: {
          action: 'move',
          weekDate: myReg.weekDate,
          targetHour: targetPdtHour,
          targetDayDate: targetDay.dayDate,
          nickname: nickname,
          activityType: this.data.selectedActivity
        }
      });

      if (res.result.success) {
        wx.showToast({ title: '已挪到 ' + toDisplay });
        if (this.data.isRecurring) {
          this.setData({
            recurringHour: targetPdtHour,
            recurringDay: targetDay.dayOfWeek,
            recurringLocalDisplay: toDisplay
          });
        }
        await this.loadSlots();
      } else {
        wx.showToast({ title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  // ===== Remove proxy member =====

  handleRemoveProxy: async function (e) {
    var memberOpenid = e.currentTarget.dataset.memberOpenid;
    var memberNickname = e.currentTarget.dataset.memberNickname;
    var slotId = e.currentTarget.dataset.slotId;

    var confirm = await this.showConfirm('移除代报', '确定移除 ' + memberNickname + '？');
    if (!confirm) return;

    this.setData({ actionLoading: true });

    var selectedWeekDate = this.data.rollingDays[this.data.selectedDay].weekDate;
    try {
      var res = await wx.cloud.callFunction({
        name: 'api',
        data: {
          action: 'removeProxy',
          weekDate: selectedWeekDate,
          slotId: slotId,
          memberOpenid: memberOpenid,
          activityType: this.data.selectedActivity
        }
      });

      if (res.result.success) {
        wx.showToast({ title: '已移除 ' + memberNickname });
        await this.loadSlots();
      } else {
        wx.showToast({ title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  // ===== 取消/开启 每周自动 =====

  toggleRecurring: async function () {
    var newRecurring = !this.data.isRecurring;

    if (newRecurring) {
      var myReg = this.data.myRegistration;
      if (!myReg) {
        wx.showToast({ title: '请先报名一个时段', icon: 'none' });
        return;
      }
      var hour = myReg.hour;
      var regDay = this.data.rollingDays.find(function(d) { return d.dayDate === myReg.dayDate; });
      var dayOfWeek = regDay ? regDay.dayOfWeek : 0;
      try {
        await wx.cloud.callFunction({
          name: 'api',
          data: { action: 'setRecurring', hour: hour, day: dayOfWeek, activityType: this.data.selectedActivity }
        });
        this.setData({
          isRecurring: true,
          recurringHour: hour,
          recurringDay: dayOfWeek,
          recurringLocalDisplay: pdtToLocal(myReg.dayDate, hour).display
        });
        wx.showToast({ title: '已开启每周自动', icon: 'none' });
      } catch (err) {
        wx.showToast({ title: '操作失败', icon: 'none' });
      }
    } else {
      try {
        await wx.cloud.callFunction({
          name: 'api',
          data: { action: 'setRecurring', hour: null, day: null, activityType: this.data.selectedActivity }
        });
        this.setData({
          isRecurring: false,
          recurringHour: null,
          recurringDay: null,
          recurringLocalDisplay: ''
        });
        wx.showToast({ title: '已取消每周自动', icon: 'none' });
      } catch (err) {
        wx.showToast({ title: '操作失败', icon: 'none' });
      }
    }
  },

  // ===== 订阅通知 =====

  _tmplId: 'DF5oEnfQ6QkoTW-5nQcPalEi4ITthx6Q1_OSXyXKfvk',

  requestSubscribe: function () {
    var tmplId = this._tmplId;
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      success: function (res) {
        if (res[tmplId] === 'accept') {
          wx.showToast({ title: '开车前30分钟会通知你', icon: 'none' });
        }
      },
      fail: function () {}
    });
  },

  subscribeNotify: async function () {
    var tmplId = this._tmplId;
    try {
      var res = await wx.requestSubscribeMessage({ tmplIds: [tmplId] });
      if (res[tmplId] === 'accept') {
        wx.showToast({ title: '订阅成功，开车前30分钟通知你' });
      } else {
        wx.showToast({ title: '需要允许通知才能收到提醒', icon: 'none' });
      }
    } catch (err) {
      wx.showToast({ title: '订阅失败', icon: 'none' });
    }
  },

  // ===== Hour display helper for create activity modal =====

  formatHour12: function (h) {
    if (h === 0) return '12AM';
    if (h < 12) return h + 'AM';
    if (h === 12) return '12PM';
    return (h - 12) + 'PM';
  },

  // ===== 工具 =====

  showConfirm: function (title, content) {
    return new Promise(function (resolve) {
      wx.showModal({
        title: title,
        content: content,
        success: function (res) { resolve(res.confirm); }
      });
    });
  }
});
