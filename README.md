# ZCode 切号器（桌面版）

基于 Electron 的 ZCode 账号管理工具。支持多账号凭证导入、一键切号、额度查询，无需反代，直接写入本地配置文件。

## 功能

- **多账号管理** — 导入 JSON 凭证或卡密（ZC1.xxx 格式）
- **一键切号** — 自动写入 ZCode 配置、可选重启 ZCode
- **智能自动切号** — 按剩余额度自动选择最优账号
- **额度查询** — 批量查询 billing 状态（有效期 + 剩余量）
- **卡密导入/导出** — 紧凑的 base64url 单行凭证格式，便于转移备份
- **回滚** — 切号失败时一键还原上一次账号

## 使用方法

### 开发运行

```bash
npm install
npm run dev        # 启动（附带 DevTools）
npm start          # 普通启动
```

### 打包（用户版）

```bash
npm run build:release
# 产物在 dist/release/
```

## 项目结构

```
├── main.js              # Electron 主进程 + IPC 处理
├── preload.js           # contextBridge 暴露的 window.api
├── renderer/            # 前端 UI（单页 HTML + JS）
├── src/
│   ├── switcher/
│   │   ├── core.js      # 切号引擎（写 config.json + 进程控制）
│   │   ├── quota.js     # 额度查询
│   │   ├── cardkey.js   # 卡密编解码（ZC1.xxx 格式）
│   │   └── cli.js       # CLI 入口（可选）
│   ├── tools/
│   │   └── synthesize_login_state.js
│   ├── upstream_transport.js
│   ├── zcode_oauth_login.js
│   ├── zcode_register.js
│   ├── mail_tempmail.js
│   └── assets/
├── build/               # electron-builder 辅助脚本
├── build-release.yml    # 发布版打包配置
└── assets/              # 应用图标
```

## 数据目录

运行时数据（`accounts.json`、切换状态、日志）存放在可执行文件同级的 `data/` 目录，不写用户目录。便携版使用 `PORTABLE_EXECUTABLE_DIR` 保证数据跟随 exe。

## License

MIT
