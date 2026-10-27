# hinome_no_danmaku
火羽ひのめ的弹幕
[安装链接](https://github.com/NieR4ever/hinome_no_danmaku/raw/refs/heads/main/local-danmaku.user.js)

## 弹幕列表版
[安装链接](https://github.com/NieR4ever/hinome_no_danmaku/raw/refs/heads/main/local-danmaku-list.user.js)（`local-danmaku-list.user.js`，与上面的脚本相互独立，请勿同时安装）

B 站播放器公共 API 无法向原生弹幕列表写入数据，因此脚本会在原生弹幕列表容器内追加独立的「本地弹幕（非平台弹幕）」区块：每行带「本地」标记，按当前播放时间显示最近的最多 100 条，拖动进度、切换视频/分P、重新导入文件后会同步刷新。
- 本地弹幕不会出现在平台真实弹幕数据中，也不支持举报/点赞等原生操作。
- 若 B 站改版导致找不到弹幕列表容器，则只显示自绘覆盖层。

## 原生注入版
[安装链接](https://github.com/NieR4ever/hinome_no_danmaku/raw/refs/heads/main/local-danmaku-inject.user.js)（`local-danmaku-inject.user.js`，与上面的脚本相互独立，请勿同时安装）

拦截 B 站弹幕分段请求（`/x/v2/dm/(wbi/)web/seg.so`），把本地 XML 弹幕合并进响应，由 B 站原生系统负责渲染、弹幕列表、屏蔽、透明度等全部控制，脚本只负责导入。
- 导入/清除后会自动刷新页面以重新请求弹幕；导入内容保存在浏览器 IndexedDB，对之后打开的所有视频生效，需手动「清除」。
- B 站播放器的弹幕请求不在用户脚本当前可见的上下文中，因此脚本声明 MAIN/page 注入并包装 `Worker`、`SharedWorker`，把拦截代码带入 Worker；仅在导入过弹幕后启用。Worker 内拦截 `Response.prototype`（及 XHR），不依赖播放器是否缓存了原生 `fetch`；注入前会校验响应的 protobuf 结构，不符合预期时不改动响应。
- 依赖脚本管理器支持 MAIN/page 注入、B 站当前的分段接口与 protobuf 格式；改版后可能失效。更新脚本后需刷新页面；如果导入过弹幕仍未启用，请重新导入一次。按钮文字和悬停提示会显示状态，控制台 `[本地弹幕]` 日志用于诊断；Worker 注入可能影响使用相对路径导入其他脚本的 Worker。
