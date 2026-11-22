# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.9] - 2026-11-22

### Added

- 自定义文章工具栏：正文工具栏的按钮可以拖动排序、逐项显示或隐藏，并一键恢复默认；每个按钮还能选择「显示在工具栏 / 收进更多 / 隐藏」三种去向。
- 翻译与摘要三态指示：列表、悬浮预览和正文都会显示「翻译中 / 已完成 / 失败」状态；完成后再点徽标，可以看到实际使用的是哪个服务（提供商与模型）。

### Changed

- 手机端列表顶栏与网页版统一：刷新、未读切换、全部已读使用同一套图标与尺寸，「更多」菜单里不再重复放这三项。
- 底部标签栏改为两段式：点当前所在的标签回到顶部，再点一下切到该内容类型的「全部」。
- 手机状态栏底色跟随当前主题背景（浅色、石色、叶色、Nord 深色、深色）。

### Fixed

- 长按手机列表卡片不再弹出铺满屏幕的系统文字选择框；详情正文仍可正常选中复制。
- 翻译 / 摘要徽标显示真实服务：徽标使用你配置的提供商名称，模型兜底时不再重复拼接模型名；Google 翻译失败回退到有道时，徽标如实显示有道，不再误标为 Google。
- 修复开启翻译后正文排版被破坏的问题。
- 「更多」面板里强制刷新的图标与面板内其它图标尺寸统一。

[Unreleased]: https://github.com/kue02/Krss/compare/v1.1.9...HEAD
[1.1.9]: https://github.com/kue02/Krss/compare/v1.1.8...v1.1.9
