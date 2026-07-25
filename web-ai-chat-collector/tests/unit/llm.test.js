// tests/unit/llm.test.js
// lib/llm.js 测试：_buildOpenAIChatUrl / _buildThinkingExtras / AIAssistant._parseEmbId
//
// _buildThinkingExtras 是项目最复杂、最易出 bug 的函数（6 厂商 × 3 思考模式 × 2 开关）。
// 这些测试用例覆盖了 project_memory 中记录的全部厂商差异：
//   - DashScope/Qwen: enable_thinking 布尔值
//   - DeepSeek/智谱/Kimi: thinking 对象 {type:"enabled"/"disabled"}
//   - 豆包: thinking 对象 + fallbackThinking（Endpoint ID 匹配不上 modelMeta）
//   - MiniMax: thinking {type:"adaptive"/"disabled"} + reasoning_split:true

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { loadLlm } from '../helpers/load-source.js';

let LLMService, AIAssistant;

beforeAll(() => {
  const lib = loadLlm();
  LLMService = lib.LLMService;
  AIAssistant = lib.AIAssistant;
});

// models.json 厂商清单 fixture（覆盖项目所有 6 个 LLM 厂商）
const MODELS_CATALOG = {
  llmProviders: [
    {
      id: 'dashscope',
      backend: 'openai',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      supportsThinking: true,
      thinkingParam: 'enable_thinking',
      models: [
        { id: 'qwen3.6-flash', thinking: 'hybrid', thinkingDefault: true },
        { id: 'qwq-plus', thinking: 'only', thinkingDefault: true }
      ]
    },
    {
      id: 'deepseek',
      backend: 'openai',
      baseUrl: 'https://api.deepseek.com',
      supportsThinking: true,
      thinkingParam: 'thinking',
      models: [
        { id: 'deepseek-v4-flash', thinking: 'hybrid', thinkingDefault: true }
      ]
    },
    {
      id: 'zhipu',
      backend: 'openai',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      supportsThinking: true,
      thinkingParam: 'thinking',
      models: [
        { id: 'glm-5.2', thinking: 'hybrid', thinkingDefault: true }
      ]
    },
    {
      id: 'moonshot',
      backend: 'openai',
      baseUrl: 'https://api.moonshot.cn/v1',
      supportsThinking: true,
      thinkingParam: 'thinking',
      thinkingEnabledType: 'enabled',
      thinkingTemperature: 1.0,
      nonThinkingTemperature: 0.6,
      models: [
        { id: 'kimi-k2.6', thinking: 'hybrid', thinkingDefault: true }
      ]
    },
    {
      id: 'doubao',
      backend: 'openai',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      supportsThinking: true,
      thinkingParam: 'thinking',
      fallbackThinking: 'hybrid',
      models: [
        { id: 'doubao-seed-2-1-pro-260628', thinking: 'hybrid', thinkingDefault: true }
      ]
    },
    {
      id: 'minimax',
      backend: 'openai',
      baseUrl: 'https://api.minimaxi.com',
      supportsThinking: true,
      thinkingParam: 'thinking',
      thinkingEnabledType: 'adaptive',
      reasoningSplit: true,
      models: [
        { id: 'MiniMax-M3', thinking: 'hybrid', thinkingDefault: true },
        { id: 'MiniMax-M2.7', thinking: 'only', thinkingDefault: true }
      ]
    },
    // 不支持思考的厂商（用于测试 supportsThinking=false 分支）
    {
      id: 'custom-no-thinking',
      backend: 'openai',
      baseUrl: 'https://custom.example.com/v1',
      supportsThinking: false,
      models: [
        { id: 'custom-model', thinking: 'none' }
      ]
    }
  ]
};

beforeEach(() => {
  LLMService._modelsCatalog = MODELS_CATALOG;
  LLMService._config = {};
});

// =================================================================
// _buildOpenAIChatUrl：根据 baseUrl 智能拼接 /chat/completions
// =================================================================
describe('_buildOpenAIChatUrl', () => {
  it('已含 /v1 前缀：直接拼 /chat/completions', () => {
    expect(LLMService._buildOpenAIChatUrl('https://api.openai.com/v1'))
      .toBe('https://api.openai.com/v1/chat/completions');
  });

  it('已含 /v4 前缀：直接拼 /chat/completions', () => {
    expect(LLMService._buildOpenAIChatUrl('https://open.bigmodel.cn/api/paas/v4'))
      .toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
  });

  it('已含 /v2 前缀：直接拼 /chat/completions', () => {
    expect(LLMService._buildOpenAIChatUrl('https://qianfan.baidubce.com/v2'))
      .toBe('https://qianfan.baidubce.com/v2/chat/completions');
  });

  it('不含版本前缀：补 /v1', () => {
    expect(LLMService._buildOpenAIChatUrl('https://api.deepseek.com'))
      .toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('MiniMax baseUrl 无版本前缀：补 /v1', () => {
    expect(LLMService._buildOpenAIChatUrl('https://api.minimaxi.com'))
      .toBe('https://api.minimaxi.com/v1/chat/completions');
  });

  it('末尾有斜杠：先剥掉再拼接', () => {
    expect(LLMService._buildOpenAIChatUrl('https://api.openai.com/v1/'))
      .toBe('https://api.openai.com/v1/chat/completions');
    expect(LLMService._buildOpenAIChatUrl('https://api.deepseek.com/'))
      .toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('多个末尾斜杠：全部剥掉', () => {
    expect(LLMService._buildOpenAIChatUrl('https://api.openai.com/v1///'))
      .toBe('https://api.openai.com/v1/chat/completions');
  });

  it('空字符串：用默认 https://api.openai.com', () => {
    expect(LLMService._buildOpenAIChatUrl(''))
      .toBe('https://api.openai.com/v1/chat/completions');
  });

  it('null：用默认 baseUrl', () => {
    expect(LLMService._buildOpenAIChatUrl(null))
      .toBe('https://api.openai.com/v1/chat/completions');
  });
});

// =================================================================
// _buildThinkingExtras：思考参数注入（最复杂、最易出 bug）
// =================================================================
describe('_buildThinkingExtras', () => {
  // ---- DashScope / Qwen：enable_thinking 布尔值 ----
  describe('DashScope (enable_thinking 布尔值)', () => {
    beforeEach(() => {
      LLMService._config = { provider: 'dashscope', model: 'qwen3.6-flash' };
    });

    it('hybrid 模型 + 开启思考 → { enable_thinking: true }', () => {
      const extras = LLMService._buildThinkingExtras({ enableThinking: true });
      expect(extras).toEqual({ enable_thinking: true });
    });

    it('hybrid 模型 + 关闭思考 → { enable_thinking: false }（必须显式 false）', () => {
      const extras = LLMService._buildThinkingExtras({ enableThinking: false });
      expect(extras).toEqual({ enable_thinking: false });
    });

    it('only 模型（QwQ-Plus）+ 开启思考 → { enable_thinking: true }', () => {
      LLMService._config.model = 'qwq-plus';
      const extras = LLMService._buildThinkingExtras({ enableThinking: true });
      expect(extras).toEqual({ enable_thinking: true });
    });

    it('only 模型 + 关闭思考 → 强制开启 { enable_thinking: true }', () => {
      LLMService._config.model = 'qwq-plus';
      const extras = LLMService._buildThinkingExtras({ enableThinking: false });
      expect(extras).toEqual({ enable_thinking: true });
    });
  });

  // ---- DeepSeek / 智谱 / Kimi：thinking 对象 {type:"enabled"/"disabled"} ----
  describe('DeepSeek (thinking 对象 enabled/disabled)', () => {
    beforeEach(() => {
      LLMService._config = { provider: 'deepseek', model: 'deepseek-v4-flash' };
    });

    it('hybrid 模型 + 开启 → { thinking: { type: "enabled" } }', () => {
      const extras = LLMService._buildThinkingExtras({ enableThinking: true });
      expect(extras).toEqual({ thinking: { type: 'enabled' } });
    });

    it('hybrid 模型 + 关闭 → { thinking: { type: "disabled" } }', () => {
      const extras = LLMService._buildThinkingExtras({ enableThinking: false });
      expect(extras).toEqual({ thinking: { type: 'disabled' } });
    });
  });

  describe('智谱 GLM (thinking 对象 enabled/disabled)', () => {
    beforeEach(() => {
      LLMService._config = { provider: 'zhipu', model: 'glm-5.2' };
    });

    it('hybrid + 开启 → { thinking: { type: "enabled" } }', () => {
      const extras = LLMService._buildThinkingExtras({ enableThinking: true });
      expect(extras).toEqual({ thinking: { type: 'enabled' } });
    });

    it('hybrid + 关闭 → { thinking: { type: "disabled" } }', () => {
      const extras = LLMService._buildThinkingExtras({ enableThinking: false });
      expect(extras).toEqual({ thinking: { type: 'disabled' } });
    });
  });

  describe('Kimi (thinking 对象 enabled/disabled)', () => {
    beforeEach(() => {
      LLMService._config = { provider: 'moonshot', model: 'kimi-k2.6' };
    });

    it('hybrid + 开启 → { thinking: { type: "enabled" } }（thinkingEnabledType="enabled"）', () => {
      const extras = LLMService._buildThinkingExtras({ enableThinking: true });
      expect(extras).toEqual({ thinking: { type: 'enabled' } });
    });

    it('hybrid + 关闭 → { thinking: { type: "disabled" } }', () => {
      const extras = LLMService._buildThinkingExtras({ enableThinking: false });
      expect(extras).toEqual({ thinking: { type: 'disabled' } });
    });
  });

  // ---- 豆包：fallbackThinking 处理 Endpoint ID ----
  describe('豆包 (fallbackThinking 处理 Endpoint ID)', () => {
    beforeEach(() => {
      LLMService._config = { provider: 'doubao', model: 'ep-20250101xxxxx' };
    });

    it('Endpoint ID 匹配不上 modelMeta + 开启 → 用 fallbackThinking=hybrid，输出 enabled', () => {
      const extras = LLMService._buildThinkingExtras({ enableThinking: true });
      expect(extras).toEqual({ thinking: { type: 'enabled' } });
    });

    it('Endpoint ID 匹配不上 modelMeta + 关闭 → 输出 disabled', () => {
      const extras = LLMService._buildThinkingExtras({ enableThinking: false });
      expect(extras).toEqual({ thinking: { type: 'disabled' } });
    });

    it('用 models.json 中的标准 model id 时正常工作', () => {
      LLMService._config.model = 'doubao-seed-2-1-pro-260628';
      const extras = LLMService._buildThinkingExtras({ enableThinking: true });
      expect(extras).toEqual({ thinking: { type: 'enabled' } });
    });
  });

  // ---- MiniMax：adaptive + reasoning_split ----
  describe('MiniMax (adaptive + reasoning_split)', () => {
    beforeEach(() => {
      LLMService._config = { provider: 'minimax', model: 'MiniMax-M3' };
    });

    it('hybrid (M3) + 开启 → { thinking:{type:"adaptive"}, reasoning_split:true }', () => {
      const extras = LLMService._buildThinkingExtras({ enableThinking: true });
      expect(extras).toEqual({
        thinking: { type: 'adaptive' },
        reasoning_split: true
      });
    });

    it('hybrid (M3) + 关闭 → { thinking:{type:"disabled"}, reasoning_split:true }', () => {
      const extras = LLMService._buildThinkingExtras({ enableThinking: false });
      expect(extras).toEqual({
        thinking: { type: 'disabled' },
        reasoning_split: true
      });
    });

    it('only (M2.7) + 开启 → 强制 adaptive + reasoning_split', () => {
      LLMService._config.model = 'MiniMax-M2.7';
      const extras = LLMService._buildThinkingExtras({ enableThinking: true });
      expect(extras).toEqual({
        thinking: { type: 'adaptive' },
        reasoning_split: true
      });
    });

    it('only (M2.7) + 关闭 → 强制开启 adaptive（only 模式无法关闭）', () => {
      LLMService._config.model = 'MiniMax-M2.7';
      const extras = LLMService._buildThinkingExtras({ enableThinking: false });
      expect(extras).toEqual({
        thinking: { type: 'adaptive' },
        reasoning_split: true
      });
    });
  });

  // ---- 边界情况 ----
  describe('边界情况', () => {
    it('provider 不支持思考（supportsThinking=false）→ 返回 null', () => {
      LLMService._config = { provider: 'custom-no-thinking', model: 'custom-model' };
      expect(LLMService._buildThinkingExtras({ enableThinking: true })).toBeNull();
      expect(LLMService._buildThinkingExtras({ enableThinking: false })).toBeNull();
    });

    it('_modelsCatalog 为空 → 返回 null', () => {
      LLMService._modelsCatalog = null;
      LLMService._config = { provider: 'dashscope', model: 'qwen3.6-flash' };
      expect(LLMService._buildThinkingExtras({ enableThinking: true })).toBeNull();
    });

    it('未识别 provider 且 baseUrl 匹配不上 → 返回 null', () => {
      LLMService._config = {
        provider: 'unknown-provider',
        baseUrl: 'https://unknown.example.com',
        model: 'unknown-model'
      };
      expect(LLMService._buildThinkingExtras({ enableThinking: true })).toBeNull();
    });

    it('通过 baseUrl 反向匹配厂商（provider 未指定）', () => {
      LLMService._config = {
        provider: undefined,
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash'
      };
      const extras = LLMService._buildThinkingExtras({ enableThinking: true });
      expect(extras).toEqual({ thinking: { type: 'enabled' } });
    });

    it('options.enableThinking 未传时用 config.enableThinking', () => {
      LLMService._config = { provider: 'dashscope', model: 'qwen3.6-flash', enableThinking: true };
      expect(LLMService._buildThinkingExtras({})).toEqual({ enable_thinking: true });

      LLMService._config.enableThinking = false;
      expect(LLMService._buildThinkingExtras({})).toEqual({ enable_thinking: false });
    });

    it('config.enableThinking 未设置时默认开启', () => {
      LLMService._config = { provider: 'dashscope', model: 'qwen3.6-flash' };
      expect(LLMService._buildThinkingExtras({})).toEqual({ enable_thinking: true });
    });

    it('options.enableThinking 优先级高于 config.enableThinking', () => {
      LLMService._config = { provider: 'dashscope', model: 'qwen3.6-flash', enableThinking: false };
      // options 显式覆盖
      expect(LLMService._buildThinkingExtras({ enableThinking: true }))
        .toEqual({ enable_thinking: true });
    });
  });
});

// =================================================================
// AIAssistant._parseEmbId：解析 chunk ID
// =================================================================
describe('AIAssistant._parseEmbId', () => {
  it('合法 ID 正确解析', () => {
    expect(AIAssistant._parseEmbId('deepseek::msg::abc123::chunk::0'))
      .toEqual({ msgHash: 'abc123', chunkIdx: 0 });
  });

  it('chunkIdx 为多位数字', () => {
    expect(AIAssistant._parseEmbId('kimi::msg::xyz::chunk::99'))
      .toEqual({ msgHash: 'xyz', chunkIdx: 99 });
  });

  it('convId 中含 - 也能正确解析（hash 取第 3 段）', () => {
    // convId = 'deepseek-abc'，被 :: 分隔后 parts[0]='deepseek-abc'
    expect(AIAssistant._parseEmbId('deepseek-abc::msg::hash::chunk::1'))
      .toEqual({ msgHash: 'hash', chunkIdx: 1 });
  });

  it('parts 长度不足 5 → 返回 null', () => {
    expect(AIAssistant._parseEmbId('a::b::c')).toBeNull();
    expect(AIAssistant._parseEmbId('a::b::c::d')).toBeNull();
  });

  it('parts[1] !== "msg" → 返回 null', () => {
    expect(AIAssistant._parseEmbId('conv::notmsg::hash::chunk::0')).toBeNull();
  });

  it('parts[3] !== "chunk" → 返回 null', () => {
    expect(AIAssistant._parseEmbId('conv::msg::hash::notchunk::0')).toBeNull();
  });

  it('chunkIdx 非数字 → 返回 -1', () => {
    expect(AIAssistant._parseEmbId('conv::msg::hash::chunk::abc'))
      .toEqual({ msgHash: 'hash', chunkIdx: -1 });
  });

  it('非字符串输入 → 返回 null', () => {
    expect(AIAssistant._parseEmbId(null)).toBeNull();
    expect(AIAssistant._parseEmbId(undefined)).toBeNull();
    expect(AIAssistant._parseEmbId(123)).toBeNull();
    expect(AIAssistant._parseEmbId({})).toBeNull();
  });

  it('空字符串 → 返回 null', () => {
    expect(AIAssistant._parseEmbId('')).toBeNull();
  });

  it('实际项目使用的 chunk ID 格式都能解析', () => {
    const ids = [
      'deepseek::msg::a1b2c3::chunk::0',
      'kimi::msg::d4e5f6::chunk::3',
      'qianwen::msg::g7h8i9::chunk::10',
      'doubao::msg::j0k1l2::chunk::0'
    ];
    for (const id of ids) {
      const result = AIAssistant._parseEmbId(id);
      expect(result).not.toBeNull();
      expect(result).toHaveProperty('msgHash');
      expect(result).toHaveProperty('chunkIdx');
      expect(result.chunkIdx).toBeGreaterThanOrEqual(0);
    }
  });
});
