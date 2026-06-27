// Self-check for the Prometheus metrics parser in lib/llama-status.mjs.
// Run: node scripts/check_llama_status.mjs   (exits non-zero on failure)
import assert from 'node:assert';
import { parseLlamaMetrics } from '../lib/llama-status.mjs';

// A representative slice of real llama.cpp /metrics output, comments included.
const sample = `# HELP llamacpp:prompt_tokens_total Number of prompt tokens processed.
# TYPE llamacpp:prompt_tokens_total counter
llamacpp:prompt_tokens_total 12345
# HELP llamacpp:tokens_predicted_total Number of generation tokens processed.
# TYPE llamacpp:tokens_predicted_total counter
llamacpp:tokens_predicted_total 6789
# HELP llamacpp:prompt_tokens_seconds Average prompt throughput in tokens/s.
# TYPE llamacpp:prompt_tokens_seconds gauge
llamacpp:prompt_tokens_seconds 208.333
# HELP llamacpp:predicted_tokens_seconds Average generation throughput in tokens/s.
# TYPE llamacpp:predicted_tokens_seconds gauge
llamacpp:predicted_tokens_seconds 34.4828
`;

const m = parseLlamaMetrics(sample);
assert.strictEqual(m.promptTokensTotal, 12345, 'promptTokensTotal');
assert.strictEqual(m.outputTokensTotal, 6789, 'outputTokensTotal');
assert.strictEqual(m.evalSpeed, 208.333, 'evalSpeed');
assert.strictEqual(m.genSpeed, 34.4828, 'genSpeed');

// Missing metrics must come back null, not throw or coerce to 0/NaN.
const empty = parseLlamaMetrics('# nothing here\n');
assert.strictEqual(empty.evalSpeed, null, 'missing metric -> null');

console.log('OK: parseLlamaMetrics handles real metrics + missing fields');
