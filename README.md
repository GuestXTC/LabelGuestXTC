# LabelGuestXTC — 标签设计与打印工作台

一个**完全开源（MIT）**、从零实现的桌面标签设计与批量打印工具。采用现代扁平化 Ribbon 界面，支持变量数据绑定、条码工具、标签文件导入与 TSPL 打印。用于仓储、零售、制造、跨境、价签等标签场景。

**仓库地址**：
- Gitee：https://gitee.com/GuestXTC/LabelGuestXTC
- GitHub：https://github.com/GuestXTC/LabelGuestXTC

> 本项目是独立编写的干净室（clean-room）实现，不包含、不复制任何商业软件的源代码、界面素材或私有数据格式。
>
> **完全免费、无账号、无会员、无 VIP、无云端、无付费墙，所有功能本地可用。**
>
> 本项目支持读取用户自有的标签文件，仅实现**文件格式互操作**。本项目为独立实现，与任何第三方标签软件均无关联、背书或授权关系，也不使用任何第三方商标标识。

> **关于本项目**：本软件全程由 AI 制作，无一行人工代码，且不再更新。有需要的朋友可以自行借助 AI 修改后使用。

## 下载

| 平台 | 下载地址 |
|------|----------|
| Windows | [安装包 .exe](https://github.com/GuestXTC/LabelGuestXTC/releases/download/v4.8.18/LabelGuestXTC-Setup-4.8.18.exe) |
| macOS | [Apple 芯片 .dmg](https://github.com/GuestXTC/LabelGuestXTC/releases/download/v4.8.18/LabelGuestXTC-4.8.18-arm64.dmg) · [Intel 芯片 .dmg](https://github.com/GuestXTC/LabelGuestXTC/releases/download/v4.8.18/LabelGuestXTC-4.8.18-x64.dmg) |
| Linux | [AppImage](https://github.com/GuestXTC/LabelGuestXTC/releases/download/v4.8.18/LabelGuestXTC-4.8.18-x86_64.AppImage) · [.deb](https://github.com/GuestXTC/LabelGuestXTC/releases/download/v4.8.18/LabelGuestXTC-4.8.18-amd64.deb) |

全部版本见 [Releases 页面](https://github.com/GuestXTC/LabelGuestXTC/releases/tag/v4.8.18)。

---

## 功能

### 界面
- **现代扁平化 Ribbon 功能区**：开始 / 插入 / 页面布局 / 数据·变量 / 视图 / 文件 六个选项卡，工具按组分区，干净不杂乱
- 元素添加集中在「插入」Ribbon 选项卡 + 中央画布 + 右侧属性面板 + 底部数据面板，无冗余侧栏
- 属性面板分区清晰：元素专属设置在上，数据绑定 / 常规 / 图层在下

### 标签设计器
- 可视化画布，尺寸按毫米设置（宽/高可调）
- 元素类型：**文本、一维码、二维码、图片、矩形、椭圆、线条、表格**
- **线条**：点「线条」工具直接插入一条线；选中后只有 **2 个端点**（蓝色圆点），拖动端点时**往左右拖成水平线、往上下拖成垂直线**（始终正交，不会斜）；无旋转手柄
- 拖拽移动、四角缩放、旋转手柄（Shift 15° 吸附）
- **表格**：行列数可设，四角改整体大小、内部橙色圆点单独调整行高/列宽，线宽/颜色可调
  - **合并单元格**：选中表格后在格子上按住鼠标拖选多个格，松开后点"合并"；点"拆分"还原
  - 导入标签文件时保留原表格的列宽比例与合并单元格，不变形
- 文本对齐 5 种：**左对齐、居中对齐、右对齐、撑满（两端对齐）、平铺（分散对齐）**
- 智能参考线对齐（与其他元素及画布中心/边缘吸附）、可选网格显示（间距可调）
- **多选**：Ctrl/Shift 点击多选；对齐工具（左/右/水平居中/顶/底/垂直居中、水平/垂直等距分布、统一宽/高/尺寸）
- **元素状态**：锁定（不可移动/缩放/删除）、隐藏（不显示不打印），图层列表带锁/隐藏快捷按钮
- **复制粘贴**：`Ctrl+C` / `Ctrl+V`、`Ctrl+D` 原地复制、`Ctrl+A` 全选
- **双击画布上的文字即可就地编辑**（回车或点空白处保存，Esc 取消；条码/二维码内容同样支持）
- 键盘操作：方向键微调（Shift 更精细）、`L` 锁定、`H` 隐藏、`Delete` 删除、`Ctrl+Z/Y` 撤销重做
- 图层列表可上移/下移调整叠放顺序
- **多文档标签页**：顶部可同时打开多个标签（每个文件独立成页），点击切换、✕ 关闭；每个标签的画布、撤销历史、选中状态、数据源互相独立；`Ctrl+T` 新建、`Ctrl+W` 关闭
- 缩放（30%–400%）、适应窗口

### 数据源
- 一维码支持 CODE128 / EAN13 / EAN8 / UPC / CODE39 / ITF-14 / CODABAR
- 二维码支持 L/M/Q/H 四级容错
- **变量绑定**：属性面板的「绑定列」可把元素直接绑定到数据表某一列（NiceLabel 风格），打印时显示该列的值
- 文本/条码/二维码内容可写模板变量，批量打印时自动替换：
  - `{列名}` — 导入数据表的列
  - `{序列号}` — 可配置起始值、步长、补零位数
  - `{日期}` — 可配置格式，如 `YYYY-MM-DD`

### 批量数据打印
- 导入 Excel（xlsx/xls）、CSV、TXT
- 数据表格预览
- 一次生成 N 张标签，统一打印或导出

### 打开标签文件
- 原生标签格式 **`.xtc`**（JSON 内容）：新建和「另存为」默认用 `.xtc`，打开/拖放均支持
- 可直接打开常见的 **XML 标签文件**（纯解析、不依赖其它软件）
- 安装后**双击标签文件即可用本工具打开**（已注册文件关联）；也支持从右键"打开方式"选择
- 自动还原纸张尺寸（毫米）与全部元素，支持文本、线条、矩形/椭圆、图片、一维码/二维码、表格等类型
- 文本字体/字号/粗斜体/对齐、二维码容错级别、表格行列/列宽比例/合并单元格均会导入（不变形）
- 导入后可继续在本工具中编辑、批量打印、导出
- **编码兼容**：UTF-8（含/不含 BOM）、UTF-16 LE/BE（含/不含 BOM）、GBK/GB18030 都能正确识别，中文不会乱码
- **容错解析**：对标签名大小写、根节点名、属性别名、未知元素类型均做兼容，不会因为格式细微差异变成空白画布
- **「打开」与「导入」共用同一个内容识别入口**，两者都能打开 `.xtc` 原生标签与 `.ddl` XML 标签文件；也可以直接把文件拖到窗口里打开
- 解析失败会在状态栏和提示条明确显示原因，不再静默留白
- **文字对齐精确还原**：居中/左/右对齐（alignment 4/1/2）精确保留，渲染采用手动测量定位，不受字体压缩影响
- 界面字号整体放大、控件加大，视觉更清晰
- 说明：这是**文件格式互操作**——只解析公开的 XML 结构，不含任何反编译代码

### 打印（两种模式）
- **标签机模式（推荐，TSPL 原始指令）**：针对 QR-588 / QR-588BT 等热敏标签机
  - 按 **203 DPI** 把标签渲染成单色位图，直接生成 TSPL `BITMAP` 指令
  - 通过 Windows RAW 端口（`WritePrinter`，pDataType=RAW）发送，**完全绕过 GDI 驱动的缩放/字体替换**
  - 精确控制纸张尺寸、间隙(GAP)、浓度、份数、打印方向，解决缩放不对、位置偏移、内容变形、多张走纸问题
  - 自动枚举系统打印机，可手动选择 `50X40` / `100X70` 等标签机
  - 批量打印逐张发送，每张独立控制走纸
- **普通打印机模式（系统打印）**：走系统打印对话框，适用于桌面打印机/针式打印机
- 无需额外安装任何驱动库或原生模块（Windows 用 PowerShell + winspool 纯 ASCII 脚本内联；macOS / Linux 用系统自带 CUPS 的 `lp` 原始打印）

> **平台说明**：标签机 TSPL 原始指令直发三平台均可用——Windows 走 RAW 端口（`WritePrinter`），macOS / Linux 走 CUPS 原始打印（`lp -o raw`，需打印机队列支持 RAW 模式）。若 CUPS 队列会过滤数据导致打印异常，可创建专用 RAW 队列：
> ```bash
> sudo lpadmin -p LABEL_RAW -E -v <打印机设备URI> -m raw
> ```
> 然后在打印中心选择该队列。macOS / Linux 同样支持设计、导出 PNG/PDF 与系统打印。

### 存储与输出
- 保存/打开本项目的 `.xtc` 标签文件（无内置模板库）
- 导出 **PNG**（300 DPI）、**PDF**（每张标签一页）

---

## 界面
现代扁平化 Ribbon 设计，降低学习成本：
- 顶部：文档页签 + Ribbon 功能区（开始 / 插入 / 页面布局 / 数据·变量 / 视图 / 文件）
- 元素添加集中在「插入」选项卡（文本、一维码、二维码、图片、图形、表格等）
- 中间：带毫米刻度的标尺工作区 + 白色标签画布
- 右侧：属性面板（选中元素后显示对应属性）+ 图层
- 底部：数据库面板（可折叠，批量打印时展开）

## 技术栈
- Electron 28（桌面壳）
- 原生 HTML / CSS / JavaScript（界面与编辑器，无前端框架）
- 开源依赖：
  - `jsbarcode` (MIT) — 一维码
  - `qrcode` (MIT) — 二维码
  - `xlsx` (Apache-2.0) — 表格解析
  - `jspdf` (MIT) — PDF 导出

---

## 从源码运行

```bash
npm install
npm start
```

> 若环境变量 `ELECTRON_RUN_AS_NODE=1` 被设置，请先取消：
> `env -u ELECTRON_RUN_AS_NODE npm start`

## 打包（Windows / macOS / Linux）

需 Node.js 18+。在各平台本机执行对应命令：

```bash
npm run dist:win     # Windows → NSIS 安装包 .exe
npm run dist:mac     # macOS → .dmg + .zip（x64 与 arm64）
npm run dist:linux   # Linux → .AppImage + .deb
```

> 跨平台一次性构建（`npm run dist:all`）通常需在各对应平台或 CI 上执行；Windows 本机一般只能可靠产出 Windows 包。推荐直接使用 GitHub Actions 自动构建三平台。

产物统一位于 `dist/` 目录：

| 平台 | 产物 | 说明 |
|------|------|------|
| Windows | `LabelGuestXTC-Setup-<版本>.exe` | NSIS 安装包，可自定义安装目录 |
| macOS | `LabelGuestXTC-<版本>-x64.dmg` / `-arm64.dmg` | 拖入 Applications 安装 |
| Linux | `LabelGuestXTC-<版本>-x64.AppImage` / `.deb` | 免安装执行文件 / Debian 包 |

> **macOS 提示**：未签名的 dmg 首次打开需在「系统设置 → 隐私与安全性」点「仍要打开」，或用 `xattr -cr LabelGuestXTC.app` 去除隔离属性。正式分发需 Apple 开发者账号签名并公证。
>
> **国内网络提示**：Windows 构建已设置 `signAndEditExecutable: false`（跳过 winCodeSign 下载，代价是 exe 用默认图标、未签名）。若 Electron 二进制下载失败，可设置镜像：
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist:win`

仅生成免安装目录（便于调试）：

```bash
npm run dist:dir
```

**CI 自动构建**：GitHub Actions 在推送 `v*` 标签或手动触发时，自动在 Windows/macOS/Linux 三个 runner 上构建，并把安装包作为 artifacts 上传；打标签时同时创建 GitHub Release。见 `.github/workflows/build.yml`。Gitee 仓库作为国内镜像与下载入口，CI 在 GitHub 侧运行。

---

## 模板 JSON 格式

模板即普通 JSON，便于人工编辑、diff 与共享：

```json
{
  "name": "商品价签",
  "width": 100,
  "height": 60,
  "dpi": 203,
  "elements": [
    {
      "id": "el_x1",
      "type": "text",
      "name": "品名",
      "x": 8, "y": 8, "w": 60, "h": 10, "rotation": 0,
      "text": "{名称}", "fontFamily": "Microsoft YaHei",
      "fontSize": 5, "bold": true, "italic": false,
      "color": "#111111", "align": "left", "field": "名称"
    },
    {
      "id": "el_x2",
      "type": "barcode",
      "x": 8, "y": 24, "w": 60, "h": 20, "rotation": 0,
      "value": "{条码}", "format": "CODE128",
      "displayValue": true, "lineColor": "#111111"
    }
  ]
}
```

坐标与尺寸单位均为**毫米**，原点在标签左上角。

---

## 目录结构

```
labelguestxtc/
├── main.js          Electron 主进程：窗口、对话框、文件系统、打印/PDF
├── preload.js       IPC 桥接
├── src/
│   ├── index.html   界面结构
│   ├── css/style.css 样式
│   └── js/app.js    编辑器逻辑（渲染、交互、数据、导出）
├── package.json
├── LICENSE          MIT
└── README.md
```

---

## 许可证

MIT © LabelGuestXTC contributors。详见 [LICENSE](LICENSE)。

第三方库各自的许可证见其 `node_modules/<包名>/LICENSE`：jsbarcode (MIT)、qrcode (MIT)、xlsx (Apache-2.0)、jspdf (MIT)。
