import { defineConfig } from 'vitest/config';

// 项目源码是 IIFE + 全局变量（不是 ES module），通过 jsdom 环境运行后访问 window.* 全局
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    // 测试加载源文件需要 ?raw 拿到字符串后再 eval 注入到 jsdom window
    deps: {
      inline: [/\.raw$/]
    },
    // 测试超时：DOM 转换涉及 turndown 初始化，给宽松些
    testTimeout: 10000,
    // 文件命名：tests/**/*.test.js
    include: ['tests/**/*.test.js'],
    // 不收集 lib/ 下的源文件覆盖率（不是我们要测的对象）
    coverage: {
      provider: 'v8',
      include: ['lib/**', 'content/dom/**'],
      exclude: ['lib/*.min.js', 'lib/turndown-plugin-gfm.js']
    }
  }
});
