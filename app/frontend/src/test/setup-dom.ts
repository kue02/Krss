/**
 * Vitest 的 jsdom 补丁层。
 *
 * jsdom 没有实现 Web Animations API，而卡片/侧栏的涟漪（m3-ripple）在点击时会调
 * `element.animate(...)`，并在下一次点击时调 `.cancel()`。缺这一层的话，任何点进卡片或
 * 侧栏按钮的测试都会抛 unhandled error —— 测试用例本身全绿，但 vitest 以退出码 1 收场
 * （`Tests 577 passed / Errors 2`），等于把质量门做废了。
 *
 * 这里只补最小可用形状（animate + cancel/finish），不做动画模拟：测试断言的是行为，
 * 不是动画帧。
 */
if (typeof Element !== "undefined" && !Element.prototype.animate) {
  Element.prototype.animate = function animate() {
    return {
      cancel: () => {},
      finish: () => {},
      play: () => {},
      pause: () => {},
      reverse: () => {},
      commitStyles: () => {},
      persist: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      finished: Promise.resolve(),
      currentTime: 0,
      playState: "finished",
      onfinish: null,
      oncancel: null,
    } as unknown as Animation;
  };
}
