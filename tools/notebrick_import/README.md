# NoteBrick → 可编辑课程笔记

这是 agent/harness 的可重复工作流：浏览器负责读取已登录账号的原稿，Python 工具负责确定性的图文转换、完整性核对和暂存，最后沿用本仓库的 GitHub Pages 发布流程。网页共用 `static/notes/_shared/` 的编辑器、编号与字体，新课程只需要少量配置文件以及自己的笔记、图片。

本机已安装 `$notebrick-import` skill。可以直接对 Codex 说：

> 用 $notebrick-import 把 NoteBrick 中“课程名”的已生成笔记导入个人主页；已有栏目只追加新笔记。

## 准备与来源清单

在仓库根目录运行命令。Python 依赖：

```powershell
python -m pip install -r tools/notebrick_import/requirements.txt
```

先在用户已登录的 NoteBrick 网页核对课程文件夹、确切笔记 ID、完成状态及原稿标题。来源清单是 JSON 数组，每项包含 `id` 或 NoteBrick 笔记 `url`，以及可选的 `title`、`recordingDate`（`YYYY-MM-DD`）。仅选择本次用户指定的课程。不能从“没有处理中”推断每份笔记都成功，应逐份核对。

每次导入使用一个**仓库外**的私有工作目录。原稿、PDF、断点及密钥不属于站点发布文件。下面的路径、课程名和 slug 按本次任务替换：

```powershell
python -m tools.notebrick_import init --repo . --work C:/Users/kai/Documents/Codex/imports/my-course --slug my-course --title "课程名" --sources C:/Users/kai/Documents/Codex/imports/jobs.json
python -m tools.notebrick_import status --config C:/Users/kai/Documents/Codex/imports/my-course/import.json
```

初始化后，`import.json` 固定来源清单、排序、目标仓库及私有原稿目录。新课程按录制日期排列；导入已有栏目时保留用户当前顺序，新笔记追加在后，不移动旧笔记。追加新一批来源：

```powershell
python -m tools.notebrick_import add --config C:/Users/kai/Documents/Codex/imports/my-course/import.json --sources C:/Users/kai/Documents/Codex/imports/new-jobs.json
```

## 浏览器原稿导出：每次调用一个阶段

遵守当前浏览器工具的初始化、授权和 API 说明。使用已有登录浏览器；先检查编辑页已加载的资源，确认编辑原稿和定位资源的路径。当前已验证的只读路径为 `/app/api/jobs/{id}/edit?mode=detailed` 与 `/app/api/jobs/{id}/edit/places?mode=detailed`。助手 API 密钥**不能**读取编辑原稿，不应为此反复换密钥或尝试绕过限制。

在浏览器工具的 Node REPL 中导入帮助模块，传入该工具提供的 `Tab` 对象：

```js
var { pathToFileURL } = await import('node:url');
var { captureNote } = await import(pathToFileURL('C:/Users/kai/Desktop/project/myweb/tools/notebrick_import/browser-export.mjs').href);
var result = await captureNote({
  tab: exportTab,
  jobId: selectedJob.id,
  sourceDirectory: importConfig.source,
});
console.log(result);
```

`result.complete` 为 false 时，下一次 REPL 调用对同一笔记继续。每次只处理一个资源阶段，建议 `timeout_ms: 180000`；不要把整门课放进一个长 REPL 调用。原稿大于约 20 万字符时，直接返回整段字符串会被截断；返回深层 JSON 对象又会产生 `[MaxDepth]`。帮助模块仅分段读取 DOM 文本，在 Node 中拼接和解析，逐段保存检查点。重连后从检查点继续；原稿首段改变时自动重置该资源的检查点，避免拼接不同版本。不要从 cookies、存储、内部状态或调试协议提取登录凭据。

导出结果写入私有原稿目录：

```text
<id>.json             原稿，含 blocks/read
<id>-places.json      PDF 中的块定位；含配图时需要
pdf/<id>.pdf          原始 PDF；含配图时需要
*.capture/            分段读取断点
```

只有正文没有配图的笔记不需要 PDF 或定位文件。原稿中的录像缺课、声音缺失或覆盖不足说明应保留，不能自行补造内容。

## PDF 与凭据

PDF 用于提取原有图示，不会作为整份 PDF 嵌入网页。使用当前浏览器已授权的下载方式，或在用户授权后用助手 API 下载。新建临时密钥需要本次用户明确授权；读取完成后立即撤销并核实。不要把密钥写进参数、源代码、检查点或 Git 文件。

下载器只发 GET 请求，不提交视频、不重新生成笔记。可以通过私密环境变量 `NOTEBRICK_API_KEY`，或用 `--key-stdin` 从已有授权进程的 stdin 传入密钥：

```powershell
python -m tools.notebrick_import download --config C:/Users/kai/Documents/Codex/imports/my-course/import.json --key-stdin
```

已有完整 PDF 会跳过。接口返回待生成、权限不足、额度不足或失败时应报告真实状态，不反复重试或重新提交视频。

## 转换、核对与发布

```powershell
python -m tools.notebrick_import status --config C:/Users/kai/Documents/Codex/imports/my-course/import.json
python -m tools.notebrick_import build --config C:/Users/kai/Documents/Codex/imports/my-course/import.json
python -m tools.notebrick_import apply --config C:/Users/kai/Documents/Codex/imports/my-course/import.json
```

`build` 只在私有目录生成 `staging/` 和 `build-report.json`：

- 使用 `sourceId` 去重。新笔记 ID 来自来源 ID，不会因为增加或重排课程而改变链接。
- 已导入笔记逐字节保留，包括用户编辑、更新日期和当前列表顺序。原稿后来有修改时，需要比较并合并，不能用再次导入覆盖网页编辑。
- 新笔记必须通过原稿文字片段、LaTeX、代码块、块数、配图数量和文件存在性核对。未知内容类型、缺图和截断会使构建失败。
- 图示与 PDF 定位、源文件关联，按笔记保存缓存。中断后可以继续；PDF 或原稿改变时会重新提取。
- 编辑器和目录使用同一套自动编号。说明框标签和 NoteBrick 的 group 小标题不加入章节编号，显示编号也不会混入保存的正文。

配图提取已用当前账号的标准排版课程验证。更换排版样式或遇到跨页、组合图时，agent 仍须抽查 `figure-review.json` 对应的图片，特别是电路、坐标轴和反馈回路是否完整。

`apply` 核对暂存内容和目标文件摘要后才写入仓库。构建期间有人编辑了目标文件，或来源清单、暂存内容发生改变时会拒绝应用；重新检查并构建即可。工具不会删除旧笔记，不自动提交或发布。

最后检查 Git diff、Hugo 构建、Notes 栏目入口，以及浏览器中的公式、编号、课程切换、编辑和草稿状态。按用户本次授权提交与 push，等待 GitHub Pages 部署成功并验证实际页面，再交付链接。新课程初次连接 GitHub 仍沿用网页现有的仓库授权流程，密钥不随导入迁移。
