# Baguette 模拟器

需要 macOS 15.0 或更新版本；旧系统会在启动随包二进制之前明确返回 UNSUPPORTED_OS。

[English](README.md)

显式选用的 Apple Silicon iOS 模拟器插件，随包带 Baguette 0.2.0。需要 Cindy 0.1.83+、完整 Xcode 和已安装的 iOS runtime，首次运行不下载依赖。打包时通过 binary-dependencies.json 从固定哈希的官方归档收集九个可移植 USDZ 模型；原生可执行文件仍保留在 Git，仅支持 macOS。

仅在用户明确选择 Baguette 时使用。先 environment、devices，复用适合的已登录设备，必要时 boot。App 仍由项目正常 Xcode 流程构建，再用 install_app、launch_app 安装和启动模拟器 .app。launch_app 默认打开当前 session 侧边栏；检查 viewer.previewOpened，不能把服务启动成功说成页面已显示。切换 session 后通过 open_viewer 打开已有设备。

控制页提供“恢复画面”（只重启画面服务）和“解除卡键”（只发送抬键）按钮，均不重启模拟器或 App。Agent 使用 press(button=release-input) 解除卡键。Unicode 粘贴会替换模拟器剪贴板；网页复制会替换 Mac 剪贴板。输入前观察焦点，之后核对结果；按键投递回调不代表 App 处理完成。

设备保存于 ~/Library/Application Support/BaguetteCindy/devices，截图在同级 screenshots。不会操作默认或 Cindy 内置设备，不自动抹除数据。同 bundle ID 覆盖安装通常保留 App 数据，但登录态仍由 App 数据迁移、退出登录和服务端有效期决定。并发 Agent 不要交错操作同一设备。

heal 会重启 SpringBoard 并关闭 App，必须先让用户接受影响；卡键先尝试按键释放。shutdown 关闭设备但保留数据，close_viewer 只停止画面服务。

## 自己控制设备

打开 **插件 → Baguette**，可查看独立设备的实际状态、启动或关闭设备、打开控制页，以及关闭全部 Baguette 设备。关闭 **允许运行模拟器** 时先保存禁止启动状态，再关闭设备和画面服务；关机失败会明确显示，开关关闭期间工具不能重新启动设备。重新打开开关不会自动开机。设备数据和登录信息保留。

预览顶部提供 **关闭设备** 和 **50%–200% 画面大小**。App 内双指缩放仍使用 Option 拖动或 Ctrl 滚轮，与画面大小分开。在基于 Chromium 的查看页（如 Cindy 预览）中，真实双指触摸也可缩放；输入法或软键盘提交的文字中，可打印 ASCII 按 US 布局按键输入（设备若使用其他硬件键盘布局可能错字；在查看页地址后加 `#cindyTextInput=paste` 可改为粘贴），其余文字仍走 Unicode 粘贴通道（Safari 行为不变）。默认闲置 15 分钟关闭，可改为 30 分钟、1 小时或仅手动。设备输入和实际工具操作续期，视频帧、状态轮询和只观看画面不续期。关机终止 App 和连接。全部独立设备共用闲置计时；修改闲置设置会重新计时。

侧栏预览还提供 **切换**、**添加设备** 和 **编辑名称**。添加时选择机型与兼容的已安装 iOS 版本；新设备保持关闭，切换到它才会启动。改名保留 App 和数据；换机型或系统版本会新建独立设备，保留原设备。切换会先确认旧设备已关闭，再启动目标设备，并在同一预览显示进度；若还有其它运行中的独立设备，需先关闭。

插件在 `runtime-settings.json.apps.json` 记录各设备最近一次由插件成功启动的 App。从运行中的设备切换时，可把该 App 的模拟器应用包安装到目标设备并打开；系统 App 按标识符打开。不复制 App 数据、登录信息或凭证。没有记录时显示目标设备主屏；原设备已经关闭时，目标设备需已安装记录中的 App。不兼容或启动失败会显示实际设备状态，不保证两台设备有相同内容和登录态。

运行偏好保存在独立设备目录旁的 `runtime-settings.json`，本机使用该设备集合的入口共享。Worker 正常退出时尝试关机，但被强制终止可能来不及完成。在 Cindy 中停用插件 **之前**，先用设置页的运行开关关闭设备，并检查显示状态。预览关闭或断线不证明设备已经关闭。

## 安全与限制

Node Worker 有当前用户级本机权限。只调用固定可执行文件和命令形状，不提供任意 Shell 工具。控制页仅监听 127.0.0.1；剪贴板与控制请求校验来源、随机能力令牌和已打开的独立设备。不会提取账户令牌或转存到 Cindy。截图分析可能把画面送给模型；App 内操作可能造成外部业务副作用，仍须遵守任务授权。

画面的可选 OpenStreetMap 地图请求通过固定端点的 Node 代理发送；farm 页面使用本机字体回退，不请求远程字体。详见 VENDOR-REVIEW.md；这些功能不涉及同步模拟器账户。不会后台安装依赖。

已知限制：iOS 27 上断开视频连接可能触发上游 SIGABRT。服务每分钟最多自动重启五次，独立控制页可手动恢复；这是缓解，不是原生崩溃根治。Worker 停用、退出或工具闲置一小时后控制页也会停止，需要 Cindy 再次启动。设备数据跨 session 保留，但浏览器标签属于当前 session。

## 构建与验证

原生 release 构建使用 Swift -Osize、移除符号并临时签名，确保 Git 中二进制总量符合仓库限制。

在装有 Xcode 的 Apple Silicon Mac 上运行 sh native/build.sh，编译随包 Objective-C 源码并临时签名，不下载依赖；Baguette 和 HingeControl 基于 v0.2.0 加上 vendor-native.patch 重新编译；运行 sh native/build-baguette.sh <已验证的源码压缩包> 可重建。补丁让屏幕枚举与折叠控制使用独立设备目录、读取设备内真实折叠角度，并让改名后的设备仍匹配原型号。

运行仓库契约和 .tests/baguette-simulator.test.mjs。审核 VENDOR-REVIEW.md、THIRD-PARTY-LICENSES.txt 和提案 #119：https://github.com/makecindy/cindy-official-plugins/issues/119。首发为空定向受众，不推送全体用户。最终包在合格 Cindy 客户端内的安装验证，必须与直接 Node/原生测试分开记录。

可选位置面板通过 Node Worker 向 OpenStreetMap 发送搜索词和地图瓦片请求，仅使用固定 HTTPS 端点 nominatim.openstreetmap.org 与 tile.openstreetmap.org。浏览器请求保持同源；拒绝重定向和任意上游 URL，不转发账号凭证。

画面代理的 HTTP 和 WebSocket 均要求令牌会话；控制页用片段中的令牌换取 HttpOnly 会话 Cookie。这不构成对同一 macOS 用户权限进程或直接访问上游 Baguette 监听端口的沙箱隔离。

## iPhone Duo 与 Xcode 兼容

普通设备保留 Xcode 26/27 路径。iPhone Duo 需要当前选用 Xcode 27.1，并已安装 iOS 27.1 runtime。上游预览页提供 Duo 3D 模型、内外屏、姿态按钮和折叠角度滑杆；切换姿态会改变模拟设备状态及前台 App 布局。模型直接读取 Xcode，不由插件下载。插件使用当前选定的 Xcode，不自动安装、切换或降级 Xcode。剪贴板写入优先使用 CoreDevice，旧环境或不支持时回退到独立设备集合的 simctl。

已在 Cindy 0.1.93 Beta / iOS 27.1 实测 Duo 预览、合拢/展开、触控和中文输入。Xcode 26 集成尚未复测，具体边界见 VERIFICATION.json。

设置无法读取时，仍可查看状态和关闭设备，但禁止启动和修改设置；恢复设置文件后才能恢复运行许可。切换设备自动安装源应用包时，可能替换目标上相同 bundleId 的已有 App；不会复制源 App 数据或登录凭证。
