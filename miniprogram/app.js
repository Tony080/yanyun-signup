App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      return;
    }
    wx.cloud.init({
      env: 'cloud1-0gpxf4r95efa2944', // 替换为你的云环境ID
      traceUser: true
    });
  },
  globalData: {
    openid: '',
    nickname: ''
  }
});
