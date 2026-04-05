# 贡献指南

## 开发流程

1. Fork 或从 `main` 建分支，命名如 `feat/xxx` 或 `fix/xxx`
2. 本地开发、测试
3. 提 PR 到 `main`，等待 review 和 approve
4. 合并方式：Rebase merge

## 分支命名

- `feat/xxx` — 新功能
- `fix/xxx` — 修 bug
- `refactor/xxx` — 重构

## Commit 格式

简短说明做了什么，中英文均可：

```
feat: 加入副本难度选择
fix: 修复挪动时 role 丢失
refactor: 抽取公共时区工具
```

## 项目结构

```
miniprogram/          微信小程序前端
cloudfunctions/       微信云函数（共享后端）
  ├── api/            报名/退出/挪动/管理等核心逻辑
  ├── login/          登录 & 用户创建
  ├── remind/         定时提醒（Discord + 微信）
  ├── autoRegister/   每周自动报名
  └── lib/config.js   从云DB读取密钥（不要在代码里写密钥）
web/
  ├── index.html      网页版前端
  ├── admin.html      管理后台
  ├── api/cloud.js    Vercel 代理（网页版调云函数）
  ├── api/discord.js  Discord Bot 交互端点
  └── lib/wxcloud.js  共享的云函数调用模块
```

## 部署

- **网页版 + Discord Bot**: push 到 main 后 Vercel 自动部署
- **云函数**: push 到 main 后 GitHub Actions 自动部署
- **密钥**: 存在云数据库 `config` 集合，不要写在代码里

## 本地测试

- 小程序：用微信开发者工具打开项目根目录
- 网页版：需要 Vercel 环境变量，本地无法直接运行
- Discord Bot：push 后在 Discord 频道测试 `/看板`
