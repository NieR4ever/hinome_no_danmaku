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

不拦截任何网络请求：脚本通过播放器自身的弹幕引擎（`window.player.danmaku.getDanmakuX()` 的 `addList`）把本地 XML 弹幕交给 B 站原生系统，由原生系统负责渲染、屏蔽、透明度、速度等全部控制，脚本只负责导入。
- 导入内容保存在浏览器 IndexedDB，对之后打开的所有视频生效；点「清除」会刷新页面。
- 每秒检查一次引擎，切换视频/分P 后引擎重建或清空时会自动补注入。
- 仅支持滚动/顶部/底部/逆向弹幕，高级弹幕（mode 7+）会跳过。
- 原生右侧「弹幕列表」的数据来自平台接口，本地弹幕不会出现在列表中，只在画面上由原生引擎渲染。
- 依赖播放器内部接口，B 站改版后可能失效，按钮文字会显示当前状态，控制台 `[本地弹幕]` 日志用于诊断。
