/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'

// vitest 配置：
// - 环境：node（默认环境；未来需 DOM 的测试可在文件顶部用 // @vitest-environment jsdom 覆盖）
// - include：仅 src 下的 *.test.ts / *.test.tsx
// - globals：注入 describe/it/expect 等，避免每个测试文件都 import
// 注意：本配置与 vite.config.ts 分离，避免影响构建配置。
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
