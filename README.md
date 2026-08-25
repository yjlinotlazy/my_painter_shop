# 我的配色小铺

用于在消耗实体画材前预演线稿配色的本地 Web 应用。

## 启动

需要 Python 3.10+ 和 Tesseract OCR。

```bash
python3 -m pip install -r requirements.txt
python3 server.py
```

浏览器打开 <http://127.0.0.1:7006>。

首次启动会创建 `~/.config/my_painter_shop/config.yaml`：

```yaml
paths:
  palette_import: /home/yli/Dropbox/Comics/PaintShop
  line_art_import: /home/yli/Dropbox/Comics/PaintShop
  finished_export: /home/yli/Dropbox/Comics/PaintShop
```

这三个值分别控制色卡、线稿的路径补全起点，以及完成图的默认导出目录。修改配置后刷新页面即可。

## 使用

1. 直接使用空白画布，或输入线稿路径，按 `Tab` 接受不区分大小写的补全结果后打开线稿。
2. 输入色卡照片路径并识别。检查 OCR 色号和取色结果，必要时直接修改。
3. 选择正方形、竖版或横版画布；画布默认完整显示，也可以手动缩放。
4. 选择色号并用鼠标或压感笔上色。
5. 从右侧替换某个色号的全部笔画，或按原图尺寸导出 PNG。

色卡照片受光线和白平衡影响，自动取色仅作为起点；结果始终可以手动纠正。

## 测试

```bash
python3 -m unittest discover -s tests
```
