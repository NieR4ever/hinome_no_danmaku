# hinome_no_danmaku
火羽ひのめ的弹幕
[安装链接](https://github.com/NieR4ever/hinome_no_danmaku/raw/refs/heads/main/local-danmaku.user.js)

## 弹幕列表版
[安装链接](https://github.com/NieR4ever/hinome_no_danmaku/raw/refs/heads/main/local-danmaku-list.user.js)（`local-danmaku-list.user.js`，与上面的脚本相互独立，请勿同时安装）

B 站播放器公共 API 无法向原生弹幕列表写入数据，因此脚本会在原生弹幕列表容器内追加独立的「本地弹幕（非平台弹幕）」区块：每行带「本地」标记，按当前播放时间显示最近的最多 100 条，拖动进度、切换视频/分P、重新导入文件后会同步刷新。
- 本地弹幕不会出现在平台真实弹幕数据中，也不支持举报/点赞等原生操作。
- 若 B 站改版导致找不到弹幕列表容器，则只显示自绘覆盖层。
