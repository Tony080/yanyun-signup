var week = require('../../utils/week');
var getCurrentSunday = week.getCurrentSunday;
var SLOT_HOURS_PDT = week.SLOT_HOURS_PDT;
var SUNDAY_DISABLED_HOURS = week.SUNDAY_DISABLED_HOURS;
var pdtToLocal = week.pdtToLocal;
var getDaysOfWeek = week.getDaysOfWeek;

Page({
  data: {
    openid: '',
    nickname: '',
    nicknameInput: '',
    weekDate: '',
    weekLabel: '',
    pdtLabel: '',
    timeSlots: [],
    slotsMap: {},
    myRegistration: null,
    isRecurring: false,
    recurringHour: null,
    recurringDay: null,
    recurringLocalDisplay: '',
    loading: true,
    actionLoading: false,
    selectedDay: 0,
    weekDays: [],
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
    slotMeta: {}
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
      var weekDate = getCurrentSunday();

      var weekDays = getDaysOfWeek(weekDate);

      // Build timeSlots for selected day (day 0 by default)
      var dayDate = weekDays[0].dayDate;
      var timeSlots = SLOT_HOURS_PDT.map(function (pdtHour) {
        var local = pdtToLocal(dayDate, pdtHour);
        return {
          pdtHour: pdtHour,
          display: local.display,
          shortDisplay: local.shortDisplay,
          weekday: local.weekday,
          dateLabel: local.dateLabel
        };
      });

      var f = weekDays[0];
      var la = weekDays[6];
      var weekLabel = f.shortDate + ' ' + f.dayName + ' ~ ' + la.shortDate + ' ' + la.dayName;
      var pdtLabel = '美西每日 14:00-22:00 · 周日 2PM 刷新';

      var recurringLocalDisplay = '';
      if (recurringHour != null && recurringDay != null) {
        var recDayDate = weekDays[recurringDay].dayDate;
        recurringLocalDisplay = pdtToLocal(recDayDate, recurringHour).display;
      }

      var savedRole = wx.getStorageSync('yanyun_role') || '输出';

      this.setData({
        openid: openid,
        nickname: nickname,
        nicknameInput: nickname,
        preferredRole: savedRole,
        weekDate: weekDate,
        weekLabel: weekLabel,
        pdtLabel: pdtLabel,
        weekDays: weekDays,
        selectedDay: week.getPDTNow().getDay(),
        timeSlots: timeSlots,
        isRecurring: recurringHour != null,
        recurringHour: recurringHour,
        recurringDay: recurringDay,
        recurringLocalDisplay: recurringLocalDisplay
      });

      await this.loadSlots();
    } catch (err) {
      console.error('init failed', err);
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  getLocalDisplay: function (pdtHour) {
    return pdtToLocal(this.data.weekDate, pdtHour).display;
  },

  // Build hour picker options for a given day
  buildHourPickerOptions: function (dayIndex, mode) {
    var weekDays = this.data.weekDays;
    var dayDate = weekDays[dayIndex].dayDate;
    var allSlots = this.data.allSlots;

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

    for (var i = 0; i < SLOT_HOURS_PDT.length; i++) {
      var pdtHour = SLOT_HOURS_PDT[i];

      // Sunday: skip disabled hours
      if (dayIndex === 0 && SUNDAY_DISABLED_HOURS.indexOf(pdtHour) >= 0) continue;

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
      // Keep the 随缘 if present, but also note no hours
      if (options.length === 0) {
        options.push({ label: '无可选时段', pdtHour: null });
      }
    }

    return options;
  },

  loadSlots: async function () {
    var weekDate = this.data.weekDate;
    var openid = this.data.openid;
    var weekDays = this.data.weekDays;
    try {
      var res = await wx.cloud.callFunction({
        name: 'api',
        data: { action: 'getSlots', weekDate: weekDate }
      });

      if (!res.result.success) return;

      var slots = res.result.slots;
      // Backward compat: add dayDate if missing
      for (var i = 0; i < slots.length; i++) {
        if (!slots[i].dayDate) slots[i].dayDate = slots[i].weekDate;
        // 预计算 leader 昵称供 WXML 显示
        var slot = slots[i];
        if (slot.leader) {
          var lm = slot.members.find(function(m) { return m.openid === slot.leader; });
          slot.leaderNick = lm ? lm.nickname : '';
        } else {
          slot.leaderNick = '';
        }
      }

      // Compute per-day totalCount
      var dayCounts = {};
      var myRegistration = null;
      for (var j = 0; j < slots.length; j++) {
        var s = slots[j];
        if (!dayCounts[s.dayDate]) dayCounts[s.dayDate] = 0;
        dayCounts[s.dayDate] += s.count;
        // Find my registration across ALL days
        if (s.members.some(function (m) { return m.openid === openid; })) {
          var dayIdx = -1;
          for (var k = 0; k < weekDays.length; k++) {
            if (weekDays[k].dayDate === s.dayDate) { dayIdx = k; break; }
          }
          myRegistration = {
            hour: s.hour,
            carIndex: s.carIndex,
            slotId: s._id,
            dayDate: s.dayDate,
            dayIndex: dayIdx >= 0 ? dayIdx : 0,
            localDisplay: pdtToLocal(s.dayDate, s.hour).display
          };
        }
      }
      // Update weekDays with totalCount
      var updatedWeekDays = weekDays.map(function(wd) {
        return Object.assign({}, wd, { totalCount: dayCounts[wd.dayDate] || 0 });
      });

      this.setData({
        allSlots: slots,
        myRegistration: myRegistration,
        weekDays: updatedWeekDays,
        loading: false
      });
      this.rebuildSlotsMapForDay();
    } catch (err) {
      console.error('loadSlots failed', err);
      this.setData({ loading: false });
    }
  },

  rebuildSlotsMapForDay: function () {
    var weekDays = this.data.weekDays;
    var selectedDay = this.data.selectedDay;
    var dayDate = weekDays[selectedDay].dayDate;
    var allSlots = this.data.allSlots;
    var slotsMap = {};

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

    // Rebuild timeSlots for selected day
    var timeSlots = SLOT_HOURS_PDT.map(function (pdtHour) {
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
      var tier = count === 0 ? 'tier-empty' : count < 10 ? 'tier-low' : count < 20 ? 'tier-mid' : 'tier-hot';
      return { pdtHour: ts.pdtHour, count: count, barH: barH, tier: tier, label: ts.shortDisplay || ts.display };
    });

    // Build recommendation (find car needing specific role)
    var recommendation = null;
    var myRegistration = this.data.myRegistration;
    if (!myRegistration) {
      for (var rh in slotsMap) {
        var rdata = slotsMap[rh];
        for (var ci = 0; ci < rdata.cars.length; ci++) {
          var rcar = rdata.cars[ci];
          if (rcar.full || rcar.count < 5) continue;
          var oc = 0, lc = 0;
          for (var mi = 0; mi < rcar.members.length; mi++) {
            if (rcar.members[mi].role === '霖霖') lc++; else oc++;
          }
          var need = null, needCount = 0;
          if (lc < 3 && oc >= lc + 2) { need = '霖霖'; needCount = 3 - lc; }
          else if (oc < 5 && lc >= oc) { need = '输出'; needCount = 5 - oc; }
          if (need && (!recommendation || rcar.count > recommendation.carCount)) {
            recommendation = {
              hour: +rh,
              carIndex: rcar.carIndex,
              neededRole: need,
              neededCount: needCount,
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
        isHot: sd.totalCount >= 20,
        isPast: isDayPast || (isDayToday && +sh <= pdtCurrentHour)
      };
    }
    // Also mark hours with no slots as past
    for (var ti = 0; ti < SLOT_HOURS_PDT.length; ti++) {
      var hr = SLOT_HOURS_PDT[ti];
      if (!slotMeta[hr]) {
        slotMeta[hr] = {
          allFull: false, isHot: false,
          isPast: isDayPast || (isDayToday && hr <= pdtCurrentHour)
        };
      }
    }

    this.setData({
      slotsMap: slotsMap,
      timeSlots: timeSlots,
      heatmapData: heatmapData,
      recommendation: recommendation,
      slotMeta: slotMeta,
      pdtTodayStr: pdtTodayStr
    });
  },

  selectDay: function (e) {
    var dayIndex = e.currentTarget.dataset.day;
    this.setData({ selectedDay: dayIndex });
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
    var role = this.data.proxyRoleIndex === 1 ? '霖霖' : '输出';
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
    var weekDays = this.data.weekDays;
    var selectedDay = this.data.selectedDay;

    // Build day picker options
    var pdtNow = week.getPDTNow();
    var pdtTodayStr = week.formatDate(pdtNow);
    var dayPickerOptions = [];
    for (var di = 0; di < weekDays.length; di++) {
      var wd = weekDays[di];
      var dayLabel = wd.dayName + ' ' + wd.shortDate;
      if (wd.dayDate < pdtTodayStr) {
        dayLabel += '（已过）';
      }
      dayPickerOptions.push({ label: dayLabel, dayIndex: di });
    }

    // Find picker index for current selectedDay
    var dayPickerIndex = 0;
    for (var dj = 0; dj < dayPickerOptions.length; dj++) {
      if (dayPickerOptions[dj].dayIndex === selectedDay) {
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
    var newDayIndex = dayOption.dayIndex;
    var hourOptions = this.buildHourPickerOptions(newDayIndex, this.data.signupMode);

    this.setData({
      dayPickerIndex: idx,
      signupDayIndex: newDayIndex,
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
    var weekDate = this.data.weekDate;

    if (mode === 'create' && pdtHour === null) {
      wx.showToast({ title: '创建车队需选择时段', icon: 'none' });
      return;
    }

    this.setData({ actionLoading: true });

    try {
      var action = mode === 'quick' ? 'quickJoin' : 'createTeam';
      var selectedDayDate = this.data.weekDays[this.data.signupDayIndex].dayDate;
      var callData = {
        action: action,
        weekDate: weekDate,
        dayDate: selectedDayDate,
        hour: pdtHour,
        nickname: nickname,
        role: role,
        recurring: recurring
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
          this.setData({
            isRecurring: true,
            recurringHour: displayHour,
            recurringDay: this.data.signupDayIndex,
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

    var content = '确定要退出本周报名吗？';
    if (this.data.isRecurring) {
      content += '\n每周自动报名也会一并取消';
    }

    var confirm = await this.showConfirm('确认退出', content);
    if (!confirm) return;

    this.setData({ actionLoading: true });

    try {
      var res = await wx.cloud.callFunction({
        name: 'api',
        data: { action: 'leave', weekDate: this.data.weekDate }
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
    var weekDate = this.data.weekDate;
    var nickname = this.data.nickname;
    var myReg = this.data.myRegistration;
    if (this.data.actionLoading) return;

    var fromDisplay = pdtToLocal(myReg.dayDate, myReg.hour).display;
    var moveDayDateForDisplay = this.data.weekDays[this.data.selectedDay].dayDate;
    var toDisplay = pdtToLocal(moveDayDateForDisplay, targetPdtHour).display;

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
      var moveDayDate = this.data.weekDays[this.data.selectedDay].dayDate;
      var res = await wx.cloud.callFunction({
        name: 'api',
        data: { action: 'move', weekDate: weekDate, targetHour: targetPdtHour, targetDayDate: moveDayDate, nickname: nickname }
      });

      if (res.result.success) {
        wx.showToast({ title: '已挪到 ' + toDisplay });
        if (this.data.isRecurring) {
          this.setData({
            recurringHour: targetPdtHour,
            recurringDay: this.data.selectedDay,
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

    try {
      var res = await wx.cloud.callFunction({
        name: 'api',
        data: {
          action: 'removeProxy',
          weekDate: this.data.weekDate,
          slotId: slotId,
          memberOpenid: memberOpenid
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
      var day = myReg.dayIndex;
      try {
        await wx.cloud.callFunction({
          name: 'api',
          data: { action: 'setRecurring', hour: hour, day: day }
        });
        var recDayDate = this.data.weekDays[day].dayDate;
        this.setData({
          isRecurring: true,
          recurringHour: hour,
          recurringDay: day,
          recurringLocalDisplay: pdtToLocal(recDayDate, hour).display
        });
        wx.showToast({ title: '已开启每周自动', icon: 'none' });
      } catch (err) {
        wx.showToast({ title: '操作失败', icon: 'none' });
      }
    } else {
      try {
        await wx.cloud.callFunction({
          name: 'api',
          data: { action: 'setRecurring', hour: null, day: null }
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
